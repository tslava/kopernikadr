package pl.slava.kopernikadr.camera.image

import pl.slava.kopernikadr.camera.camera.AnalysisFrame
import pl.slava.kopernikadr.camera.core.FrameTransform

/**
 * An opaque decoded image owned by one [ImageCodec] (a `Bitmap` on Android, a `BufferedImage`
 * in tests). The owner calls [release] once it is done; using it afterwards is an error.
 */
interface Pixels {
    val width: Int
    val height: Int
    fun release()
}

/**
 * Image operations the pure pipeline needs. All calls block (CPU-bound) and are safe from any
 * thread; each returned [Pixels] is new and owned by the caller (inputs are never released).
 * JPEGs written by [encodeJpeg] carry no EXIF orientation (pixels are already upright).
 */
interface ImageCodec {
    /**
     * Decodes a JPEG, ignoring its EXIF orientation. [sampleSize] (a power of two) is a hint: the
     * codec may return an image up to `sampleSize` times smaller per side.
     * @throws java.io.IOException if [jpeg] cannot be decoded.
     */
    fun decode(jpeg: ByteArray, sampleSize: Int = 1): Pixels

    fun encodeJpeg(pixels: Pixels, quality: Int): ByteArray

    /**
     * Renders [pixels] through [t] into a new [FrameTransform.outputSize] image:
     * `out(t.matrix(p)) = in(p)`, i.e. crop [FrameTransform.cropRect], rotate by
     * [FrameTransform.rotationDegrees] and scale, with bilinear filtering.
     */
    fun transform(pixels: Pixels, t: FrameTransform): Pixels

    /** The whole YUV_420_888 [frame] buffer (`frame.size`, not cropped or rotated) as RGB. See [Yuv]. */
    fun fromYuv(frame: AnalysisFrame): Pixels
}

/** Runs [block] and releases [p] afterwards. */
inline fun <T> Pixels.use(block: (Pixels) -> T): T = try {
    block(this)
} finally {
    release()
}
