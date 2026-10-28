package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SegStrokesTest {
    private fun stroke(mode: Any? = "add", points: Any? = listOf(listOf(0.5, 0.5))) = mapOf("mode" to mode, "points" to points)

    private fun bad(raw: Any?) = expectCode(NativeErrorCode.BAD_ARGUMENT) { SegStrokes.parse(raw) }

    @Test
    fun parsesAddAndEraseStrokes() {
        val r = SegStrokes.parse(listOf(stroke("add", listOf(listOf(0.25, 0.5), listOf(1, 0))), stroke("erase")))
        assertEquals(2, r.size)
        assertFalse(r[0].erase)
        assertTrue(r[1].erase)
        assertEquals(listOf(0.25f to 0.5f, 1f to 0f), r[0].points)
    }

    @Test
    fun rejectsABadStrokeList() {
        bad(null)
        bad("x")
        bad(emptyList<Any>())
        bad(List(SegStrokes.MAX_STROKES + 1) { stroke() })
        SegStrokes.parse(List(SegStrokes.MAX_STROKES) { stroke() })
    }

    @Test
    fun rejectsABadStroke() {
        bad(listOf("x"))
        bad(listOf(stroke(mode = "lasso")))
        bad(listOf(stroke(mode = null)))
        bad(listOf(stroke(points = null)))
        bad(listOf(stroke(points = emptyList<Any>())))
        bad(listOf(stroke(points = List(SegStrokes.MAX_POINTS + 1) { listOf(0.1, 0.1) })))
        SegStrokes.parse(listOf(stroke(points = List(SegStrokes.MAX_POINTS) { listOf(0.1, 0.1) })))
    }

    @Test
    fun rejectsBadPoints() {
        bad(listOf(stroke(points = listOf(listOf(0.5)))))
        bad(listOf(stroke(points = listOf(listOf(0.5, 0.5, 0.5)))))
        bad(listOf(stroke(points = listOf("a"))))
        bad(listOf(stroke(points = listOf(listOf("a", 0.5)))))
        bad(listOf(stroke(points = listOf(listOf(1.01, 0.5)))))
        bad(listOf(stroke(points = listOf(listOf(0.5, -0.01)))))
        bad(listOf(stroke(points = listOf(listOf(Double.NaN, 0.5)))))
    }
}
