package pl.slava.kopernikadr.camera.diag

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

class MetricsTest {
    // ---- centre stats ----

    @Test
    fun centreStatsUseOnlyTheCentreHalf() {
        // 8x8: centre region is x,y in 2..5; paint it, leave the border black.
        val img = RgbImage(8, 8)
        for (y in 0 until 8) for (x in 0 until 8) {
            img.argb[y * 8 + x] = if (x in 2..5 && y in 2..5) argb(200, 100, 50) else argb(0, 0, 0)
        }
        val s = Metrics.centreStats(img)
        assertEquals(200.0, s.meanR, 1e-9)
        assertEquals(100.0, s.meanG, 1e-9)
        assertEquals(50.0, s.meanB, 1e-9)
        assertEquals(0.299 * 200 + 0.587 * 100 + 0.114 * 50, s.meanLuma, 1e-3)
    }

    @Test
    fun centreStatsAverageMixedPixels() {
        val img = RgbImage(4, 4) // centre = (1..2, 1..2)
        img.argb[1 * 4 + 1] = argb(100, 0, 0)
        img.argb[1 * 4 + 2] = argb(0, 100, 0)
        img.argb[2 * 4 + 1] = argb(0, 0, 100)
        img.argb[2 * 4 + 2] = argb(100, 100, 100)
        val s = Metrics.centreStats(img)
        assertEquals(50.0, s.meanR, 1e-9)
        assertEquals(50.0, s.meanG, 1e-9)
        assertEquals(50.0, s.meanB, 1e-9)
        assertEquals(50.0, s.meanLuma, 1e-3)
        assertEquals(s.meanLuma, Metrics.centreMeanLuma(img.toGray()), 1e-4)
    }

    // ---- series stats ----

    @Test
    fun segmentStatsUseSampleStddev() {
        val s = Metrics.segmentStats(listOf(1.0, 2.0, 3.0, 4.0))
        assertEquals(4, s.n)
        assertEquals(2.5, s.mean, 1e-12)
        assertEquals(sqrt(5.0 / 3.0), s.stddev, 1e-12)
        assertEquals(0.0, Metrics.segmentStats(listOf(7.0)).stddev, 0.0)
    }

    @Test
    fun stepInSigmaUsesPooledStddev() {
        val a = listOf(10.0, 12.0, 10.0, 12.0)
        val b = listOf(14.0, 16.0, 14.0, 16.0)
        val sigma = sqrt(4.0 / 3.0)
        assertEquals(sigma, Metrics.pooledStddev(Metrics.segmentStats(a), Metrics.segmentStats(b)), 1e-12)
        assertEquals(4.0 / sigma, Metrics.stepInSigma(a, b), 1e-9)
        assertEquals(4.0 / sigma, Metrics.stepInSigma(b, a), 1e-9) // absolute
    }

    @Test
    fun stepInSigmaPoolsUnequalSegments() {
        val a = listOf(0.0, 2.0) // var 2, n 2
        val b = listOf(10.0, 10.0, 13.0, 13.0) // var 3, n 4
        val pooled = sqrt((1 * 2.0 + 3 * 3.0) / 4)
        assertEquals((11.5 - 1.0) / pooled, Metrics.stepInSigma(a, b), 1e-9)
    }

    @Test
    fun stepInSigmaFloorsAZeroSigma() {
        val a = listOf(5.0, 5.0, 5.0)
        val b = listOf(6.0, 6.0, 6.0)
        assertEquals(1.0 / Metrics.DEFAULT_SIGMA_FLOOR, Metrics.stepInSigma(a, b), 1e-12)
        assertEquals(10.0, Metrics.stepInSigma(a, b, sigmaFloor = 0.1), 1e-9)
        // the floor also applies to a tiny non-zero sigma
        assertEquals(1.0 / Metrics.DEFAULT_SIGMA_FLOOR, Metrics.stepInSigma(listOf(5.0, 5.001), listOf(6.0, 6.001)), 1e-9)
        assertEquals(0.0, Metrics.stepInSigma(a, a), 0.0)
    }

    @Test
    fun maxConsecutiveStep() {
        assertEquals(5.0, Metrics.maxConsecutiveStep(listOf(1.0, 3.0, 2.0, 7.0, 6.0)), 0.0)
        assertEquals(0.0, Metrics.maxConsecutiveStep(listOf(1.0)), 0.0)
        assertEquals(0.0, Metrics.maxConsecutiveStep(emptyList()), 0.0)
    }

    // ---- sharpness ----

    private fun checkerboard(size: Int, cell: Int) =
        GrayImage(size, size, FloatArray(size * size) { i -> if (((i % size) / cell + (i / size) / cell) % 2 == 0) 0f else 255f })

    private fun boxBlur(src: GrayImage, r: Int): GrayImage {
        val out = GrayImage(src.width, src.height)
        for (y in 0 until src.height) for (x in 0 until src.width) {
            var s = 0f
            var n = 0
            for (yy in y - r..y + r) for (xx in x - r..x + r) {
                if (xx in 0 until src.width && yy in 0 until src.height) { s += src[xx, yy]; n++ }
            }
            out[x, y] = s / n
        }
        return out
    }

    @Test
    fun laplacianVarianceIsZeroOnFlatAndLinear() {
        assertEquals(0.0, Metrics.laplacianVariance(GrayImage(32, 32, FloatArray(32 * 32) { 77f })), 1e-9)
        val ramp = GrayImage(32, 32, FloatArray(32 * 32) { i -> (i % 32) * 3f + (i / 32) * 2f })
        assertEquals(0.0, Metrics.laplacianVariance(ramp), 1e-6)
    }

    @Test
    fun sharpCheckerboardBeatsBlurred() {
        val sharp = checkerboard(128, 8)
        val blurred = boxBlur(sharp, 2)
        val s = Metrics.sharpness(sharp)
        val b = Metrics.sharpness(blurred)
        assertTrue("sharp=$s blurred=$b", s > 4 * b)
        assertTrue(b > 0)
    }

    @Test
    fun sharpnessLooksOnlyAtTheCentreCrop() {
        // 600x600, edges only in the outer 44-px border; the 512 centre crop is flat.
        val img = GrayImage(600, 600)
        for (y in 0 until 600) for (x in 0 until 600) {
            val inCrop = x in 44 until 556 && y in 44 until 556
            img[x, y] = if (inCrop) 100f else if ((x + y) % 2 == 0) 0f else 255f
        }
        assertEquals(0.0, Metrics.sharpness(img), 1e-9)
        assertTrue(Metrics.sharpness(img, cropSize = 600) > 0)
        // RGB overload crops first, then converts
        val rgb = RgbImage(600, 600, IntArray(600 * 600) { i -> img.data[i].toInt().let { argb(it, it, it) } })
        assertEquals(0.0, Metrics.sharpness(rgb), 1e-6)
    }
}
