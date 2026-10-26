package pl.slava.kopernikadr.camera.image

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.core.Size
import pl.slava.kopernikadr.camera.protocol.PreviewQuality

class PreviewEncoderTest {
    private val encoder = PreviewEncoder(ImageIoCodec())

    private fun luma(rgb: Int) = ((rgb shr 16 and 0xFF) + (rgb shr 8 and 0xFF) + (rgb and 0xFF)) / 3

    @Test
    fun `size per quality`() {
        val frame = yuvFrame(960, 720)
        for ((q, size) in listOf(
            PreviewQuality.LOW to Size(640, 480),
            PreviewQuality.NORMAL to Size(960, 720),
            PreviewQuality.HIGH to Size(1280, 960),
        )) {
            val out = encoder.encode(frame, 0, q)
            assertEquals(size, out.size)
            val img = ImageIoCodec.read(out.jpeg)
            assertEquals(size.width, img.width)
            assertEquals(size.height, img.height)
        }
    }

    @Test
    fun `bright quadrant top-left at 0, bottom-right at 180`() {
        val frame = yuvFrame(960, 720)
        val up = ImageIoCodec.read(encoder.encode(frame, 0, PreviewQuality.LOW).jpeg)
        assertTrue(luma(up.getRGB(20, 20)) > 200)
        assertTrue(luma(up.getRGB(620, 460)) < 40)
        val flipped = ImageIoCodec.read(encoder.encode(frame, 180, PreviewQuality.LOW).jpeg)
        assertTrue(luma(flipped.getRGB(20, 20)) < 40)
        assertTrue(luma(flipped.getRGB(620, 460)) > 200)
        // buffer rotation 180 + project 180 = upright
        val both = ImageIoCodec.read(encoder.encode(yuvFrame(960, 720, rotationDegrees = 180), 180, PreviewQuality.LOW).jpeg)
        assertTrue(luma(both.getRGB(20, 20)) > 200)
    }

    @Test
    fun `yuv to argb honours strides and BT601`() {
        // Pure red in full-range BT.601: Y=76, U=85, V=255.
        val argb = Yuv.toArgb(yuvFrame(8, 4, rowStride = 16, bright = 76, u = 85, v = 255))
        val r = argb[0] shr 16 and 0xFF
        val g = argb[0] shr 8 and 0xFF
        val b = argb[0] and 0xFF
        assertTrue("r=$r g=$g b=$b", r > 245 && g < 10 && b < 10)
        assertEquals(0xFF, argb[0] ushr 24)
        // Gray: Y=16 elsewhere with neutral chroma is 16,16,16 — use neutral frame.
        val gray = Yuv.toArgb(yuvFrame(8, 4, rowStride = 16))
        assertEquals(0xFFEBEBEB.toInt(), gray[0])
        assertEquals(0xFF101010.toInt(), gray[8 * 4 - 1])
    }
}
