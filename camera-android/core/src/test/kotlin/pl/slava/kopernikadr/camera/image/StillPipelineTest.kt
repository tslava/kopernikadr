package pl.slava.kopernikadr.camera.image

import java.awt.image.BufferedImage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.core.IntRect
import pl.slava.kopernikadr.camera.core.Size

class StillPipelineTest {
    private val codec = ImageIoCodec()
    private val pipeline = StillPipeline(codec)

    private fun BufferedImage.corner(right: Boolean, bottom: Boolean): Int {
        val x = if (right) width - 1 - width / 32 else width / 32
        val y = if (bottom) height - 1 - height / 32 else height / 32
        return getRGB(x, y) and 0xFFFFFF
    }

    private fun assertMarks(img: BufferedImage, topLeft: Int, bottomRight: Int) {
        assertTrue("top-left %06x".format(img.corner(false, false)), ImageIoCodec.near(img.corner(false, false), topLeft))
        assertTrue("bottom-right %06x".format(img.corner(true, true)), ImageIoCodec.near(img.corner(true, true), bottomRight))
        assertTrue("top-right %06x".format(img.corner(true, false)), ImageIoCodec.near(img.corner(true, false), GRAY))
    }

    @Test
    fun `8 MP full crop at rotation 0 keeps size and orientation`() {
        val full = pipeline.processStill(markedStill(3264, 2448), projectRotation = 0)
        assertEquals(Size(3264, 2448), full.size)
        val img = ImageIoCodec.read(full.jpeg)
        assertEquals(3264, img.width)
        assertEquals(2448, img.height)
        assertMarks(img, RED, BLUE)
        assertTrue(full.timings.decodeMs >= 0 && full.timings.encodeMs > 0)
    }

    @Test
    fun `project rotation 180 flips the image`() {
        val full = pipeline.processStill(markedStill(640, 480), projectRotation = 180)
        assertEquals(Size(640, 480), full.size)
        assertMarks(ImageIoCodec.read(full.jpeg), BLUE, RED)
    }

    @Test
    fun `buffer rotation 180 flips, buffer 180 plus project 180 does not`() {
        assertMarks(ImageIoCodec.read(pipeline.processStill(markedStill(640, 480, rotationDegrees = 180), 0).jpeg), BLUE, RED)
        assertMarks(ImageIoCodec.read(pipeline.processStill(markedStill(640, 480, rotationDegrees = 180), 180).jpeg), RED, BLUE)
    }

    @Test
    fun `non 4 by 3 crop is reduced to the centred 4 by 3`() {
        // 16:9-ish buffer: crop to 4:3 in the centre → red/blue blocks are cut off.
        val full = pipeline.processStill(markedStill(800, 450, crop = IntRect(0, 0, 800, 450)), 0)
        assertEquals(Size(600, 450), full.size)
    }

    @Test
    fun `no EXIF orientation in the output`() {
        val jpeg = pipeline.processStill(markedStill(640, 480), 180).jpeg
        // APP1 "Exif" segment must not exist.
        val s = String(jpeg, Charsets.ISO_8859_1)
        assertTrue(!s.contains("Exif\u0000\u0000"))
    }

    @Test
    fun `derive play and thumb at exact sizes with the same orientation`() {
        val full = pipeline.processStill(markedStill(3264, 2448), 0).jpeg
        val play = ImageIoCodec.read(pipeline.derive(full, StillPipeline.PLAY))
        assertEquals(1440, play.width)
        assertEquals(1080, play.height)
        assertMarks(play, RED, BLUE)
        val thumb = ImageIoCodec.read(pipeline.derive(full, StillPipeline.THUMB))
        assertEquals(256, thumb.width)
        assertEquals(192, thumb.height)
        assertMarks(thumb, RED, BLUE)
    }

    @Test
    fun `jpeg size is read from the header`() {
        assertEquals(Size(640, 480), JpegSize.read(markedStill(640, 480).jpeg))
        assertEquals(null, JpegSize.read(byteArrayOf(1, 2, 3)))
    }
}
