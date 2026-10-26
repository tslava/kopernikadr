package pl.slava.kopernikadr.camera.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GeometryTest {
    private val eps = 1e-9

    private fun assertPoint(x: Double, y: Double, p: PointD) {
        assertEquals("x of $p", x, p.x, eps)
        assertEquals("y of $p", y, p.y, eps)
    }

    // ---- Size ----

    @Test
    fun `size orientation and exact 4 by 3`() {
        assertTrue(Size(3264, 2448).isLandscape)
        assertTrue(Size(3264, 2448).isExact4by3)
        assertTrue(Size(192, 144).isExact4by3)
        assertFalse(Size(4080, 3072).isExact4by3) // 1.328, not 4:3
        assertFalse(Size(1440, 1088).isExact4by3)
        assertFalse(Size(2448, 3264).isExact4by3) // portrait is not landscape 4:3
        assertFalse(Size(3072, 3072).isLandscape)
        assertEquals(3264L * 2448L, Size(3264, 2448).area)
    }

    @Test
    fun `size landscape normalizes portrait only`() {
        assertEquals(Size(3264, 2448), Size(2448, 3264).landscape())
        assertEquals(Size(1920, 1080), Size(1920, 1080).landscape())
        assertEquals(Size(100, 100), Size(100, 100).landscape())
    }

    @Test
    fun `size rejects non-positive dimensions`() {
        assertThrows(IllegalArgumentException::class.java) { Size(0, 10) }
        assertThrows(IllegalArgumentException::class.java) { Size(10, -1) }
    }

    @Test
    fun `size toString is WxH`() {
        assertEquals("1280x960", Size(1280, 960).toString())
    }

    // ---- IntRect ----

    @Test
    fun `rect width height and size`() {
        val r = IntRect(10, 20, 110, 95)
        assertEquals(100, r.width)
        assertEquals(75, r.height)
        assertEquals(Size(100, 75), r.size)
        assertFalse(r.isEmpty)
        assertTrue(IntRect(5, 5, 5, 9).isEmpty)
    }

    @Test
    fun `rect of size and containment`() {
        val buf = IntRect.of(Size(640, 480))
        assertEquals(IntRect(0, 0, 640, 480), buf)
        assertTrue(buf.contains(IntRect(0, 0, 640, 480)))
        assertTrue(buf.contains(IntRect(10, 10, 20, 20)))
        assertFalse(buf.contains(IntRect(-1, 0, 640, 480)))
        assertFalse(buf.contains(IntRect(0, 0, 641, 480)))
    }

    @Test
    fun `rect rejects inverted edges`() {
        assertThrows(IllegalArgumentException::class.java) { IntRect(10, 0, 9, 5) }
        assertThrows(IllegalArgumentException::class.java) { IntRect(0, 10, 5, 9) }
    }

    @Test
    fun `size of an empty rect is an error`() {
        assertThrows(IllegalArgumentException::class.java) { IntRect(0, 0, 0, 5).size }
    }

    // ---- Affine ----

    @Test
    fun `identity, translate, scale apply`() {
        assertPoint(3.0, 4.0, Affine.IDENTITY.apply(3.0, 4.0))
        assertPoint(13.0, 2.0, Affine.translate(10.0, -2.0).apply(3.0, 4.0))
        assertPoint(1.5, 8.0, Affine.scale(0.5, 2.0).apply(3.0, 4.0))
    }

    @Test
    fun `rotations by multiples of 90 are exact`() {
        assertPoint(-3.0, -4.0, Affine.rotate(180).apply(3.0, 4.0))
        assertPoint(-4.0, 3.0, Affine.rotate(90).apply(3.0, 4.0)) // y-down screen coords: clockwise
        assertPoint(4.0, -3.0, Affine.rotate(270).apply(3.0, 4.0))
        assertPoint(4.0, -3.0, Affine.rotate(-90).apply(3.0, 4.0))
        assertEquals(Affine.IDENTITY, Affine.rotate(360))
        assertThrows(IllegalArgumentException::class.java) { Affine.rotate(45) }
    }

    @Test
    fun `then applies this first and the argument second`() {
        val m = Affine.translate(10.0, 0.0).then(Affine.scale(2.0, 2.0))
        assertPoint(26.0, 8.0, m.apply(3.0, 4.0)) // (3+10)*2, 4*2
        val n = Affine.scale(2.0, 2.0).then(Affine.translate(10.0, 0.0))
        assertPoint(16.0, 8.0, n.apply(3.0, 4.0)) // 3*2+10, 4*2
    }

    @Test
    fun `compose is associative on points`() {
        val a = Affine.translate(-5.0, 7.0)
        val b = Affine.rotate(180)
        val c = Affine.scale(0.25, 0.25)
        val p = PointD(12.0, -3.0)
        assertPoint(
            c.apply(b.apply(a.apply(p))).x, c.apply(b.apply(a.apply(p))).y,
            a.then(b).then(c).apply(p),
        )
        assertPoint(c.apply(b.apply(a.apply(p))).x, c.apply(b.apply(a.apply(p))).y, a.then(b.then(c)).apply(p))
    }

    @Test
    fun `inverse round-trips`() {
        val m = Affine.translate(-8.0, -6.0).then(Affine.rotate(180)).then(Affine.translate(4064.0, 3048.0))
            .then(Affine.scale(1440.0 / 4064.0, 1080.0 / 3048.0))
        val inv = m.inverse()
        val p = PointD(123.5, 456.25)
        val back = inv.apply(m.apply(p))
        assertPoint(p.x, p.y, back)
        assertTrue(m.then(inv).isApprox(Affine.IDENTITY))
    }

    @Test
    fun `inverse of a singular matrix fails`() {
        assertThrows(IllegalStateException::class.java) { Affine.scale(0.0, 1.0).inverse() }
    }

    @Test
    fun `matrix values follow android Matrix order`() {
        val m = Affine(a = 1.0, b = 2.0, tx = 3.0, c = 4.0, d = 5.0, ty = 6.0)
        assertArrayEquals(floatArrayOf(1f, 2f, 3f, 4f, 5f, 6f, 0f, 0f, 1f), m.toMatrixValues(), 0f)
        assertPoint(1.0 * 7 + 2.0 * 8 + 3, 4.0 * 7 + 5.0 * 8 + 6, m.apply(7.0, 8.0))
    }
}
