package pl.slava.kopernikadr.camera.diag

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class ImagesTest {
    @Test
    fun lumaIsRec601() {
        assertEquals(255.0, luma(255, 255, 255).toDouble(), 1e-3)
        assertEquals(0.0, luma(0, 0, 0).toDouble(), 1e-6)
        assertEquals(0.299 * 255, luma(255, 0, 0).toDouble(), 1e-3)
        assertEquals(0.587 * 255, luma(0, 255, 0).toDouble(), 1e-3)
        assertEquals(0.114 * 255, luma(0, 0, 255).toDouble(), 1e-3)
    }

    @Test
    fun rgbToGrayUsesLuma() {
        val rgb = RgbImage(2, 1, intArrayOf(argb(200, 100, 50), argb(10, 20, 30)))
        val g = rgb.toGray()
        assertEquals(luma(200, 100, 50), g[0, 0], 1e-4f)
        assertEquals(luma(10, 20, 30), g[1, 0], 1e-4f)
    }

    @Test
    fun grayFromBytesHonoursStrideAndUnsigned() {
        val bytes = byteArrayOf(1, 2, 99, 99, 0xFF.toByte(), 4, 99, 99)
        val g = GrayImage.fromBytes(2, 2, bytes, rowStride = 4)
        assertArrayEquals(floatArrayOf(1f, 2f, 255f, 4f), g.data, 0f)
    }

    @Test
    fun downscaleAveragesWholeBlocks() {
        val src = GrayImage(4, 2, floatArrayOf(0f, 2f, 10f, 20f, 4f, 6f, 30f, 40f))
        val d = src.downscale(2, 1)
        assertArrayEquals(floatArrayOf(3f, 25f), d.data, 1e-4f)
    }

    @Test
    fun downscaleWeighsFractionalCoverage() {
        // 3 -> 2: dst0 covers [0,1.5), dst1 covers [1.5,3).
        val d = GrayImage(3, 1, floatArrayOf(0f, 3f, 6f)).downscale(2, 1)
        assertArrayEquals(floatArrayOf(1f, 5f), d.data, 1e-4f)
    }

    @Test
    fun downscaleRgbPerChannel() {
        val src = RgbImage(2, 1, intArrayOf(argb(0, 100, 200), argb(100, 200, 0)))
        val d = src.downscale(1, 1)
        assertEquals(argb(50, 150, 100), d.argb[0])
    }

    @Test
    fun centreCropAndRotate180() {
        val g = GrayImage(4, 4, FloatArray(16) { it.toFloat() })
        assertArrayEquals(floatArrayOf(5f, 6f, 9f, 10f), g.centreCrop(2, 2).data, 0f)
        assertArrayEquals(FloatArray(16) { 15f - it }, g.rotate180().data, 0f)
        val rgb = RgbImage(3, 1, intArrayOf(1, 2, 3))
        assertArrayEquals(intArrayOf(3, 2, 1), rgb.rotate180().argb)
    }
}
