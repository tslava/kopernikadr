package pl.slava.kopernikadr.camera.diag

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/** Means over the centre 50% (x in w/4 until 3w/4, y in h/4 until 3h/4). Luma is Rec.601, see [luma]. */
data class CentreStats(val meanLuma: Double, val meanR: Double, val meanG: Double, val meanB: Double)

/** Mean and sample (n-1) standard deviation of one segment of a series; stddev is 0 for n < 2. */
data class SegmentStats(val n: Int, val mean: Double, val stddev: Double)

/** Probe metrics: exposure/colour stability (`locks`), sharpness (`focus`). Alignment is [Aligner]. */
object Metrics {
    /**
     * Lower bound for the pooled stddev in [stepInSigma], in the metric's own units. With a
     * frozen exposure the per-still centre means can be identical (σ = 0), and the step would be
     * infinite or blow up on noise. 0.5 is half an 8-bit level: for luma/R/G/B means any step is
     * then at least measured against half a level. Pass another floor for other units.
     */
    const val DEFAULT_SIGMA_FLOOR = 0.5

    const val SHARPNESS_CROP = 512

    // ---- centre stats ----

    private fun centreRange(n: Int): IntRange {
        val r = n / 4 until (3 * n) / 4
        return if (r.isEmpty()) 0 until n else r
    }

    fun centreStats(img: RgbImage): CentreStats {
        var r = 0L
        var g = 0L
        var b = 0L
        var n = 0L
        for (y in centreRange(img.height)) {
            val row = y * img.width
            for (x in centreRange(img.width)) {
                val c = img.argb[row + x]
                r += red(c)
                g += green(c)
                b += blue(c)
                n++
            }
        }
        val mr = r.toDouble() / n
        val mg = g.toDouble() / n
        val mb = b.toDouble() / n
        // luma is linear in R/G/B, so the mean luma is the luma of the means.
        return CentreStats(0.299 * mr + 0.587 * mg + 0.114 * mb, mr, mg, mb)
    }

    /** Mean of a grayscale (e.g. Y plane) image over the same centre 50%. */
    fun centreMeanLuma(img: GrayImage): Double {
        var s = 0.0
        var n = 0
        for (y in centreRange(img.height)) {
            val row = y * img.width
            for (x in centreRange(img.width)) {
                s += img.data[row + x]
                n++
            }
        }
        return s / n
    }

    // ---- series stats ----

    fun segmentStats(values: List<Double>): SegmentStats {
        require(values.isNotEmpty()) { "empty segment" }
        val mean = values.sum() / values.size
        if (values.size < 2) return SegmentStats(values.size, mean, 0.0)
        val ss = values.sumOf { (it - mean) * (it - mean) }
        return SegmentStats(values.size, mean, sqrt(ss / (values.size - 1)))
    }

    /** sqrt(((na-1)·sa² + (nb-1)·sb²) / (na+nb-2)); 0 when there are no degrees of freedom. */
    fun pooledStddev(a: SegmentStats, b: SegmentStats): Double {
        val dof = a.n + b.n - 2
        if (dof <= 0) return 0.0
        val ss = (a.n - 1) * a.stddev * a.stddev + (b.n - 1) * b.stddev * b.stddev
        return sqrt(ss / dof)
    }

    /** |mean(B) − mean(A)| / max(pooled within-segment stddev, [sigmaFloor]). */
    fun stepInSigma(a: SegmentStats, b: SegmentStats, sigmaFloor: Double = DEFAULT_SIGMA_FLOOR): Double {
        require(sigmaFloor > 0) { "sigmaFloor must be > 0" }
        return abs(b.mean - a.mean) / max(pooledStddev(a, b), sigmaFloor)
    }

    fun stepInSigma(a: List<Double>, b: List<Double>, sigmaFloor: Double = DEFAULT_SIGMA_FLOOR): Double =
        stepInSigma(segmentStats(a), segmentStats(b), sigmaFloor)

    /** Largest |x[i+1] − x[i]| in a series (0 for fewer than two values). */
    fun maxConsecutiveStep(values: List<Double>): Double {
        var m = 0.0
        for (i in 1 until values.size) m = max(m, abs(values[i] - values[i - 1]))
        return m
    }

    // ---- sharpness ----

    /**
     * Population variance of the 4-neighbour Laplacian (4c − n − s − e − w) over interior pixels.
     * 0 for flat or linear images; higher means more fine detail / sharper focus.
     */
    fun laplacianVariance(img: GrayImage): Double {
        val w = img.width
        val h = img.height
        if (w < 3 || h < 3) return 0.0
        val d = img.data
        var s = 0.0
        var ss = 0.0
        for (y in 1 until h - 1) {
            val row = y * w
            for (x in 1 until w - 1) {
                val i = row + x
                val l = (4 * d[i] - d[i - 1] - d[i + 1] - d[i - w] - d[i + w]).toDouble()
                s += l
                ss += l * l
            }
        }
        val n = ((w - 2) * (h - 2)).toDouble()
        val mean = s / n
        return max(0.0, ss / n - mean * mean)
    }

    /**
     * Focus measure: [laplacianVariance] on the centred [cropSize]² crop at **native** resolution
     * (downscaling would average away exactly the detail being measured); the whole image if it
     * is smaller. Compare values only between stills of the same scene and size.
     */
    fun sharpness(img: GrayImage, cropSize: Int = SHARPNESS_CROP): Double = laplacianVariance(img.centreCrop(cropSize))

    /** Crops first, then converts to Rec.601 luma, so a full still is not converted whole. */
    fun sharpness(img: RgbImage, cropSize: Int = SHARPNESS_CROP): Double = laplacianVariance(img.centreCrop(cropSize).toGray())
}
