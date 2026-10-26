package pl.slava.kopernikadr.camera.server

import java.io.File
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.CaptureArgs
import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.FrameInfo
import pl.slava.kopernikadr.camera.protocol.OperationState
import pl.slava.kopernikadr.camera.protocol.PreviewLocks
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.ProtocolError
import pl.slava.kopernikadr.camera.protocol.Status

// The ports the camera server depends on. `:app` implements them over CameraX and the spool;
// tests use the in-memory fakes. The server knows nothing else about the camera.

/** Result of a port call that can fail with a protocol error (sent back as `ok:false`). */
sealed interface PortResult<out T> {
    data class Ok<out T>(val value: T) : PortResult<T>
    data class Err(val error: ProtocolError) : PortResult<Nothing>
}

/** Camera identity and static description (`/info`, `hello`). */
interface IdentityPort {
    val cameraId: String

    /** New on every server start. */
    val bootId: String
    val name: String
    fun capabilities(): Capabilities
}

fun interface StatusPort {
    /** Cheap snapshot; called for `hello`, `getStatus` and the periodic `status` event. */
    fun status(): Status
}

interface CaptureService {
    /**
     * Runs one `capture` (§6): dedup by `(clientId, reqId)`, single flight, durable commit.
     * Called off the socket's receive loop, possibly concurrently for different sockets. The
     * server only guards a repeated in-flight `reqId` on the same socket. The call is not
     * cancelled when the socket closes (it runs in the server scope); it is cancelled on [CameraServer.stop].
     */
    suspend fun capture(clientId: String, reqId: String, args: CaptureArgs): PortResult<FrameInfo>

    /** `getOperation` (§6), scoped to [clientId]. Blocking allowed (called on Dispatchers.IO). */
    fun getOperation(clientId: String, reqId: String): OperationState
}

/** `data` of `listFrames`. */
@Serializable
data class FramePage(val frames: List<FrameInfo>, val hasMore: Boolean)

/** `data` of `ack`. */
@Serializable
data class AckResult(val acked: Int, val unknown: List<String>)

enum class FrameVariant(val wire: String) {
    FULL("full"), PLAY("play"), THUMB("thumb");

    companion object {
        fun fromWire(s: String): FrameVariant? = entries.firstOrNull { it.wire == s }
    }
}

/** A JPEG to serve from `/frames`. `Content-Length` is always set from it. */
sealed interface FrameFile {
    data class OnDisk(val file: File) : FrameFile
    class InMemory(val bytes: ByteArray) : FrameFile
}

/** The capture spool as seen by the server. All calls may block; the server calls them on Dispatchers.IO. */
interface FrameStore {
    /** The client's committed, unacked frames with `seq > afterSeq` (all if null), by `seq`, at most [limit]. */
    fun listUnacked(clientId: String, afterSeq: Long?, limit: Int): FramePage

    /** Idempotent. Ids of other clients or unknown ids go to [AckResult.unknown]. */
    fun ack(clientId: String, frameIds: List<String>): AckResult

    /**
     * The file for `/frames/{frameId}/{variant}.jpg`, or null → 404. `full`: null if unknown or
     * reclaimed. `play`/`thumb`: generated on demand if missing (may take ~1 s); null if `full` is gone.
     */
    fun open(frameId: String, variant: FrameVariant): FrameFile?
}

/** One preview JPEG with the metadata of its §7 header (`bootId` is added by the server). */
class PreviewFrameData(
    val jpeg: ByteArray,
    val w: Int,
    val h: Int,
    /** Strictly increasing per server run. */
    val seq: Long,
    /** Camera wall clock, epoch ms, when the frame was produced. */
    val ts: Long,
    val generation: Long,
    val locks: PreviewLocks,
)

interface PreviewSource {
    /** `seq` of the newest frame produced so far (0 if none). Read when a `next` arrives. */
    fun currentSeq(): Long

    /**
     * Suspends until a frame with `seq > afterSeq` exists at [quality] and returns the newest one.
     * Must survive rebinds/capture pauses: just keep suspending until frames resume. Cancelled
     * when the preview socket closes.
     */
    suspend fun nextFrame(quality: PreviewQuality, afterSeq: Long): PreviewFrameData
}

/** One `setControl` request (§6), already shape-checked by the server. */
sealed interface ControlChange {
    /** `auto` or `locked`. */
    data class Exposure(val mode: ControlMode) : ControlChange
    data class ExposureCompensation(val steps: Int) : ControlChange

    /** `auto` or `locked`. */
    data class WhiteBalance(val mode: ControlMode) : ControlChange

    /** `auto` or `locked`. */
    data class Focus(val mode: FocusMode) : ControlChange
    data class Rotation(val degrees: Int) : ControlChange
    data class Preview(val quality: PreviewQuality) : ControlChange
}

interface ControlsPort {
    fun get(): Controls

    /**
     * Requests a change; returns the `Controls` after the change was *requested* (new
     * `generation`), or `UNSUPPORTED_CONTROL` / `INVALID_VALUE` / `CAPTURE_IN_PROGRESS`.
     */
    suspend fun set(change: ControlChange): PortResult<Controls>

    /**
     * Every `Controls` change (a StateFlow is fine: values equal to the last one sent are skipped).
     * Pushed as `controls` events to the current session's control socket.
     */
    val updates: Flow<Controls>
}

/** Everything the server needs from the camera. */
class CameraPorts(
    val identity: IdentityPort,
    val status: StatusPort,
    val controls: ControlsPort,
    val capture: CaptureService,
    val frames: FrameStore,
    val preview: PreviewSource,
)
