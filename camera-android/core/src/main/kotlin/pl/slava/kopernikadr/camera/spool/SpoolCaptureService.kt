package pl.slava.kopernikadr.camera.spool

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import pl.slava.kopernikadr.camera.camera.CameraNotReadyException
import pl.slava.kopernikadr.camera.camera.CameraPort
import pl.slava.kopernikadr.camera.image.StillPipeline
import pl.slava.kopernikadr.camera.protocol.CaptureArgs
import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.ExposureInfo
import pl.slava.kopernikadr.camera.protocol.FrameInfo
import pl.slava.kopernikadr.camera.protocol.OperationState
import pl.slava.kopernikadr.camera.protocol.ProtocolError
import pl.slava.kopernikadr.camera.server.CaptureService
import pl.slava.kopernikadr.camera.server.FrameVariant
import pl.slava.kopernikadr.camera.server.PortResult

/**
 * `capture` over the camera and the spool (ARCHITECTURE §4.5, PROTOCOL §6).
 *
 * Admission runs under [admission] (share it with `setControl`): dedup lookup → single flight →
 * rotation 0|180 → [admissionCheck] (GEOMETRY_MISMATCH / CAMERA_NOT_READY / STORAGE_LOW live
 * there) → durable `pending` row. The work (takePicture → [StillPipeline] → durable `full` →
 * `committed`) then runs in [scope], so a caller that goes away does not abort it; a second
 * caller with the same `(clientId, reqId)` awaits the same result. After the commit `thumb` and
 * `play` are generated in the background (best-effort).
 */
