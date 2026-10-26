package pl.slava.kopernikadr.camera.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameTransformTest {
    private val eps = 1e-9
    private val still = Size(3264, 2448)
    private val stillCrop = IntRect.of(still)

    private fun assertPoint(x: Double, y: Double, p: PointD) {
        assertEquals("x of $p", x, p.x, eps)
        assertEquals("y of $p", y, p.y, eps)
    }

    // ---- rotation combinations ----

    @Test
    fun `all rotation combinations give landscape exact 4 by 3 output and no 90 degree turn`() {
        for (bufRot in listOf(0, 180)) for (projRot in listOf(0, 180)) {
            val t = FrameTransform.compute(still, stillCrop, bufRot, projRot)
            val total = (bufRot + projRot) % 360
            assertEquals(total, t.rotationDegrees)
            assertEquals(still, t.outputSize)
            assertTrue(t.outputSize.isLandscape)
            assertTrue(t.outputSize.isExact4by3)
            // no 90-degree component: off-diagonal terms are zero
            assertEquals(0.0, t.matrix.b, 0.0)
            assertEquals(0.0, t.matrix.c, 0.0)
        }
    }

    @Test
    fun `total rotation 0 on a full crop is the identity`() {
        assertTrue(FrameTransform.compute(still, stillCrop, 0, 0).matrix.isApprox(Affine.IDENTITY))
        assertTrue(FrameTransform.compute(still, stillCrop, 180, 180).matrix.isApprox(Affine.IDENTITY))
    }

    @Test
    fun `total rotation 180 maps corners to opposite corners`() {
        for ((bufRot, projRot) in listOf(0 to 180, 180 to 0)) {
            val m = FrameTransform.compute(still, stillCrop, bufRot, projRot).matrix
            assertPoint(3264.0, 2448.0, m.apply(0.0, 0.0))
            assertPoint(0.0, 0.0, m.apply(3264.0, 2448.0))
            assertPoint(0.0, 2448.0, m.apply(3264.0, 0.0))
            // pixel centres: first pixel -> last pixel
            assertPoint(3263.5, 2447.5, m.apply(0.5, 0.5))
            assertPoint(1632.0, 1224.0, m.apply(1632.0, 1224.0))
        }
    }

    // ---- crop ----

    @Test
    fun `exact 4 by 3 crop with offset is translated to the origin`() {
        val crop = IntRect(8, 6, 4072, 3054) // 4064x3048
        val t = FrameTransform.compute(Size(4080, 3072), crop, 0, 0)
        assertEquals(crop, t.cropRect)
        assertEquals(Size(4064, 3048), t.outputSize)
        assertPoint(0.0, 0.0, t.matrix.apply(8.0, 6.0))
        assertPoint(4064.0, 3048.0, t.matrix.apply(4072.0, 3054.0))
    }

    @Test
    fun `exact 4 by 3 crop with offset rotated 180`() {
        val crop = IntRect(8, 6, 4072, 3054)
        val m = FrameTransform.compute(Size(4080, 3072), crop, 180, 0).matrix
        assertPoint(4064.0, 3048.0, m.apply(8.0, 6.0))
        assertPoint(0.0, 0.0, m.apply(4072.0, 3054.0))
    }

    @Test
    fun `non 4 by 3 crop is center-cropped to the largest exact 4 by 3 inside`() {
        // 4080x3072 is not 4:3: k = min(4080/4, 3072/3) = 1020 -> 4080x3060, 6 rows off top and bottom
        val t = FrameTransform.compute(Size(4080, 3072), IntRect(0, 0, 4080, 3072), 0, 0)
        assertEquals(IntRect(0, 6, 4080, 3066), t.cropRect)
        assertEquals(Size(4080, 3060), t.outputSize)
        assertPoint(0.0, 0.0, t.matrix.apply(0.0, 6.0))
    }

    @Test
    fun `odd leftovers are split with the extra pixel on the right or bottom`() {
        // 1283x962: k = min(320, 320) = 320 -> 1280x960; leftovers 3 and 2 -> left +1, top +1
        assertEquals(IntRect(1, 1, 1281, 961), FrameTransform.centerCrop4by3(IntRect(0, 0, 1283, 962)))
        // 1281x961: leftovers 1 and 1 -> floor(1/2) = 0 on the left/top, the odd pixel is dropped right/bottom
        assertEquals(IntRect(0, 0, 1280, 960), FrameTransform.centerCrop4by3(IntRect(0, 0, 1281, 961)))
        // offset rect keeps its origin
        assertEquals(IntRect(11, 21, 1291, 981), FrameTransform.centerCrop4by3(IntRect(10, 20, 1293, 982)))
        // already exact: unchanged
        assertEquals(IntRect(3, 4, 643, 484), FrameTransform.centerCrop4by3(IntRect(3, 4, 643, 484)))
    }

    @Test
    fun `wide crop loses width, tall-ish crop loses height`() {
        // 1920x1088: k = min(480, 362) = 362 -> 1448x1086, left (472/2)=236, top (2/2)=1
        assertEquals(IntRect(236, 1, 1684, 1087), FrameTransform.centerCrop4by3(IntRect(0, 0, 1920, 1088)))
        // 1000x999: k = min(250, 333) = 250 -> 1000x750, top (249/2)=124
        assertEquals(IntRect(0, 124, 1000, 874), FrameTransform.centerCrop4by3(IntRect(0, 0, 1000, 999)))
    }

    @Test
    fun `odd crop output is exactly 4 by 3 for every rotation`() {
        for (bufRot in listOf(0, 180)) for (projRot in listOf(0, 180)) {
            val t = FrameTransform.compute(Size(1283, 963), IntRect(1, 0, 1283, 963), bufRot, projRot)
            assertEquals(Size(1280, 960), t.outputSize)
            assertTrue(t.outputSize.isExact4by3)
        }
    }

    @Test
    fun `crop too small for a 4 by 3 is rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            FrameTransform.compute(Size(100, 100), IntRect(0, 0, 3, 2), 0, 0)
        }
    }

    // ---- scaling ----

    @Test
    fun `analysis frame scaled to preview widths`() {
        val buf = Size(1280, 960)
        for ((w, h) in listOf(640 to 480, 960 to 720, 1280 to 960)) {
            val t = FrameTransform.compute(buf, IntRect.of(buf), 0, 0, FrameTransform.size4by3ForWidth(w))
            assertEquals(Size(w, h), t.outputSize)
            assertPoint(w.toDouble(), h.toDouble(), t.matrix.apply(1280.0, 960.0))
            assertPoint(w / 2.0, h / 2.0, t.matrix.apply(640.0, 480.0))
        }
    }

    @Test
    fun `still scaled to play and thumb with rotation 180`() {
        for (target in listOf(Size(1440, 1080), Size(256, 192))) {
            val t = FrameTransform.compute(still, stillCrop, 180, 0, target)
            assertEquals(target, t.outputSize)
            assertPoint(target.width.toDouble(), target.height.toDouble(), t.matrix.apply(0.0, 0.0))
            assertPoint(0.0, 0.0, t.matrix.apply(3264.0, 2448.0))
            assertEquals(t.matrix.a, t.matrix.d, eps) // uniform scale, no stretch
            assertTrue(t.matrix.a < 0) // 180: both axes flipped
        }
    }

    @Test
    fun `scale applies after the 4 by 3 center-crop`() {
        val t = FrameTransform.compute(Size(4080, 3072), IntRect.of(Size(4080, 3072)), 0, 0, Size(1440, 1080))
        assertEquals(IntRect(0, 6, 4080, 3066), t.cropRect)
        assertPoint(0.0, 0.0, t.matrix.apply(0.0, 6.0))
        assertPoint(1440.0, 1080.0, t.matrix.apply(4080.0, 3066.0))
    }

    @Test
    fun `inverse maps output corners back to the crop`() {
        val crop = IntRect(8, 6, 4072, 3054)
        val t = FrameTransform.compute(Size(4080, 3072), crop, 180, 0, Size(1440, 1080))
        val inv = t.matrix.inverse()
        assertPoint(4072.0, 3054.0, inv.apply(0.0, 0.0))
        assertPoint(8.0, 6.0, inv.apply(1440.0, 1080.0))
    }

    @Test
    fun `target must be landscape exact 4 by 3`() {
        assertThrows(IllegalArgumentException::class.java) {
            FrameTransform.compute(still, stillCrop, 0, 0, Size(1920, 1080))
        }
        assertThrows(IllegalArgumentException::class.java) {
            FrameTransform.compute(still, stillCrop, 0, 0, Size(1080, 1440))
        }
    }

    @Test
    fun `size4by3ForWidth`() {
        assertEquals(Size(640, 480), FrameTransform.size4by3ForWidth(640))
        assertEquals(Size(960, 720), FrameTransform.size4by3ForWidth(960))
        assertEquals(Size(1280, 960), FrameTransform.size4by3ForWidth(1280))
        assertEquals(Size(1440, 1080), FrameTransform.size4by3ForWidth(1440))
        assertEquals(Size(256, 192), FrameTransform.size4by3ForWidth(256))
        assertEquals(Size(3264, 2448), FrameTransform.size4by3ForWidth(3264))
        assertThrows(IllegalArgumentException::class.java) { FrameTransform.size4by3ForWidth(642) }
        assertThrows(IllegalArgumentException::class.java) { FrameTransform.size4by3ForWidth(0) }
    }

    // ---- rejections ----

    @Test
    fun `buffer rotation 90 or 270 is rejected`() {
        for (r in listOf(90, 270, 45, 360, -180)) {
            assertThrows("rotationDegrees=$r", IllegalArgumentException::class.java) {
                FrameTransform.compute(still, stillCrop, r, 0)
            }
        }
    }

    @Test
    fun `project rotation 90 or 270 is rejected`() {
        for (r in listOf(90, 270, 1, 360)) {
            assertThrows("projectRotation=$r", IllegalArgumentException::class.java) {
                FrameTransform.compute(still, stillCrop, 0, r)
            }
        }
    }

    @Test
    fun `crop outside the buffer is rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            FrameTransform.compute(still, IntRect(0, 0, 3265, 2448), 0, 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            FrameTransform.compute(still, IntRect(-4, 0, 3260, 2448), 0, 0)
        }
    }

    @Test
    fun `portrait or square crop is rejected - it would need a 90 degree turn`() {
        assertThrows(IllegalArgumentException::class.java) {
            FrameTransform.compute(Size(2448, 3264), IntRect(0, 0, 2448, 3264), 0, 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            FrameTransform.compute(Size(3072, 3072), IntRect(0, 0, 3072, 3072), 0, 0)
        }
    }
}
