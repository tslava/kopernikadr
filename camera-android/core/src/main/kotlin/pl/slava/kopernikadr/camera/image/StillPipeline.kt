package pl.slava.kopernikadr.camera.image

import kotlinx.serialization.Serializable
import pl.slava.kopernikadr.camera.camera.StillCapture
import pl.slava.kopernikadr.camera.core.FrameTransform
import pl.slava.kopernikadr.camera.core.IntRect
import pl.slava.kopernikadr.camera.core.Size

/** CPU time of one still through [StillPipeline.processStill], milliseconds. */
@Serializable
data class PipelineTimings(val decodeMs: Double, val transformMs: Double, val encodeMs: Double)

/** The upright `full` JPEG of one still. */
class FullStill(
    val jpeg: ByteArray,
    val size: Size,
    val transform: FrameTransform,
    val timings: PipelineTimings,
)

/**
 * Still → `full` JPEG (ARCHITECTURE §4.3): decode → [FrameTransform] (crop + 0/180 rotation, no
 * scaling) → JPEG q[fullQuality] without EXIF orientation; and `full` → display caches.
 * Stateless and thread-safe; peak memory is two decoded stills.
 */
class StillPipeline(
    private val codec: ImageCodec,
    private val fullQuality: Int = 92,
    private val derivedQuality: Int = 85,
    private val nanoTime: () -> Long = System::nanoTime,
) {
    /**
     * @param projectRotation 0 or 180, added to the still's `rotationDegrees`.
     * @throws IllegalArgumentException on an invalid rotation/crop (see [FrameTransform.compute]).
     * @throws java.io.IOException if the JPEG cannot be decoded.
     */
    fun processStill(still: StillCapture, projectRotation: Int): FullStill {
        var t0 = nanoTime()
        val decoded = codec.decode(still.jpeg)
        try {
            val decodeMs = msSince(t0)
            val decodedSize = Size(decoded.width, decoded.height)
            // The decoded JPEG should match the ImageProxy size; if not, the crop rect is meaningless.
            val crop = if (decodedSize == still.bufferSize) still.cropRect else IntRect.of(decodedSize)
            val t = FrameTransform.compute(decodedSize, crop, still.rotationDegrees, projectRotation)

            t0 = nanoTime()
            val identity = t.rotationDegrees == 0 && t.cropRect == IntRect.of(decodedSize)
            val upright = if (identity) decoded else codec.transform(decoded, t)
            val transformMs = msSince(t0)
            try {
                t0 = nanoTime()
                val jpeg = codec.encodeJpeg(upright, fullQuality)
                return FullStill(jpeg, t.outputSize, t, PipelineTimings(decodeMs, transformMs, msSince(t0)))
            } finally {
                if (upright !== decoded) upright.release()
            }
        } finally {
            decoded.release()
        }
    }

    /**
     * A display cache from the `full` JPEG: the centre 4:3 of [fullJpeg] scaled to [target]
     * (e.g. [PLAY] or [THUMB]), JPEG q[derivedQuality]. Decodes subsampled when possible.
     */
    fun derive(fullJpeg: ByteArray, target: Size): ByteArray {
        require(target.isExact4by3) { "target $target is not 4:3" }
        val probe = codec.decode(fullJpeg, sampleSizeFor(fullJpeg, target))
        return probe.use { src ->
            val srcSize = Size(src.width, src.height)
            val t = FrameTransform.compute(srcSize, IntRect.of(srcSize), 0, 0, target)
            if (t.outputSize == srcSize && t.cropRect == IntRect.of(srcSize)) {
                codec.encodeJpeg(src, derivedQuality)
            } else {
                codec.transform(src, t).use { codec.encodeJpeg(it, derivedQuality) }
            }
        }
    }

    private fun sampleSizeFor(jpeg: ByteArray, target: Size): Int {
        val size = JpegSize.read(jpeg) ?: return 1
        var s = 1
        while (size.width / (s * 2) >= target.width && size.height / (s * 2) >= target.height) s *= 2
        return s
    }

    private fun msSince(t0: Long): Double = (nanoTime() - t0) / 1_000_000.0

    companion object {
        val PLAY = Size(1440, 1080)
        val THUMB = Size(256, 192)
    }
}

/** Reads a JPEG's pixel size from its SOFn marker without decoding. */
object JpegSize {
    fun read(jpeg: ByteArray): Size? {
        if (jpeg.size < 4 || u8(jpeg, 0) != 0xFF || u8(jpeg, 1) != 0xD8) return null
        var i = 2
        while (i + 9 < jpeg.size) {
            if (u8(jpeg, i) != 0xFF) return null
            val marker = u8(jpeg, i + 1)
            if (marker == 0xFF) {
                i++
                continue
            }
            val len = (u8(jpeg, i + 2) shl 8) or u8(jpeg, i + 3)
            val isSof = marker in 0xC0..0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
            if (isSof) {
                val h = (u8(jpeg, i + 5) shl 8) or u8(jpeg, i + 6)
                val w = (u8(jpeg, i + 7) shl 8) or u8(jpeg, i + 8)
                return if (w > 0 && h > 0) Size(w, h) else null
            }
            i += 2 + len
        }
        return null
    }

    private fun u8(b: ByteArray, i: Int) = b[i].toInt() and 0xFF
}
