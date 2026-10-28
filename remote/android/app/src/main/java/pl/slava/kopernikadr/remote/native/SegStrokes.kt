package pl.slava.kopernikadr.remote.native

/** One brush stroke over the image: [erase] removes from the cut-out, otherwise adds. Points are normalized (0..1). */
class SegStroke(val erase: Boolean, val points: List<Pair<Float, Float>>)

/**
 * Validation of `segRun`'s `strokes` argument (a list of `{mode: 'add'|'erase', points: [[x, y], ...]}`
 * already turned into plain lists and maps by the plugin). Everything wrong is `BAD_ARGUMENT`.
 */
object SegStrokes {
    const val MAX_STROKES = 50
    const val MAX_POINTS = 2000

    fun parse(raw: Any?): List<SegStroke> {
        val list = raw as? List<*> ?: bad("'strokes' must be an array")
        if (list.isEmpty() || list.size > MAX_STROKES) bad("'strokes' needs 1..$MAX_STROKES strokes, got ${list.size}")
        return list.mapIndexed { i, s -> stroke(i, s) }
    }

    private fun stroke(i: Int, raw: Any?): SegStroke {
        val m = raw as? Map<*, *> ?: bad("stroke $i must be an object")
        val erase = when (m["mode"]) {
            "add" -> false
            "erase" -> true
            else -> bad("stroke $i: mode must be 'add' or 'erase'")
        }
        val pts = m["points"] as? List<*> ?: bad("stroke $i: 'points' must be an array")
        if (pts.isEmpty() || pts.size > MAX_POINTS) bad("stroke $i needs 1..$MAX_POINTS points, got ${pts.size}")
        return SegStroke(erase, pts.map { point(i, it) })
    }

    private fun point(i: Int, raw: Any?): Pair<Float, Float> {
        val p = raw as? List<*> ?: bad("stroke $i: a point must be [x, y]")
        if (p.size != 2) bad("stroke $i: a point must be [x, y]")
        val x = coord(i, p[0])
        val y = coord(i, p[1])
        return x to y
    }

    private fun coord(i: Int, v: Any?): Float {
        val d = (v as? Number)?.toDouble() ?: bad("stroke $i: coordinates must be numbers")
        if (d.isNaN() || d < 0.0 || d > 1.0) bad("stroke $i: coordinates must be within 0..1")
        return d.toFloat()
    }

    private fun bad(message: String): Nothing = raise(NativeErrorCode.BAD_ARGUMENT, message)
}
