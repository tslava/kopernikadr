package pl.slava.kopernikadr.camera.camera

import java.nio.ByteBuffer
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import pl.slava.kopernikadr.camera.controls.ResultSummary
import pl.slava.kopernikadr.camera.core.IntRect
import pl.slava.kopernikadr.camera.core.Size

/**
 * The camera as seen by the pure code (server, still pipeline, preview encoder, probes). The
 * Android implementation is `CameraController` in `:app` (CameraX); tests use a fake.
 *
 * Threading: every member may be called from any thread. Suspending calls never block the
 * caller's thread.
 */
interface CameraPort {
    /** Bind / open state and the requested vs resolved stream sizes of the current bind. */
    val status: StateFlow<CameraStatus>

    /**
     * Results of the repeating request (the Preview stream in variant A, the analysis stream in
     * B), as they arrive. Hot; a slow collector loses the oldest (buffer of a few dozen).
     */
    val results: SharedFlow<ResultSummary>

    /** The newest repeating-request result, or null before the first one of this bind. */
    fun latestResult(): ResultSummary?

    /**
     * Takes one in-memory JPEG still at the `full` size and pairs it with its capture result
     * (see [StillCapture.pairing]).
     * @throws CameraNotReadyException if the camera is not bound and open.
     * @throws CameraCaptureException if CameraX reports a capture error.
     */
    suspend fun takePicture(): StillCapture

    /**
     * Pull-style analysis frames: suspends until the **next** analysis frame arrives, runs
     * [block] on it on the analysis thread while the buffer is still open, and returns the
     * result. Frames that arrive while nobody waits are closed at once without any conversion,
     * so a preview encoder that calls this only while a client has a pending `next` encodes
     * nothing otherwise.
     *
     * The frame's plane buffers are valid only inside [block] (zero copy); copy what must
     * outlive it. [block] must be quick (it holds back the next frame) and must not suspend.
     * A waiting call survives a camera rebind: it is served by the first frame after the
     * rebind. Cancelling the caller drops the request.
     */
    suspend fun <T> withNextAnalysisFrame(block: (AnalysisFrame) -> T): T
}

/** A capture or bind problem that the caller may retry (e.g. after the next bind). */
class CameraNotReadyException(message: String) : IllegalStateException(message)

/** CameraX failed a `takePicture` ([code] = `ImageCapture.ERROR_*`). */
class CameraCaptureException(val code: Int, message: String, cause: Throwable? = null) :
    RuntimeException(message, cause)

/** Which use cases are bound (plan "streams" probe). */
@Serializable
enum class StreamVariant {
    /** Preview + ImageAnalysis + ImageCapture (production). */
    A,

    /** ImageAnalysis + ImageCapture, no Preview. */
    B,
}

/** Pixel format of the analysis buffers. */
@Serializable
enum class AnalysisFormat {
    /** 3 planes Y, U, V (`ImageFormat.YUV_420_888`), each with its own row/pixel stride. */
    YUV_420_888,

    /** 1 plane, 4 bytes per pixel R, G, B, A (`PixelFormat.RGBA_8888`). */
    RGBA_8888,
}

/** One stream's requested size and what CameraX resolved (`UseCase.resolutionInfo`). */
@Serializable
data class StreamSizes(
    val requested: Size,
    val resolved: Size? = null,
    /** `ResolutionInfo.cropRect` (the ViewPort crop in buffer coordinates). */
    val cropRect: IntRect? = null,
    /** `ResolutionInfo.rotationDegrees`. */
    val rotationDegrees: Int? = null,
)

/** Geometry of a buffer that was actually delivered (`ImageProxy` w/h, cropRect, rotationDegrees). */
@Serializable
data class BufferGeometry(val size: Size, val cropRect: IntRect, val rotationDegrees: Int)

/** The strict bind attempt (`FALLBACK_RULE_NONE` everywhere). */
@Serializable
data class StrictBindOutcome(val ok: Boolean, val error: String? = null)

/** What one bind requested and got. */
@Serializable
data class BindInfo(
    /** Increases with every bind of this process. */
    val bindId: Long,
    val variant: StreamVariant,
    val analysisFormat: AnalysisFormat,
    val strict: StrictBindOutcome,
    /** Null in variant B. */
    val preview: StreamSizes? = null,
    val analysis: StreamSizes,
    val capture: StreamSizes,
    /** The first analysis buffer of this bind; null until it arrives. */
    val analysisBuffer: BufferGeometry? = null,
)

