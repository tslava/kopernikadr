package pl.slava.kopernikadr.remote.native

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import java.io.File
import java.io.IOException
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The image a segmenter session works on: [hasAlpha] is true when any pixel has alpha < 250. */
class LoadedImage(val width: Int, val height: Int, val hasAlpha: Boolean)

fun interface ImageLoader {
    /** Decodes [src] (EXIF orientation applied) at most [maxSide] on the long side and writes the PNG [dest]. */
    fun load(src: File, dest: File, maxSide: Int): LoadedImage
}

object ImageLoad {
    /** [w] x [h] scaled down so the long side is at most [maxSide]; never scaled up, never below 1 px. */
    fun targetSize(w: Int, h: Int, maxSide: Int): Pair<Int, Int> {
        require(w > 0 && h > 0 && maxSide > 0) { "bad size ${w}x$h / $maxSide" }
        val scale = min(1.0, maxSide.toDouble() / max(w, h))
        return max(1, (w * scale).roundToInt()) to max(1, (h * scale).roundToInt())
    }

    /** True if any pixel of [argb] has alpha < [maxAlpha]. */
    fun hasAlpha(argb: IntArray, maxAlpha: Int = 250): Boolean = argb.any { (it ushr 24) < maxAlpha }
}

/** `ImageDecoder` (API 28+, our minSdk is 31): one call applies the EXIF orientation and downsamples while decoding. */
class AndroidImageLoader : ImageLoader {
    override fun load(src: File, dest: File, maxSide: Int): LoadedImage {
        val bitmap = try {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(src)) { decoder, info, _ ->
                val (w, h) = ImageLoad.targetSize(info.size.width, info.size.height, maxSide)
                decoder.setTargetSize(w, h)
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } catch (e: IOException) {
            throw NativeException(NativeErrorCode.UNSUPPORTED, "cannot decode the image: ${e.message}", e)
        } catch (e: ImageDecoder.DecodeException) {
            throw NativeException(NativeErrorCode.UNSUPPORTED, "cannot decode the image: ${e.message}", e)
        }
        try {
            val w = bitmap.width
            val h = bitmap.height
            var alpha = false
            if (bitmap.hasAlpha()) {
                val row = IntArray(w)
                for (y in 0 until h) {
                    bitmap.getPixels(row, 0, w, 0, y, w, 1)
                    if (ImageLoad.hasAlpha(row)) { alpha = true; break }
                }
            }
            io("write the segmenter image") {
                dest.outputStream().use { out ->
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) throw IOException("PNG encoding failed")
                }
            }
            return LoadedImage(w, h, alpha)
        } finally {
            bitmap.recycle()
        }
    }
}
