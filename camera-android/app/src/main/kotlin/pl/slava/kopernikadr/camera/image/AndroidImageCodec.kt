package pl.slava.kopernikadr.camera.image

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import java.io.ByteArrayOutputStream
import java.io.IOException
import pl.slava.kopernikadr.camera.camera.AnalysisFrame
import pl.slava.kopernikadr.camera.core.FrameTransform

/** [ImageCodec] over `android.graphics` (BitmapFactory / Canvas + Matrix / Bitmap.compress). */
class AndroidImageCodec : ImageCodec {
    class BitmapPixels(val bitmap: Bitmap) : Pixels {
        override val width: Int get() = bitmap.width
        override val height: Int get() = bitmap.height
        override fun release() = bitmap.recycle()
    }

    override fun decode(jpeg: ByteArray, sampleSize: Int): Pixels {
        val opts = BitmapFactory.Options().apply {
            inMutable = false
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inSampleSize = sampleSize.coerceAtLeast(1)
        }
        val bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, opts) ?: throw IOException("undecodable JPEG (${jpeg.size} B)")
        return BitmapPixels(bmp)
    }

    override fun encodeJpeg(pixels: Pixels, quality: Int): ByteArray {
        val bmp = (pixels as BitmapPixels).bitmap
        val out = ByteArrayOutputStream(bmp.width * bmp.height / 4)
        check(bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)) { "Bitmap.compress failed" }
        return out.toByteArray()
    }

    override fun transform(pixels: Pixels, t: FrameTransform): Pixels {
        val src = (pixels as BitmapPixels).bitmap
        val out = Bitmap.createBitmap(t.outputSize.width, t.outputSize.height, Bitmap.Config.ARGB_8888)
        val m = Matrix().apply { setValues(t.matrix.toMatrixValues()) }
        Canvas(out).drawBitmap(src, m, Paint(Paint.FILTER_BITMAP_FLAG))
        return BitmapPixels(out)
    }

    override fun fromYuv(frame: AnalysisFrame): Pixels {
        val w = frame.size.width
        val h = frame.size.height
        return BitmapPixels(Bitmap.createBitmap(Yuv.toArgb(frame), w, h, Bitmap.Config.ARGB_8888))
    }
}
