package pl.slava.kopernikadr.camera.spool

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import pl.slava.kopernikadr.camera.camera.CameraCaptureException
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
 * `play` are generated in the background, one frame at a time ([DerivedFiles.prefetch]).
 *
 * The admission mutex stays held from admission until the still's `takePicture` has returned, so
 * a control change (which takes the same mutex) can neither start between the settling check and
 * the still nor while the still is being taken. A capture that finds another one running answers
 * `CAPTURE_IN_PROGRESS` without waiting for the mutex.
 *
 * The `pending` insert and the worker launch are one non-cancellable step: once the row exists a
 * worker owns it, even if the caller is cancelled right then; a worker whose [scope] is already
 * cancelled still runs far enough to mark the row `failed(INTERRUPTED)`.
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
    private val takePictureTimeoutMs: Long = TAKE_PICTURE_TIMEOUT_MS,
) : CaptureService {
    private data class Key(val clientId: String, val reqId: String)

    private val running = ConcurrentHashMap<Key, Deferred<PortResult<FrameInfo>>>()

    @Volatile
    private var current: Deferred<PortResult<FrameInfo>>? = null

    /** Frames whose display caches the background worker generates, in commit order. */
    private val toDerive = Channel<String>(Channel.UNLIMITED)

    init {
        scope.launch(io) {
            for (frameId in toDerive) {
                derived.prefetch(frameId, FrameVariant.THUMB)
                derived.prefetch(frameId, FrameVariant.PLAY)
            }
        }
    }

    /** True while a capture is between admission and its result (reject rotation changes then). */
    val isCapturing: Boolean get() = current?.isActive == true

    override suspend fun capture(clientId: String, reqId: String, args: CaptureArgs): PortResult<FrameInfo> {
        if (args.rotation != 0 && args.rotation != 180) {
            return err(ProtocolError.invalidArgs("rotation must be 0 or 180, got ${args.rotation}"))
        }
        val key = Key(clientId, reqId)
        // First without the mutex: a running capture holds it through its takePicture.
        when (val early = dedup(key, args, locked = false)) {
            is Admit.Done -> return early.result
            is Admit.Join -> return early.work.await()
            Admit.Proceed -> if (isCapturing) return inProgress()
        }
        admission.lock()
        val permit = AdmissionPermit(admission)
        var work: Deferred<PortResult<FrameInfo>>? = null
        try {
            when (val found = dedup(key, args, locked = true)) {
                is Admit.Done -> return found.result
                is Admit.Join -> {
                    permit.release()
                    return found.work.await()
                }
                Admit.Proceed -> Unit
            }
            if (isCapturing) return inProgress()
            admissionCheck(clientId, args)?.let { return err(it) }
            work = withContext(NonCancellable) { start(key, args, permit) }
        } finally {
            if (work == null) permit.release()
        }
        return work.await()
    }

    override fun getOperation(clientId: String, reqId: String): OperationState = spool.getOperation(clientId, reqId)

    private sealed interface Admit {
        data class Done(val result: PortResult<FrameInfo>) : Admit
        data class Join(val work: Deferred<PortResult<FrameInfo>>) : Admit
        data object Proceed : Admit
    }

    /** Dedup by `(clientId, reqId)`. A `pending` row nobody runs is failed only under the mutex. */
    private suspend fun dedup(key: Key, args: CaptureArgs, locked: Boolean): Admit =
        when (val found = withContext(io) { spool.lookup(key.clientId, key.reqId, argsHash(args)) }) {
            is SpoolLookup.Committed -> Admit.Done(PortResult.Ok(found.info))
            is SpoolLookup.Failed -> Admit.Done(err(ProtocolError(found.code, found.message)))
            SpoolLookup.Reused -> Admit.Done(err(ProtocolError(ErrorCodes.REQ_ID_REUSED, "reqId ${key.reqId} was used with other args")))
            is SpoolLookup.Pending -> {
                val work = running[key]
                when {
                    work != null -> Admit.Join(work)
                    // Without the mutex the row may be between its insert and its worker's registration.
                    !locked -> Admit.Proceed
                    else -> {
                        // Left by a dead process; an interrupted operation is never re-executed.
                        val msg = "interrupted by an app restart"
                        withContext(io) { spool.fail(found.frameId, ErrorCodes.INTERRUPTED, msg) }
                        Admit.Done(err(ProtocolError(ErrorCodes.INTERRUPTED, msg, retryable = false)))
                    }
                }
            }
            SpoolLookup.None -> Admit.Proceed
        }

    /**
     * Inserts the `pending` row and launches its worker; call it non-cancellable. The worker takes
     * over [permit] and releases it once `takePicture` has returned.
     */
    private suspend fun start(key: Key, args: CaptureArgs, permit: AdmissionPermit): Deferred<PortResult<FrameInfo>> {
        val pending = withContext(io) { spool.insertPending(key.clientId, key.reqId, argsHash(args), args.projectId, args.rotation) }
        val d = try {
            // ATOMIC: the body starts even if [scope] is already cancelled, and fails the row.
            scope.async(io, start = CoroutineStart.ATOMIC) { run(pending, args, permit) }
        } catch (e: Throwable) {
            withContext(io) { failQuietly(pending, ErrorCodes.INTERRUPTED, "capture could not start: $e") }
            throw e
        }
        running[key] = d
        current = d
        d.invokeOnCompletion {
            running.remove(key, d)
            permit.release()
        }
        return d
    }

    private suspend fun run(p: PendingFrame, args: CaptureArgs, permit: AdmissionPermit): PortResult<FrameInfo> {
        val fullFile = spool.file(p.frameId, FrameVariant.FULL)
        try {
            val t0 = System.nanoTime()
            val still = try {
                currentCoroutineContext().ensureActive()
                // A camera that never calls back would otherwise hold the admission mutex forever.
                withTimeoutOrNull(takePictureTimeoutMs) { camera.takePicture() }
                    ?: throw CameraCaptureException(-1, "takePicture timed out after $takePictureTimeoutMs ms")
            } finally {
                permit.release()
            }
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
            // Unlimited: fails only once [scope] is gone; requests then generate on demand.
            toDerive.trySend(p.frameId)
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

    private fun inProgress() = err(ProtocolError(ErrorCodes.CAPTURE_IN_PROGRESS, "another capture is running"))

    private fun ms(a: Long, b: Long) = String.format(java.util.Locale.ROOT, "%.1f", (b - a) / 1_000_000.0)

    /** The held [admission] mutex, released exactly once by whoever is done with it first. */
    private class AdmissionPermit(private val mutex: Mutex) {
        private val released = AtomicBoolean(false)

        fun release() {
            if (released.compareAndSet(false, true)) mutex.unlock()
        }
    }

    companion object {
        /** Generous: a dark scene alone took ~0.8 s on the g05. */
        const val TAKE_PICTURE_TIMEOUT_MS = 15_000L
        private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

        /** Dedup key of the args: same reqId with another hash → `REQ_ID_REUSED`. */
        fun argsHash(args: CaptureArgs): String =
            DurableFiles.sha256("capture\u0000${args.projectId}\u0000${args.rotation}".toByteArray())
    }
}
