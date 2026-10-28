package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageLoadSizeTest {
    @Test
    fun scalesTheLongSideDown() {
        assertEquals(1024 to 768, ImageLoad.targetSize(3264, 2448, 1024))
        assertEquals(768 to 1024, ImageLoad.targetSize(2448, 3264, 1024))
        assertEquals(1024 to 1024, ImageLoad.targetSize(4000, 4000, 1024))
    }

    @Test
    fun neverScalesUp() {
        assertEquals(640 to 480, ImageLoad.targetSize(640, 480, 1024))
        assertEquals(1024 to 1, ImageLoad.targetSize(1024, 1, 1024))
    }

    @Test
    fun neverGoesBelowOnePixel() {
        assertEquals(1024 to 1, ImageLoad.targetSize(100000, 10, 1024))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsEmptySizes() {
        ImageLoad.targetSize(0, 10, 1024)
    }

    @Test
    fun alphaBelowTheThresholdCounts() {
        assertFalse(ImageLoad.hasAlpha(intArrayOf(0xFF000000.toInt(), 0xFA112233.toInt())))
        assertTrue(ImageLoad.hasAlpha(intArrayOf(0xFF000000.toInt(), 0xF9112233.toInt())))
        assertFalse(ImageLoad.hasAlpha(intArrayOf()))
    }
}
