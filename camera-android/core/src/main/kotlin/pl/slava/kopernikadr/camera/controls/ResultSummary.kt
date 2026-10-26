package pl.slava.kopernikadr.camera.controls

import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.serialization.Serializable

/** `COLOR_CORRECTION_GAINS` (`RggbChannelVector`: red, greenEven, greenOdd, blue). */
@Serializable
data class ColorGains(val r: Float, val gEven: Float, val gOdd: Float, val b: Float) {
    fun near(o: ColorGains, tolerance: Double): Boolean =
        abs(r - o.r) <= tolerance && abs(gEven - o.gEven) <= tolerance &&
            abs(gOdd - o.gOdd) <= tolerance && abs(b - o.b) <= tolerance
}

/** `COLOR_CORRECTION_TRANSFORM`, the 3×3 matrix row-major as doubles. */
@Serializable
data class ColorTransform(val m: List<Double>) {
    init {
        require(m.size == 9) { "a color transform has 9 elements, got ${m.size}" }
    }

    fun near(o: ColorTransform, tolerance: Double): Boolean = m.indices.all { abs(m[it] - o.m[it]) <= tolerance }

    /**
     * `ColorSpaceTransform(int[])` input: 9 (numerator, denominator) pairs with denominator
     * [den]. A power of two keeps HAL values with a power-of-two denominator ≤ [den] (the usual
     * 1/128, 1/1024) exact; others are within 1/(2·[den]), far below the confirmation tolerance.
     */
    fun toRationals(den: Int = 65_536): IntArray =
        IntArray(18) { i -> if (i % 2 == 0) (m[i / 2] * den).roundToInt() else den }

    companion object {
        /** From `ColorSpaceTransform.getElement(col, row)` rationals as doubles, row-major. */
        fun of(vararg rowMajor: Double) = ColorTransform(rowMajor.toList())
    }
}

/**
 * The fields of a `TotalCaptureResult` the controls read. Ints are the Camera2 constant values
 * ([Camera2]), so the Android mapper is a plain copy; a key the result lacks is null.
 * Also the per-frame / per-still metadata of the camera port (`ResultSummaryMapper` in `:app`).
 */
@Serializable
data class ResultSummary(
    val frameNumber: Long,
    /** `SENSOR_TIMESTAMP`, ns (same clock as `ImageProxy.imageInfo.timestamp`). */
    val timestampNs: Long? = null,
    /** `CONTROL_CAPTURE_INTENT` of the request: [Camera2.CAPTURE_INTENT_PREVIEW] (repeating) or [Camera2.CAPTURE_INTENT_STILL_CAPTURE]. */
    val captureIntent: Int? = null,
    val aeMode: Int? = null,
    val aeState: Int? = null,
    val aeLock: Boolean? = null,
    /** `SENSOR_SENSITIVITY`. */
    val iso: Int? = null,
    val exposureTimeNs: Long? = null,
    val frameDurationNs: Long? = null,
    val awbMode: Int? = null,
    val awbState: Int? = null,
    val awbLock: Boolean? = null,
    /** `COLOR_CORRECTION_MODE`. */
    val ccMode: Int? = null,
    val gains: ColorGains? = null,
    val transform: ColorTransform? = null,
    val afMode: Int? = null,
    val afState: Int? = null,
    val lensState: Int? = null,
    /** `LENS_FOCUS_DISTANCE`, diopters. */
    val focusDistance: Float? = null,
    /** `CONTROL_AE_EXPOSURE_COMPENSATION`, steps. */
    val compensation: Int? = null,
)
