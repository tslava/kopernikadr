package pl.slava.kopernikadr.camera.diag

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.hypot

/**
 * Synthetic scenes are continuous functions over the 320x240 working frame (pixel x has its centre
 * at x, so the frame centre is (159.5, 119.5)). Images are rendered at any resolution with 4x4
 * supersampling; B is rendered through the inverse of the transform Aligner reports:
 * B(cx + s(x - cx) + dx, cy + s(y - cy) + dy) = A(x, y).
 */
class AlignmentTest {
    private val cx = (Aligner.WORK_W - 1) / 2.0
    private val cy = (Aligner.WORK_H - 1) / 2.0

    private fun interface Scene { fun at(x: Double, y: Double): Float }

    private fun render(w: Int, h: Int, scene: Scene): GrayImage {
        val kx = w.toDouble() / Aligner.WORK_W
        val ky = h.toDouble() / Aligner.WORK_H
        val img = GrayImage(w, h)
        val ss = 4
        for (py in 0 until h) for (px in 0 until w) {
            var sum = 0f
            for (sy in 0 until ss) for (sx in 0 until ss) {
                val x = (px + (sx + 0.5) / ss) / kx - 0.5
                val y = (py + (sy + 0.5) / ss) / ky - 0.5
                sum += scene.at(x, y)
            }
            img[px, py] = sum / (ss * ss)
        }
        return img
    }

    private fun transformed(scene: Scene, dx: Double, dy: Double, s: Double) =
        Scene { xb, yb -> scene.at(cx + (xb - dx - cx) / s, cy + (yb - dy - cy) / s) }

    private fun rotated180(scene: Scene) = Scene { x, y -> scene.at(2 * cx - x, 2 * cy - y) }

