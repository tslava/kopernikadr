package pl.slava.kopernikadr.camera.diag

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Where image B sits relative to image A, in the 320x240 working frame (pixel x has its centre at
 * x, the frame centre is c = (159.5, 119.5)):
 *
 *     B(c.x + scale·(x − c.x) + dx, c.y + scale·(y − c.y) + dy) ≈ A(x, y)
 *
 * i.e. B shows A's content magnified by [scale] about the frame centre, then moved by
 * ([dx], [dy]) working pixels (multiply by imageWidth/320 for the source resolution).
 * [score] is the normalized cross-correlation (−1..1) over the overlap at that transform;
 * [flipScore] is the best score of the same search with B rotated by 180°. [flipped] = the 180°
 * hypothesis wins, i.e. one of the two images is upside down.
 */
data class AlignmentResult(val dx: Int, val dy: Int, val scale: Double, val score: Double, val flipScore: Double) {
    val flipped: Boolean get() = flipScore > score
}

/**
 * Brute-force NCC alignment for the `grid` probe (still vs preview frame).
 *
 * Both images are area-downscaled to 320x240 grayscale (stretched: pass images with the same
 * aspect ratio, i.e. crop first if they differ). The search space is integer shifts ±16 px ×
 * scales 0.95..1.05 in 0.01 steps (scale about the frame centre, bilinear sampling of B), and
 * every candidate is scored by NCC over the overlap only (≥ 25% of the frame).
 *
 * Strategy (coarse-to-fine) — the exhaustive search at 320x240 would be 33²·11 ≈ 12k candidates
 * × 77k pixels ≈ 0.9 G pixel-ops:
 *  1. coarse: the same exhaustive search on a 160x120 copy (shifts ±8 there, all 11 scales):
 *     3179 candidates × ≤19k pixels ≈ 60 M pixel-ops. The 2x box filter also blurs a fine
 *     printed grid, so the large corner fiducials dominate and the grid's periodic aliases are
 *     weak at this level;
 *  2. keep the top [COARSE_KEEP] distinct shift peaks (Chebyshev distance > 2 coarse px apart)
 *     as insurance against a near-tie at the coarse level;
 *  3. fine: at 320x240, around each peak, shifts 2·d ± 2 and scales ± 0.02:
 *     ≤ 3 × 25 × 5 = 375 candidates.
 * Per candidate, B is interpolated horizontally once per (scale, dx) for all rows and reused
 * for every dy; the bilinear weights depend only on (scale, x) since shifts are integers; ΣA and
 * ΣA² over the overlap rectangle come from integral images. The whole thing runs twice: B as is
 * and B rotated 180°.
 */
object Aligner {
    const val WORK_W = 320
    const val WORK_H = 240
    const val MAX_SHIFT = 16
    const val MIN_SCALE_PCT = 95
    const val MAX_SCALE_PCT = 105
    private const val COARSE_KEEP = 3
    private const val MIN_OVERLAP = 0.25

    fun align(a: GrayImage, b: GrayImage): AlignmentResult {
        val wa = a.downscale(WORK_W, WORK_H)
        val wb = b.downscale(WORK_W, WORK_H)
        val straight = search(wa, wb)
        val flip = search(wa, wb.rotate180())
        return AlignmentResult(straight.dx, straight.dy, straight.sPct / 100.0, straight.score, flip.score)
    }

    /** NCC of one candidate transform (working-frame units), e.g. to report a competitor's score. */
    fun score(a: GrayImage, b: GrayImage, dx: Int, dy: Int, scale: Double): Double {
        val level = Level(a.downscale(WORK_W, WORK_H), b.downscale(WORK_W, WORK_H))
        val sp = (scale * 100).roundToInt()
        var best = Double.NaN
        level.scan(sp..sp, dx..dx, dy..dy) { _, _, _, s -> best = s }
        return best
    }

