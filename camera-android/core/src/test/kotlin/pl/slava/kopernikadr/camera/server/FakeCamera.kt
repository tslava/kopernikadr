package pl.slava.kopernikadr.camera.server

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeout
import pl.slava.kopernikadr.camera.core.UlidGenerator
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.CaptureArgs
import pl.slava.kopernikadr.camera.protocol.CompensationCapability
import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.DerivedImages
import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.ExposureCapability
import pl.slava.kopernikadr.camera.protocol.ExposureControl
import pl.slava.kopernikadr.camera.protocol.ExposureLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusCapability
import pl.slava.kopernikadr.camera.protocol.FocusControl
import pl.slava.kopernikadr.camera.protocol.FocusLockCapability
import pl.slava.kopernikadr.camera.protocol.FocusLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.FrameInfo
import pl.slava.kopernikadr.camera.protocol.FullImage
import pl.slava.kopernikadr.camera.protocol.OperationError
import pl.slava.kopernikadr.camera.protocol.OperationState
import pl.slava.kopernikadr.camera.protocol.PreviewLocks
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.ProtocolError
import pl.slava.kopernikadr.camera.protocol.Rational
import pl.slava.kopernikadr.camera.protocol.Size
import pl.slava.kopernikadr.camera.protocol.Sizes
import pl.slava.kopernikadr.camera.protocol.Status
import pl.slava.kopernikadr.camera.protocol.Thermal
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceCapability
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceControl
import java.time.Instant

// In-memory fakes of every server port. No Android, no files: JPEGs are fake byte arrays.

class FakeIdentity(
    override val cameraId: String = "3f2b8c1e-7d4a-4e9b-a6c2-58d1f0e9b734",
    override val bootId: String = UUID.randomUUID().toString(),
    override val name: String = "Fake g05",
) : IdentityPort {
    override fun capabilities(): Capabilities = CAPABILITIES

    companion object {
        val CAPABILITIES = Capabilities(
            aspect = "4:3",
            sizes = Sizes(Size(4000, 3000), Size(1440, 1080), Size(256, 192)),
            rotations = listOf(0, 180),
            exposure = ExposureCapability(
                lock = true,
                method = ExposureLockMethod.FREEZE,
                compensation = CompensationCapability(true, -4, 4, Rational(1, 2)),
            ),
            whiteBalance = WhiteBalanceCapability(true, null),
            focusLock = FocusLockCapability(FocusLockMethod.FREEZE),
            focus = FocusCapability(listOf(FocusMode.AUTO, FocusMode.LOCKED), 10.0),
            previewQualities = PreviewQuality.entries,
        )
    }
}

class FakeStatus(var value: Status = DEFAULT) : StatusPort {
    override fun status(): Status = value

    companion object {
        val DEFAULT = Status(81, true, 41_234_567_890, 312_345_678, 0, 0, 0, Thermal.NONE)
    }
}

class FakeControls(initial: Controls = DEFAULT) : ControlsPort {
    private val state = MutableStateFlow(initial)
    override val updates: Flow<Controls> get() = state

    override fun get(): Controls = state.value

    override suspend fun set(change: ControlChange): PortResult<Controls> {
        val c = state.value
        val next = when (change) {
            is ControlChange.Exposure -> c.copy(exposure = c.exposure.copy(mode = change.mode))
            is ControlChange.ExposureCompensation ->
                if (change.steps !in -4..4) return invalid("steps out of range")
                else c.copy(exposure = c.exposure.copy(compensationSteps = change.steps))
            is ControlChange.WhiteBalance -> c.copy(whiteBalance = c.whiteBalance.copy(mode = change.mode))
            is ControlChange.Focus -> c.copy(focus = c.focus.copy(mode = change.mode))
            is ControlChange.Rotation ->
                if (change.degrees !in listOf(0, 180)) return invalid("rotation must be 0 or 180")
                else c.copy(rotation = change.degrees)
            is ControlChange.Preview -> c.copy(previewQuality = change.quality)
        }.copy(generation = c.generation + 1)
        state.value = next
        return PortResult.Ok(next)
    }

    /** Simulates a camera-side change (e.g. a lock confirmed). */
    fun push(controls: Controls) {
        state.value = controls
    }

    private fun invalid(msg: String) = PortResult.Err(ProtocolError(ErrorCodes.INVALID_VALUE, msg))

    companion object {
        val DEFAULT = Controls(
            generation = 3,
            settling = false,
            exposure = ExposureControl(ControlMode.AUTO, true, true, 0, true),
            whiteBalance = WhiteBalanceControl(ControlMode.AUTO, true, true),
            focus = FocusControl(FocusMode.AUTO, true, true),
            rotation = 0,
            previewQuality = PreviewQuality.NORMAL,
        )
    }
}

class FakeFrameStore : FrameStore {
    private class Entry(val info: FrameInfo, val jpeg: ByteArray, var acked: Boolean = false, var reclaimed: Boolean = false)

    private val ulids = UlidGenerator()
    private val frames = ConcurrentHashMap<String, Entry>()
    private var seq = 0L

    @Synchronized
    fun add(clientId: String, projectId: String, rotation: Int, jpeg: ByteArray = fakeJpeg(64)): FrameInfo {
        val info = FrameInfo(
            frameId = ulids.next(),
            seq = ++seq,
            projectId = projectId,
            clientId = clientId,
            rotation = rotation,
            capturedAt = Instant.now().toString(),
            full = FullImage(4000, 3000, jpeg.size.toLong(), "0".repeat(64)),
            derived = DerivedImages(Size(1440, 1080), Size(256, 192)),
        )
        frames[info.frameId] = Entry(info, jpeg)
        return info
    }