@Serializable
data class CameraStatus(
    /** Use cases are bound to the started activity. */
    val bound: Boolean = false,
    /** CameraX reports the camera OPEN for the current bind (frames flow, stills possible). */
    val open: Boolean = false,
    /** The current bind, or the last one while unbound; null before the first bind. */
    val bind: BindInfo? = null,
    /** The last bind or camera error, cleared by the next successful open. */
    val error: String? = null,
) {
    /** What the server and probes wait for. */
    val ready: Boolean get() = bound && open
}

/**
 * One still from `ImageCapture` (in memory). [jpeg] is the camera's JPEG as delivered; it is not
 * rotated or cropped yet — apply `FrameTransform.compute(bufferSize, cropRect, rotationDegrees, …)`.
 */
class StillCapture(
    val jpeg: ByteArray,
    /** `ImageProxy` width × height. */
    val bufferSize: Size,
    /** `ImageProxy.cropRect` (from the ViewPort; the whole buffer for a 4:3 still). */
    val cropRect: IntRect,
    /** `imageInfo.rotationDegrees`; 0 or 180 with target rotation ROTATION_90. */
    val rotationDegrees: Int,
    /** `imageInfo.timestamp`, ns; equals the result's `SENSOR_TIMESTAMP` when paired. */
    val sensorTimestampNs: Long,
    /** The paired capture result, or null ([pairing] = [StillPairing.Outcome.NONE]). */
    val result: ResultSummary?,
    val pairing: StillPairing.Outcome,
    val timings: StillTimings,
) {
    override fun toString(): String =
        "StillCapture(${jpeg.size} B, $bufferSize, crop=$cropRect, rot=$rotationDegrees, ts=$sensorTimestampNs, " +
            "pairing=$pairing, $timings)"
}

/** Durations of one [CameraPort.takePicture], milliseconds. */
@Serializable
data class StillTimings(
    /** `takePicture` call → `onCaptureSuccess`. */
    val captureMs: Double,
    /** JPEG buffer → [StillCapture.jpeg]. */
    val copyMs: Double,
    /** Waiting for the matching capture result after the image arrived. */
    val pairWaitMs: Double,
)

/**
 * An analysis frame, valid only inside [CameraPort.withNextAnalysisFrame]'s block.
 *
 * Planes are the raw CameraX plane buffers (read-only views, position 0, zero copy):
 * - [AnalysisFormat.YUV_420_888]: Y, U, V. Pixel (x, y) of plane `p` is at
 *   `y' * rowStride + x' * pixelStride` with `x' = x, y' = y` for Y and `x' = x/2, y' = y/2` for
 *   U/V. U and V are often interleaved (pixelStride 2, NV21/NV12 layout in memory).
 * - [AnalysisFormat.RGBA_8888]: one plane, pixelStride 4.
 *
 * Rows may be padded (`rowStride > width * pixelStride`) and the last row may be shorter than
 * `rowStride`.
 */
class AnalysisFrame(
    val format: AnalysisFormat,
    val size: Size,
    val cropRect: IntRect,
    /** 0 or 180 with target rotation ROTATION_90 (output rotation is not enabled). */
    val rotationDegrees: Int,
    /** `imageInfo.timestamp`, ns. */
    val timestampNs: Long,
    val planes: List<Plane>,
) {
    class Plane(val buffer: ByteBuffer, val rowStride: Int, val pixelStride: Int)

    val geometry: BufferGeometry get() = BufferGeometry(size, cropRect, rotationDegrees)

    override fun toString(): String =
        "AnalysisFrame($format $size crop=$cropRect rot=$rotationDegrees ts=$timestampNs " +
            "planes=${planes.joinToString { "${it.buffer.remaining()}B/${it.rowStride}/${it.pixelStride}" }})"
}

/** One line for diagnostics: variant, strict/fallback and the resolved P/A/C sizes. */
fun BindInfo.summary(): String = buildString {
    append(variant)
    append(if (strict.ok) " · strict ok" else " · fallback")
    preview?.resolved?.let { append(" · P ").append(it) }
    analysis.resolved?.let { append(" · A ").append(it) }
    capture.resolved?.let { append(" · C ").append(it) }
}
