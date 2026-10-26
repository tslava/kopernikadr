package pl.slava.kopernikadr.camera.core

import kotlin.math.abs
import kotlinx.serialization.Serializable

/** Pixel dimensions, both > 0. */
@Serializable
data class Size(val width: Int, val height: Int) {
    init {
        require(width > 0 && height > 0) { "size must be positive: ${width}x$height" }
    }

    val area: Long get() = width.toLong() * height

    val isLandscape: Boolean get() = width > height

    /** Exactly 4:3 landscape as an integer ratio (`w*3 == h*4`). */
    val isExact4by3: Boolean get() = width.toLong() * 3 == height.toLong() * 4

    /** The same size with the long side as width. */
    fun landscape(): Size = if (height > width) Size(height, width) else this

    override fun toString(): String = "${width}x$height"
}

/** Integer rectangle, half-open: covers `[left, right) × [top, bottom)`. */
@Serializable
data class IntRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    init {
        require(right >= left && bottom >= top) { "inverted rect: $this" }
    }

    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val isEmpty: Boolean get() = width == 0 || height == 0

    /** Width × height; fails for an empty rect. */
    val size: Size get() = Size(width, height)

    fun contains(other: IntRect): Boolean =
        other.left >= left && other.top >= top && other.right <= right && other.bottom <= bottom

    companion object {
        fun of(size: Size): IntRect = IntRect(0, 0, size.width, size.height)
    }
}

data class PointD(val x: Double, val y: Double)

/**
 * 2D affine transform in continuous pixel coordinates (y down):
 * ```
 * x' = a·x + b·y + tx
 * y' = c·x + d·y + ty
 * ```
 * Parameter order matches `android.graphics.Matrix` values
 * (MSCALE_X, MSKEW_X, MTRANS_X, MSKEW_Y, MSCALE_Y, MTRANS_Y); see [toMatrixValues].
 */
data class Affine(
    val a: Double,
    val b: Double,
    val tx: Double,
    val c: Double,
    val d: Double,
    val ty: Double,
) {
    fun apply(x: Double, y: Double): PointD = PointD(a * x + b * y + tx, c * x + d * y + ty)

    fun apply(p: PointD): PointD = apply(p.x, p.y)

    /** The transform that applies `this` first and then [next]. */
    fun then(next: Affine): Affine = Affine(
        a = next.a * a + next.b * c,
        b = next.a * b + next.b * d,
        tx = next.a * tx + next.b * ty + next.tx,
        c = next.c * a + next.d * c,
        d = next.c * b + next.d * d,
        ty = next.c * tx + next.d * ty + next.ty,
    )

    val determinant: Double get() = a * d - b * c

    /** @throws IllegalStateException if the transform is singular. */
    fun inverse(): Affine {
        val det = determinant
        check(det != 0.0 && det.isFinite()) { "singular transform: $this" }
        val ia = d / det
        val ib = -b / det
        val ic = -c / det
        val id = a / det
        return Affine(ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty))
    }

    fun isApprox(other: Affine, eps: Double = 1e-9): Boolean =
        abs(a - other.a) <= eps && abs(b - other.b) <= eps && abs(tx - other.tx) <= eps &&
            abs(c - other.c) <= eps && abs(d - other.d) <= eps && abs(ty - other.ty) <= eps

    /** 9 values for `android.graphics.Matrix.setValues`. */
    fun toMatrixValues(): FloatArray =
        floatArrayOf(a.toFloat(), b.toFloat(), tx.toFloat(), c.toFloat(), d.toFloat(), ty.toFloat(), 0f, 0f, 1f)

    companion object {
        val IDENTITY = Affine(1.0, 0.0, 0.0, 0.0, 1.0, 0.0)

        fun translate(dx: Double, dy: Double) = Affine(1.0, 0.0, dx, 0.0, 1.0, dy)

        fun scale(sx: Double, sy: Double) = Affine(sx, 0.0, 0.0, 0.0, sy, 0.0)

        /**
         * Rotation about the origin by a multiple of 90° (exact, no float noise). Positive is
         * clockwise on screen (y down), like `android.graphics.Matrix.setRotate`.
         */
        fun rotate(degrees: Int): Affine {
            require(degrees % 90 == 0) { "only multiples of 90 are supported: $degrees" }
            val (cos, sin) = when (Math.floorMod(degrees, 360)) {
                0 -> 1.0 to 0.0
                90 -> 0.0 to 1.0
                180 -> -1.0 to 0.0
                else -> 0.0 to -1.0
            }
            // 0.0 - x instead of -x so a zero term stays +0.0 (keeps data-class equality sane)
            return Affine(cos, 0.0 - sin, 0.0, sin, cos, 0.0)
        }
    }
}
