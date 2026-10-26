package pl.slava.kopernikadr.camera.image

import pl.slava.kopernikadr.camera.camera.AnalysisFrame
import pl.slava.kopernikadr.camera.core.FrameTransform
import pl.slava.kopernikadr.camera.core.Size
import pl.slava.kopernikadr.camera.protocol.PreviewQuality

/** One encoded preview frame. */
class PreviewJpeg(val jpeg: ByteArray, val size: Size, val timestampNs: Long)

/**
 * Analysis frame → upright 4:3 preview JPEG (ARCHITECTURE §4.3): YUV → RGB → the same
 * [FrameTransform] as the still (crop + 0/180) scaled to 640/960/1280 px wide → JPEG q[quality].
 * Call it inside `CameraPort.withNextAnalysisFrame` (the plane buffers are only valid there),
 * only while a preview client has a pending `next`. Thread-safe.
 */
class PreviewEncoder(private val codec: ImageCodec, private val quality: Int = 70) {
    fun encode(frame: AnalysisFrame, projectRotation: Int, previewQuality: PreviewQuality): PreviewJpeg {
        val target = sizeFor(previewQuality)
        val t = FrameTransform.compute(frame.size, frame.cropRect, frame.rotationDegrees, projectRotation, target)
        return codec.fromYuv(frame).use { rgb ->
            codec.transform(rgb, t).use { out -> PreviewJpeg(codec.encodeJpeg(out, quality), t.outputSize, frame.timestampNs) }
        }
    }

    companion object {
        fun widthFor(q: PreviewQuality): Int = when (q) {
            PreviewQuality.LOW -> 640
            PreviewQuality.NORMAL -> 960
            PreviewQuality.HIGH -> 1280
        }

        fun sizeFor(q: PreviewQuality): Size = FrameTransform.size4by3ForWidth(widthFor(q))
    }
}