    /**
     * A 50/50 blend of A and B (B mapped through [al], bilinear) in A's size, for eyeballing.
     * Where the transform maps outside B, B counts as black, so A shows at half brightness —
     * the dark band shows how much of A the other image is missing.
     */
    fun overlay(a: RgbImage, b: RgbImage, al: AlignmentResult): RgbImage {
        val out = RgbImage(a.width, a.height)
        val cx = (WORK_W - 1) / 2.0
        val cy = (WORK_H - 1) / 2.0
        val kax = WORK_W.toDouble() / a.width
        val kay = WORK_H.toDouble() / a.height
        val kbx = b.width.toDouble() / WORK_W
        val kby = b.height.toDouble() / WORK_H
        val s = al.scale
        for (y in 0 until a.height) {
            val yw = (y + 0.5) * kay - 0.5
            val yb = (cy + s * (yw - cy) + al.dy + 0.5) * kby - 0.5
            for (x in 0 until a.width) {
                val xw = (x + 0.5) * kax - 0.5
                val xb = (cx + s * (xw - cx) + al.dx + 0.5) * kbx - 0.5
                val ca = a.argb[y * a.width + x]
                var br = 0f
                var bg = 0f
                var bb = 0f
                if (xb >= -0.5 && xb <= b.width - 0.5 && yb >= -0.5 && yb <= b.height - 0.5) {
                    val px = xb.coerceIn(0.0, b.width - 1.0)
                    val py = yb.coerceIn(0.0, b.height - 1.0)
                    val x0 = px.toInt()
                    val y0 = py.toInt()
                    val x1 = min(x0 + 1, b.width - 1)
                    val y1 = min(y0 + 1, b.height - 1)
                    val fx = (px - x0).toFloat()
                    val fy = (py - y0).toFloat()
                    val c00 = b.argb[y0 * b.width + x0]
                    val c10 = b.argb[y0 * b.width + x1]
                    val c01 = b.argb[y1 * b.width + x0]
                    val c11 = b.argb[y1 * b.width + x1]
                    br = bilerp(red(c00), red(c10), red(c01), red(c11), fx, fy)
                    bg = bilerp(green(c00), green(c10), green(c01), green(c11), fx, fy)
                    bb = bilerp(blue(c00), blue(c10), blue(c01), blue(c11), fx, fy)
                }
                out.argb[y * a.width + x] = argb(
                    clampByte((red(ca) + br) / 2f),
                    clampByte((green(ca) + bg) / 2f),
                    clampByte((blue(ca) + bb) / 2f),
                )
            }
        }
        return out
    }

    private fun bilerp(c00: Int, c10: Int, c01: Int, c11: Int, fx: Float, fy: Float): Float {
        val top = c00 + fx * (c10 - c00)
        val bot = c01 + fx * (c11 - c01)
        return top + fy * (bot - top)
    }

    private class Cand(val dx: Int, val dy: Int, val sPct: Int, val score: Double)

    private fun search(wa: GrayImage, wb: GrayImage): Cand {
        val coarse = Level(wa.downscale(WORK_W / 2, WORK_H / 2), wb.downscale(WORK_W / 2, WORK_H / 2))
        val all = ArrayList<Cand>(3200)
        val cs = MAX_SHIFT / 2
        coarse.scan(MIN_SCALE_PCT..MAX_SCALE_PCT, -cs..cs, -cs..cs) { sp, dx, dy, s -> all.add(Cand(dx, dy, sp, s)) }
        all.sortByDescending { it.score }
        val peaks = ArrayList<Cand>(COARSE_KEEP)
        for (c in all) {
            if (peaks.size == COARSE_KEEP) break
            if (peaks.none { max(abs(it.dx - c.dx), abs(it.dy - c.dy)) <= 2 }) peaks.add(c)
        }

        val fine = Level(wa, wb)
        var best = Cand(0, 0, 100, Double.NEGATIVE_INFINITY)
        for (p in peaks) {
            val sp = max(MIN_SCALE_PCT, p.sPct - 2)..min(MAX_SCALE_PCT, p.sPct + 2)
            val dxs = max(-MAX_SHIFT, 2 * p.dx - 2)..min(MAX_SHIFT, 2 * p.dx + 2)
            val dys = max(-MAX_SHIFT, 2 * p.dy - 2)..min(MAX_SHIFT, 2 * p.dy + 2)
            fine.scan(sp, dxs, dys) { s, dx, dy, score -> if (score > best.score) best = Cand(dx, dy, s, score) }
        }
        return best
    }