    private fun inTriangle(x: Double, y: Double, ax: Double, ay: Double, bx: Double, by: Double, qx: Double, qy: Double): Boolean {
        fun side(x1: Double, y1: Double, x2: Double, y2: Double) = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
        val d1 = side(ax, ay, bx, by)
        val d2 = side(bx, by, qx, qy)
        val d3 = side(qx, qy, ax, ay)
        return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)
    }

    /** Four distinct corner fiducials, like the printed target (square, ring, triangle, cross). */
    private fun fiducial(x: Double, y: Double): Float? = when {
        x in 20.0..60.0 && y in 20.0..55.0 -> 25f // A: filled square, top-left
        hypot(x - 280, y - 40).let { it in 12.0..22.0 } -> 35f // B: ring, top-right
        inTriangle(x, y, 255.0, 220.0, 300.0, 220.0, 290.0, 175.0) -> 20f // C: triangle, bottom-right
        (abs(x - 45) < 4 && abs(y - 195) < 22) || (abs(y - 195) < 4 && abs(x - 45) < 22) -> 30f // D: cross
        else -> null
    }

    private val blobScene = Scene { x, y ->
        fiducial(x, y) ?: when {
            x in 140.0..175.0 && y in 105.0..118.0 -> 90f
            hypot(x - 110, y - 160) < 14 -> 140f
            else -> 200f + 20f * ((x - 160) / 320).toFloat()
        }
    }

    /** A pure periodic grid (period 12) plus the corner fiducials. */
    private val gridScene = Scene { x, y ->
        fiducial(x, y) ?: if (Math.floorMod(x.toInt(), 12) < 2 || Math.floorMod(y.toInt(), 12) < 2) 40f else 210f
    }

    private fun assertRecovered(r: AlignmentResult, dx: Int, dy: Int, s: Double) {
        assertTrue("dx: $r", abs(r.dx - dx) <= 1)
        assertTrue("dy: $r", abs(r.dy - dy) <= 1)
        assertEquals("scale: $r", s, r.scale, 0.0101)
        assertTrue("score: $r", r.score > 0.9)
        assertTrue("flip: $r", r.flipScore < r.score)
        assertFalse(r.flipped)
    }

    @Test
    fun identityAlignsPerfectly() {
        val a = render(320, 240, blobScene)
        val r = Aligner.align(a, a)
        assertEquals(0, r.dx)
        assertEquals(0, r.dy)
        assertEquals(1.0, r.scale, 1e-9)
        assertEquals(1.0, r.score, 1e-6)
        assertTrue(r.flipScore < 0.9)
    }

    @Test
    fun recoversShiftAndZoomAcrossResolutions() {
        // A like a still (bigger), B like a preview frame (smaller, different resolution).
        val a = render(640, 480, blobScene)
        val b = render(480, 360, transformed(blobScene, 7.0, -5.0, 1.03))
        assertRecovered(Aligner.align(a, b), 7, -5, 1.03)
    }

    @Test
    fun recoversShrinkAndLargeShift() {
        val a = render(320, 240, blobScene)
        val b = render(320, 240, transformed(blobScene, -13.0, 11.0, 0.96))
        assertRecovered(Aligner.align(a, b), -13, 11, 0.96)
    }

    @Test
    fun recoversExtremeShift() {
        val a = render(320, 240, blobScene)
        val b = render(320, 240, transformed(blobScene, 16.0, -16.0, 1.05))
        assertRecovered(Aligner.align(a, b), 16, -16, 1.05)
    }

    @Test
    fun periodicGridDoesNotFoolItThanksToFiducials() {
        // Grid alone would also match at dx-12 / dy+12; the corner fiducials pick the true one.
        val a = render(320, 240, gridScene)
        val b = render(320, 240, transformed(gridScene, 5.0, -4.0, 1.0))
        val r = Aligner.align(a, b)
        assertRecovered(r, 5, -4, 1.0)
        // and the alias really is a strong competitor for the grid
        val alias = Aligner.score(a, b, dx = 5 - 12, dy = -4 + 12, scale = 1.0)
        assertTrue("alias=$alias r=$r",alias > 0.3 && alias < r.score - 0.05)
    }

    @Test
    fun rotated180IsDetected() {
        val a = render(640, 480, blobScene)
        val b = render(320, 240, rotated180(transformed(blobScene, 3.0, 2.0, 1.0)))
        val r = Aligner.align(a, b)
        assertTrue("$r", r.flipScore > r.score)
        assertTrue("$r", r.flipScore > 0.9)
        assertTrue(r.flipped)
    }

    @Test
    fun rotated180GridIsDetected() {
        val a = render(320, 240, gridScene)
        val b = render(320, 240, rotated180(gridScene))
        val r = Aligner.align(a, b)
        assertTrue("$r", r.flipScore > r.score)
        assertTrue(r.flipped)
    }

    @Test
    fun timing() {
        // Realistic sizes: a 4:3 still and a 640x480 preview frame. Reported in the test's stdout.
        val a = render(320, 240, blobScene).downscale(320, 240)
        val still = GrayImage(3264, 2448).also { big ->
            for (y in 0 until 2448) for (x in 0 until 3264) big[x, y] = a[x * 320 / 3264, y * 240 / 2448]
        }
        val preview = render(640, 480, transformed(blobScene, 4.0, 3.0, 1.02))
        Aligner.align(still, preview) // warm-up
        val n = 5
        val t0 = System.nanoTime()
        repeat(n) { Aligner.align(still, preview) }
        val perCall = (System.nanoTime() - t0) / n / 1e6
        val ds0 = System.nanoTime()
        repeat(n) { still.downscale(320, 240) }
        val perDownscale = (System.nanoTime() - ds0) / n / 1e6
        println("Aligner.align 3264x2448 vs 640x480: %.1f ms/call (of which still downscale %.1f ms)".format(perCall, perDownscale))
        assertTrue(perCall < 2000)
    }

    // ---- overlay ----

    @Test
    fun overlayBlendsHalfAndHalfInADimensions() {
        val a = RgbImage(64, 48, IntArray(64 * 48) { argb(200, 100, 0) })
        val b = RgbImage(32, 24, IntArray(32 * 24) { argb(0, 100, 200) })
        val o = Aligner.overlay(a, b, AlignmentResult(0, 0, 1.0, 1.0, 0.0))
        assertEquals(64, o.width)
        assertEquals(48, o.height)
        assertTrue(o.argb.all { it == argb(100, 100, 100) })
    }

    @Test
    fun overlayAppliesTheTransformAndDarkensWhereBIsMissing() {
        // B = A content moved right by 10 working px; overlaying with the found transform puts
        // B's left half-white/right-black edge back onto A's.
        val w = Aligner.WORK_W
        val h = Aligner.WORK_H
        val a = RgbImage(w, h, IntArray(w * h) { i -> if (i % w < 160) argb(255, 255, 255) else argb(0, 0, 0) })
        val b = RgbImage(w, h, IntArray(w * h) { i -> if (i % w < 170) argb(255, 255, 255) else argb(0, 0, 0) })
        val o = Aligner.overlay(a, b, AlignmentResult(10, 0, 1.0, 1.0, 0.0))
        assertEquals(argb(255, 255, 255), o.argb[120 * w + 100]) // white over white
        assertEquals(argb(0, 0, 0), o.argb[120 * w + 200]) // black over black
        // x > 309 maps beyond B's right edge: A only, at 50%
        assertEquals(argb(0, 0, 0), o.argb[120 * w + 315])
        val a2 = RgbImage(w, h, IntArray(w * h) { argb(200, 200, 200) })
        val o2 = Aligner.overlay(a2, b, AlignmentResult(10, 0, 1.0, 1.0, 0.0))
        assertEquals(argb(100, 100, 100), o2.argb[120 * w + 315])
        assertEquals(argb(228, 228, 228), o2.argb[120 * w + 100])
    }
}
