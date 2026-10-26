package pl.slava.kopernikadr.camera.image

import java.nio.ByteBuffer
import pl.slava.kopernikadr.camera.camera.AnalysisFormat
import pl.slava.kopernikadr.camera.camera.AnalysisFrame
import pl.slava.kopernikadr.camera.camera.StillCapture
import pl.slava.kopernikadr.camera.camera.StillPairing
import pl.slava.kopernikadr.camera.camera.StillTimings
import pl.slava.kopernikadr.camera.controls.ResultSummary
import pl.slava.kopernikadr.camera.core.IntRect
import pl.slava.kopernikadr.camera.core.Size

const val RED = 0xFF0000
const val BLUE = 0x0000FF
const val GRAY = 0x808080

/** A [w]×[h] still: gray, red block top-left, blue block bottom-right (each 1/8 of the side). */
fun markedStill(
    w: Int,
    h: Int,
    rotationDegrees: Int = 0,
    crop: IntRect = IntRect(0, 0, w, h),
    result: ResultSummary? = null,
): StillCapture {
    val bw = w / 8
    val bh = h / 8
    val jpeg = ImageIoCodec.jpeg(
        w, h, GRAY,
        intArrayOf(0, 0, bw, bh, RED),
        intArrayOf(w - bw, h - bh, bw, bh, BLUE),
    )
    return StillCapture(
        jpeg = jpeg,
        bufferSize = Size(w, h),
        cropRect = crop,
        rotationDegrees = rotationDegrees,
        sensorTimestampNs = 1_000L,
        result = result,
        pairing = if (result == null) StillPairing.Outcome.NONE else StillPairing.Outcome.STILL_CALLBACK,
        timings = StillTimings(10.0, 1.0, 0.0),
    )
}

/**
 * A [w]×[h] YUV_420_888 frame as on the g05: Y pixelStride 1, U/V interleaved (NV21 in memory,
 * pixelStride 2), rows padded to [rowStride]. Y = [bright] in the top-left quadrant, 16
 * elsewhere; chroma (u, v) everywhere.
 */
fun yuvFrame(
    w: Int,
    h: Int,
    rowStride: Int = w + 64,
    rotationDegrees: Int = 0,
    bright: Int = 235,
    u: Int = 128,
    v: Int = 128,
): AnalysisFrame {
    val y = ByteArray(rowStride * (h - 1) + w)
    for (row in 0 until h) for (x in 0 until w) {
        y[row * rowStride + x] = (if (x < w / 2 && row < h / 2) bright else 16).toByte()
    }
    // NV21: V U V U …, V plane starts at 0, U plane at 1; last row is one byte short.
    val vu = ByteArray(rowStride * (h / 2 - 1) + w)
    for (row in 0 until h / 2) for (cx in 0 until w / 2) {
        vu[row * rowStride + 2 * cx] = v.toByte()
        if (row * rowStride + 2 * cx + 1 < vu.size) vu[row * rowStride + 2 * cx + 1] = u.toByte()
    }
    val vBuf = ByteBuffer.wrap(vu, 0, vu.size - 1).slice()
    val uBuf = ByteBuffer.wrap(vu, 1, vu.size - 1).slice()
    return AnalysisFrame(
        format = AnalysisFormat.YUV_420_888,
        size = Size(w, h),
        cropRect = IntRect(0, 0, w, h),
        rotationDegrees = rotationDegrees,
        timestampNs = 42L,
        planes = listOf(
            AnalysisFrame.Plane(ByteBuffer.wrap(y), rowStride, 1),
            AnalysisFrame.Plane(uBuf, rowStride, 2),
            AnalysisFrame.Plane(vBuf, rowStride, 2),
        ),
    )
}