class SpoolCaptureService(
    private val camera: CameraPort,
    private val pipeline: StillPipeline,
    private val spool: Spool,
    private val files: DurableFiles,
    private val derived: DerivedFiles,
    /** Runs captures and cache generation; cancel it on shutdown (running captures fail INTERRUPTED). */
    private val scope: CoroutineScope,
    /** Shared with `setControl` (§4.5: one admission mutex). */
    val admission: Mutex = Mutex(),
    /** Extra admission checks after dedup / single flight / rotation; non-null rejects the capture. */
    private val admissionCheck: suspend (clientId: String, args: CaptureArgs) -> ProtocolError? = { _, _ -> null },
    private val clock: () -> Long = System::currentTimeMillis,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val log: (String) -> Unit = {},
) : CaptureService {
    private data class Key(val clientId: String, val reqId: String)

    private val running = ConcurrentHashMap<Key, Deferred<PortResult<FrameInfo>>>()

    @Volatile
    private var current: Deferred<PortResult<FrameInfo>>? = null

    /** True while a capture is between admission and its result (reject rotation changes then). */
    val isCapturing: Boolean get() = current?.isActive == true

    override suspend fun capture(clientId: String, reqId: String, args: CaptureArgs): PortResult<FrameInfo> {
        if (args.rotation != 0 && args.rotation != 180) {
            return err(ProtocolError.invalidArgs("rotation must be 0 or 180, got ${args.rotation}"))
        }
        val key = Key(clientId, reqId)
        val work = admission.withLock {
            when (val found = withContext(io) { spool.lookup(clientId, reqId, argsHash(args)) }) {
                is SpoolLookup.Committed -> return PortResult.Ok(found.info)
                is SpoolLookup.Failed -> return err(ProtocolError(found.code, found.message))
                SpoolLookup.Reused -> return err(ProtocolError(ErrorCodes.REQ_ID_REUSED, "reqId $reqId was used with other args"))
                is SpoolLookup.Pending -> {
                    running[key]?.let { return@withLock it }
                    // Left by a dead process; an interrupted operation is never re-executed.
                    withContext(io) { spool.fail(found.frameId, ErrorCodes.INTERRUPTED, "interrupted by an app restart") }
                    return err(ProtocolError(ErrorCodes.INTERRUPTED, "interrupted by an app restart", retryable = false))
                }
                SpoolLookup.None -> Unit
            }
            if (isCapturing) return err(ProtocolError(ErrorCodes.CAPTURE_IN_PROGRESS, "another capture is running"))
            admissionCheck(clientId, args)?.let { return err(it) }

            val pending = withContext(io) { spool.insertPending(clientId, reqId, argsHash(args), args.projectId, args.rotation) }
            val d = scope.async(io, start = CoroutineStart.LAZY) { run(pending, args) }
            running[key] = d
            current = d
            d.invokeOnCompletion { running.remove(key, d) }
            d.start()
            d
        }
        return work.await()
    }

    override fun getOperation(clientId: String, reqId: String): OperationState = spool.getOperation(clientId, reqId)

    private suspend fun run(p: PendingFrame, args: CaptureArgs): PortResult<FrameInfo> {
        val fullFile = spool.file(p.frameId, FrameVariant.FULL)
        try {
            val t0 = System.nanoTime()
            val still = camera.takePicture()
            val capturedAt = ISO.format(Instant.ofEpochMilli(clock()))
            val t1 = System.nanoTime()
            val full = pipeline.processStill(still, args.rotation)
            val t2 = System.nanoTime()
            files.writeAtomic(spool.dir, fullFile.name, full.jpeg)
            val t3 = System.nanoTime()
            val r = still.result
            val exposure = if (r?.iso != null && r.exposureTimeNs != null) ExposureInfo(r.iso, r.exposureTimeNs) else null
            val info = spool.commit(
                p.frameId,
                CommitMeta(full.size.width, full.size.height, full.jpeg.size.toLong(), DurableFiles.sha256(full.jpeg), capturedAt, exposure),
            )
            val t4 = System.nanoTime()
            log(
                "capture ${p.frameId} seq=${p.seq} ${full.size} ${full.jpeg.size}B rot=${args.rotation}: " +
                    "takePicture=${ms(t0, t1)} ${still.timings} pipeline=${ms(t1, t2)} ${full.timings} " +
                    "write=${ms(t2, t3)} commit=${ms(t3, t4)} total=${ms(t0, t4)} ms",
            )
            scope.launch(io) {
                try {
                    derived.ensure(p.frameId, FrameVariant.THUMB)
                    derived.ensure(p.frameId, FrameVariant.PLAY)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    log("derive ${p.frameId} failed: $e")
                }
            }
            return PortResult.Ok(info)
        } catch (e: CancellationException) {
            withContext(NonCancellable) { failQuietly(p, ErrorCodes.INTERRUPTED, "capture cancelled") }
            fullFile.delete()
            throw e
        } catch (e: CameraNotReadyException) {
            val msg = e.message ?: "camera not ready"
            failQuietly(p, ErrorCodes.CAMERA_NOT_READY, msg)
            return err(ProtocolError(ErrorCodes.CAMERA_NOT_READY, msg))
        } catch (e: Throwable) {
            val msg = e.toString()
            log("capture ${p.frameId} failed: $msg")
            failQuietly(p, ErrorCodes.CAPTURE_FAILED, msg)
            fullFile.delete()
            return err(ProtocolError(ErrorCodes.CAPTURE_FAILED, msg))
        }
    }

    private fun failQuietly(p: PendingFrame, code: String, msg: String) {
        try {
            spool.fail(p.frameId, code, msg)
        } catch (e: Throwable) {
            log("spool.fail ${p.frameId} failed: $e")
        }
    }

    private fun err(e: ProtocolError) = PortResult.Err(e)

    private fun ms(a: Long, b: Long) = String.format(java.util.Locale.ROOT, "%.1f", (b - a) / 1_000_000.0)

    companion object {
        private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

        /** Dedup key of the args: same reqId with another hash → `REQ_ID_REUSED`. */
        fun argsHash(args: CaptureArgs): String =
            DurableFiles.sha256("capture\u0000${args.projectId}\u0000${args.rotation}".toByteArray())
    }
}
