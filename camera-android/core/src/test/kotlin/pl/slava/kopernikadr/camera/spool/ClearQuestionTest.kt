package pl.slava.kopernikadr.camera.spool

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClearQuestionTest {
    @Test
    fun `factors stay in 12 to 29 and the answer is their product`() {
        val rnd = Random(1)
        val seen = mutableSetOf<Pair<Int, Int>>()
        repeat(500) {
            val q = ClearQuestion.random(rnd)
            assertTrue(q.a in 12..29)
            assertTrue(q.b in 12..29)
            assertEquals(q.a * q.b, q.answer)
            seen += q.a to q.b
        }
        assertTrue("a new question every time", seen.size > 50)
    }

    @Test
    fun `only the exact digits are accepted`() {
        val q = ClearQuestion(23, 17)
        assertTrue(q.accepts("391"))
        assertTrue(q.accepts(" 391 "))
        for (bad in listOf("", "390", "39", "3910", "391x", "0x187", "391.0", "-391", "+391", "٣٩١", "0000000391")) {
            assertFalse(bad, q.accepts(bad))
        }
    }
}
