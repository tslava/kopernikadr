package pl.slava.kopernikadr.camera.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SizeSelectionTest {
    private fun sizes(vararg wh: Pair<Int, Int>) = wh.map { (w, h) -> Size(w, h) }

    /** moto g05 back camera 4:3 stream sizes. */
    private val g05FourByThree = sizes(
        3264 to 2448, 2560 to 1920, 1920 to 1440, 1440 to 1080, 1280 to 960,
        1024 to 768, 960 to 720, 640 to 480, 320 to 240, 192 to 144,
    )

    /** Non-4:3 sizes from the same list (16:9, 1:1, 20:9, near-4:3 1088 variants). */
    private val noise = sizes(
        4080 to 2296, 3840 to 2160, 3072 to 3072, 2400 to 1080, 1920 to 1080, 1440 to 1088, 1920 to 1088,
    )

    private val g05All = (noise.take(3) + g05FourByThree + noise.drop(3)).shuffled(kotlin.random.Random(1))

    // ---- full ----

    @Test
    fun `full picks 3264x2448 from the g05 list`() {
        assertEquals(Size(3264, 2448), SizeSelection.selectFull(g05All))
    }

    @Test
    fun `full ignores larger 4 by 3 sizes`() {
        val list = g05All + sizes(4080 to 3060, 4000 to 3000)
        assertEquals(Size(3264, 2448), SizeSelection.selectFull(list))
    }

    @Test
    fun `full falls back to the next lower 4 by 3`() {
        val list = g05All - Size(3264, 2448)
        assertEquals(Size(2560, 1920), SizeSelection.selectFull(list))
        assertEquals(Size(640, 480), SizeSelection.selectFull(noise + sizes(640 to 480, 320 to 240)))
    }

    @Test
    fun `full picks a non-listed 4 by 3 below the cap`() {
        assertEquals(Size(3200, 2400), SizeSelection.selectFull(noise + sizes(3200 to 2400, 4000 to 3000)))
    }

    @Test
    fun `full normalizes portrait sizes`() {
        assertEquals(Size(3264, 2448), SizeSelection.selectFull(sizes(2448 to 3264, 1080 to 1440)))
    }

    @Test
    fun `full rejects a list without 4 by 3`() {
        val e = assertThrows(NoSuitableSizeException::class.java) { SizeSelection.selectFull(noise) }
        assertTrue(e.message!!.contains("4:3"))
    }

    @Test
    fun `full rejects a list whose only 4 by 3 is above the cap`() {
        assertThrows(NoSuitableSizeException::class.java) {
            SizeSelection.selectFull(noise + sizes(4000 to 3000))
        }
    }

    @Test
    fun `full rejects an empty list`() {
        assertThrows(NoSuitableSizeException::class.java) { SizeSelection.selectFull(emptyList()) }
    }

    @Test
    fun `near 4 by 3 sizes are not 4 by 3`() {
        // 1440x1088 is the classic off-by-8 trap; 4080x3072 is ~4:3 but not exact
        assertThrows(NoSuitableSizeException::class.java) {
            SizeSelection.selectFull(sizes(1440 to 1088, 4080 to 3072, 1920 to 1088))
        }
    }

    // ---- analysis ----

    @Test
    fun `analysis picks 1280x960 from the g05 list`() {
        assertEquals(Size(1280, 960), SizeSelection.selectAnalysis(g05All))
    }

    @Test
    fun `analysis falls back to 960x720 even if 1024x768 exists`() {
        assertEquals(Size(960, 720), SizeSelection.selectAnalysis(g05All - Size(1280, 960)))
    }

    @Test
    fun `analysis then falls back to the largest 4 by 3 at most 1280x960`() {
        val list = g05All - Size(1280, 960) - Size(960, 720)
        assertEquals(Size(1024, 768), SizeSelection.selectAnalysis(list))
        assertEquals(Size(640, 480), SizeSelection.selectAnalysis(noise + sizes(640 to 480, 2560 to 1920)))
    }

    @Test
    fun `analysis normalizes portrait sizes`() {
        assertEquals(Size(1280, 960), SizeSelection.selectAnalysis(sizes(960 to 1280, 720 to 960)))
        assertEquals(Size(960, 720), SizeSelection.selectAnalysis(sizes(720 to 960)))
    }

    @Test
    fun `analysis rejects lists without a suitable 4 by 3`() {
        assertThrows(NoSuitableSizeException::class.java) { SizeSelection.selectAnalysis(emptyList()) }
        assertThrows(NoSuitableSizeException::class.java) { SizeSelection.selectAnalysis(noise) }
        assertThrows(NoSuitableSizeException::class.java) {
            SizeSelection.selectAnalysis(noise + sizes(1440 to 1080, 3264 to 2448))
        }
    }

    @Test
    fun `duplicates do not matter`() {
        val list = sizes(1280 to 960, 960 to 1280, 1280 to 960)
        assertEquals(Size(1280, 960), SizeSelection.selectAnalysis(list))
        assertEquals(Size(1280, 960), SizeSelection.selectFull(list))
    }
}
