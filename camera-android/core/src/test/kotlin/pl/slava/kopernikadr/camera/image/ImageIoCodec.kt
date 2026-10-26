package pl.slava.kopernikadr.camera.image

import java.awt.RenderingHints
import java.awt.geom.AffineTransform
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import javax.imageio.IIOImage
import javax.imageio.ImageIO
import javax.imageio.ImageWriteParam
import pl.slava.kopernikadr.camera.camera.AnalysisFrame
import pl.slava.kopernikadr.camera.core.FrameTransform

/** JVM [ImageCodec] for tests (javax.imageio + Java2D). */
class ImageIoCodec : ImageCodec {
    class Img(val image: BufferedImage) : Pixels {
        var released = false
        override val width get() = image.width
        override val height get() = image.height
        override fun release() {
            check(!released) { "double release" }
            released = true
        }
    }

    override fun decode(jpeg: ByteArray, sampleSize: Int): Pixels {
        val stream = ImageIO.createImageInputStream(ByteArrayInputStream(jpeg))
        val reader = ImageIO.getImageReaders(stream).asSequence().firstOrNull() ?: throw IOException("not an image")
        try {
            reader.input = stream
            val param = reader.defaultReadParam
            if (sampleSize > 1) param.setSourceSubsampling(sampleSize, sampleSize, 0, 0)
            return Img(toRgb(reader.read(0, param)))
        } catch (e: Exception) {
            throw IOException("cannot decode: $e", e)
        } finally {
            reader.dispose()
        }
    }

    override fun encodeJpeg(pixels: Pixels, quality: Int): ByteArray {
        val writer = ImageIO.getImageWritersByFormatName("jpeg").next()
        val out = ByteArrayOutputStream()
        ImageIO.createImageOutputStream(out).use { ios ->
            writer.output = ios
            val p = writer.defaultWriteParam
            p.compressionMode = ImageWriteParam.MODE_EXPLICIT
            p.compressionQuality = quality / 100f
            writer.write(null, IIOImage((pixels as Img).image, null, null), p)
            writer.dispose()
        }
        return out.toByteArray()
    }

    override fun transform(pixels: Pixels, t: FrameTransform): Pixels {
        val m = t.matrix
        val out = BufferedImage(t.outputSize.width, t.outputSize.height, BufferedImage.TYPE_INT_RGB)
        val g = out.createGraphics()
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
        g.drawImage((pixels as Img).image, AffineTransform(m.a, m.c, m.b, m.d, m.tx, m.ty), null)
        g.dispose()
        return Img(out)
    }

    override fun fromYuv(frame: AnalysisFrame): Pixels {
        val w = frame.size.width
        val h = frame.size.height
        val img = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
        img.setRGB(0, 0, w, h, Yuv.toArgb(frame), 0, w)
        return Img(img)
    }

    private fun toRgb(src: BufferedImage): BufferedImage {
        if (src.type == BufferedImage.TYPE_INT_RGB) return src
        val out = BufferedImage(src.width, src.height, BufferedImage.TYPE_INT_RGB)
        out.createGraphics().apply { drawImage(src, 0, 0, null); dispose() }
        return out
    }

    companion object {
        /** A JPEG of [w]×[h] filled with [bg] and the given solid rects (x, y, w, h, rgb). */
        fun jpeg(w: Int, h: Int, bg: Int, vararg rects: IntArray, quality: Int = 95): ByteArray {
            val img = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
            val g = img.createGraphics()
            g.color = java.awt.Color(bg)
            g.fillRect(0, 0, w, h)
            for (r in rects) {
                g.color = java.awt.Color(r[4])
                g.fillRect(r[0], r[1], r[2], r[3])
            }
            g.dispose()
            return ImageIoCodec().encodeJpeg(Img(img), quality)
        }

        fun read(jpeg: ByteArray): BufferedImage = ImageIO.read(ByteArrayInputStream(jpeg))

        /** True if [rgb] is within [tol] of [expected] per channel. */
        fun near(rgb: Int, expected: Int, tol: Int = 40): Boolean =
            (0..2).all { s ->
                val sh = s * 8
                kotlin.math.abs(((rgb shr sh) and 0xFF) - ((expected shr sh) and 0xFF)) <= tol
            }
    }
}