    /** One pyramid level: A, B of equal size, plus integral images of A and A². */
    private class Level(val a: GrayImage, val b: GrayImage) {
        val w = a.width
        val h = a.height
        private val ia = DoubleArray((w + 1) * (h + 1))
        private val iaa = DoubleArray((w + 1) * (h + 1))

        init {
            require(b.width == w && b.height == h)
            for (y in 0 until h) {
                var rs = 0.0
                var rss = 0.0
                for (x in 0 until w) {
                    val v = a.data[y * w + x].toDouble()
                    rs += v
                    rss += v * v
                    val i = (y + 1) * (w + 1) + x + 1
                    ia[i] = ia[i - (w + 1)] + rs
                    iaa[i] = iaa[i - (w + 1)] + rss
                }
            }
        }

        /** Sum over x in [x0, x1], y in [y0, y1] (inclusive). */
        private fun rect(t: DoubleArray, x0: Int, y0: Int, x1: Int, y1: Int): Double {
            val s = w + 1
            return t[(y1 + 1) * s + x1 + 1] - t[y0 * s + x1 + 1] - t[(y1 + 1) * s + x0] + t[y0 * s + x0]
        }

        /** Calls [sink] with the NCC of every (scale %, dx, dy) whose overlap is large enough. */
        inline fun scan(scales: IntRange, dxs: IntRange, dys: IntRange, sink: (Int, Int, Int, Double) -> Unit) {
            val cx = (w - 1) / 2.0
            val cy = (h - 1) / 2.0
            val ix = IntArray(w)
            val fx = FloatArray(w)
            val iy = IntArray(h)
            val fy = FloatArray(h)
            val hb = FloatArray(w * h)
            val ad = a.data
            val bd = b.data
            val minN = (w * h * MIN_OVERLAP).toInt()
            for (sp in scales) {
                val s = sp / 100.0
                for (x in 0 until w) {
                    val m = cx + s * (x - cx)
                    val f = floor(m)
                    ix[x] = f.toInt()
                    fx[x] = (m - f).toFloat()
                }
                for (y in 0 until h) {
                    val m = cy + s * (y - cy)
                    val f = floor(m)
                    iy[y] = f.toInt()
                    fy[y] = (m - f).toFloat()
                }
                for (dx in dxs) {
                    // valid x: both bilinear taps inside B, i.e. 0 <= ix + dx <= w - 2 (ix is monotonic)
                    var x0 = 0
                    while (x0 < w && ix[x0] + dx < 0) x0++
                    var x1 = w - 1
                    while (x1 >= x0 && ix[x1] + dx > w - 2) x1--
                    if (x1 < x0) continue
                    for (r in 0 until h) {
                        val rb = r * w
                        for (x in x0..x1) {
                            val j = rb + ix[x] + dx
                            val p = bd[j]
                            hb[rb + x] = p + fx[x] * (bd[j + 1] - p)
                        }
                    }
                    for (dy in dys) {
                        var y0 = 0
                        while (y0 < h && iy[y0] + dy < 0) y0++
                        var y1 = h - 1
                        while (y1 >= y0 && iy[y1] + dy > h - 2) y1--
                        if (y1 < y0) continue
                        val n = (x1 - x0 + 1) * (y1 - y0 + 1)
                        if (n < minN) continue
                        var sb = 0.0
                        var sbb = 0.0
                        var sab = 0.0
                        for (y in y0..y1) {
                            val r0 = (iy[y] + dy) * w
                            val r1 = r0 + w
                            val f = fy[y]
                            val ar = y * w
                            for (x in x0..x1) {
                                val t = hb[r0 + x]
                                val v = t + f * (hb[r1 + x] - t)
                                sb += v
                                sbb += v * v
                                sab += ad[ar + x] * v
                            }
                        }
                        val sa = rect(ia, x0, y0, x1, y1)
                        val saa = rect(iaa, x0, y0, x1, y1)
                        val va = saa - sa * sa / n
                        val vb = sbb - sb * sb / n
                        val cov = sab - sa * sb / n
                        val score = if (va <= 1e-6 * n || vb <= 1e-6 * n) 0.0 else cov / sqrt(va * vb)
                        sink(sp, dx, dy, score)
                    }
                }
            }
        }
    }
}