    fun reclaim(frameId: String) {
        frames[frameId]?.reclaimed = true
    }

    override fun listUnacked(clientId: String, afterSeq: Long?, limit: Int): FramePage {
        val all = frames.values.filter { it.info.clientId == clientId && !it.acked && it.info.seq > (afterSeq ?: 0) }
            .map { it.info }.sortedBy { it.seq }
        return FramePage(all.take(limit), all.size > limit)
    }

    override fun ack(clientId: String, frameIds: List<String>): AckResult {
        val unknown = mutableListOf<String>()
        var acked = 0
        for (id in frameIds.distinct()) {
            val e = frames[id]
            if (e == null || e.info.clientId != clientId) unknown += id
            else {
                e.acked = true
                acked++
            }
        }
        return AckResult(acked, unknown)
    }

    override fun open(frameId: String, variant: FrameVariant): FrameFile? {
        val e = frames[frameId]?.takeIf { !it.reclaimed } ?: return null
        return when (variant) {
            FrameVariant.FULL -> FrameFile.InMemory(e.jpeg)
            FrameVariant.PLAY -> FrameFile.InMemory(e.jpeg.copyOf(e.jpeg.size / 2))
            FrameVariant.THUMB -> FrameFile.InMemory(e.jpeg.copyOf(e.jpeg.size / 4))
        }
    }
}

/**
 * Single-flight capture with dedup. Set [gate] to hold captures until it completes; every
 * started capture's reqId is sent to [started].
 */
class FakeCapture(private val store: FakeFrameStore, private val controls: ControlsPort) : CaptureService {
    @Volatile var gate: CompletableDeferred<Unit>? = null
    val started = Channel<String>(Channel.UNLIMITED)
    private val ops = ConcurrentHashMap<Pair<String, String>, OperationState>()
    private var busy = false

    override suspend fun capture(clientId: String, reqId: String, args: CaptureArgs): PortResult<FrameInfo> {
        val key = clientId to reqId
        synchronized(this) {
            when (val known = ops[key]) {
                is OperationState.Done -> return PortResult.Ok(known.result)
                is OperationState.Failed -> return PortResult.Err(ProtocolError(known.error.code, known.error.message))
                OperationState.Pending -> return PortResult.Err(inProgress())
                else -> Unit
            }
            if (busy) return PortResult.Err(inProgress())
            if (args.rotation != controls.get().rotation) {
                val err = ProtocolError(ErrorCodes.GEOMETRY_MISMATCH, "rotation mismatch")
                ops[key] = OperationState.Failed(OperationError(err.code, err.message))
                return PortResult.Err(err)
            }
            busy = true
            ops[key] = OperationState.Pending
        }
        try {
            started.send(reqId)
            gate?.await()
            val frame = store.add(clientId, args.projectId, args.rotation)
            ops[key] = OperationState.Done(frame)
            return PortResult.Ok(frame)
        } finally {
            synchronized(this) { busy = false }
        }
    }

    override fun getOperation(clientId: String, reqId: String): OperationState = ops[clientId to reqId] ?: OperationState.Unknown

    private fun inProgress() = ProtocolError(ErrorCodes.CAPTURE_IN_PROGRESS, "a capture is running")
}

/** Frames appear only when the test calls [produce]; no [produce] = a stalled camera. */
class FakePreview : PreviewSource {
    private val latest = MutableStateFlow<PreviewFrameData?>(null)
    private val waiting = MutableStateFlow(0)
    val qualities = CopyOnWriteArrayList<PreviewQuality>()
    private var seq = 0L

    override fun currentSeq(): Long = latest.value?.seq ?: 0

    override suspend fun nextFrame(quality: PreviewQuality, afterSeq: Long): PreviewFrameData {
        qualities += quality
        waiting.update { it + 1 }
        try {
            return latest.filterNotNull().first { it.seq > afterSeq }
        } finally {
            waiting.update { it - 1 }
        }
    }

    @Synchronized
    fun produce(w: Int = 640, h: Int = 480): PreviewFrameData {
        val f = PreviewFrameData(
            fakeJpeg(32), w, h, ++seq, System.currentTimeMillis(), 3,
            PreviewLocks(ControlMode.AUTO, ControlMode.AUTO, FocusMode.AUTO),
        )
        latest.value = f
        return f
    }

    /** Suspends until the server is waiting for a frame. */
    suspend fun awaitWaiter() {
        withTimeout(5_000) { waiting.first { it > 0 } }
    }

    fun waiterCount(): Int = waiting.value
}

/** All fakes wired together. */
class FakeCamera {
    val identity = FakeIdentity()
    val status = FakeStatus()
    val controls = FakeControls()
    val frames = FakeFrameStore()
    val capture = FakeCapture(frames, controls)
    val preview = FakePreview()
    val ports = CameraPorts(identity, status, controls, capture, frames, preview)
}

/** SOI + filler + EOI; enough for byte-level tests. */
fun fakeJpeg(size: Int): ByteArray = ByteArray(size) { i ->
    when (i) {
        0 -> 0xFF.toByte()
        1 -> 0xD8.toByte()
        size - 2 -> 0xFF.toByte()
        size - 1 -> 0xD9.toByte()
        else -> (i % 251).toByte()
    }
}
