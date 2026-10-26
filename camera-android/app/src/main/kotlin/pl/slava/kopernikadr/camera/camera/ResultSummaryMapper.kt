package pl.slava.kopernikadr.camera.camera

import android.hardware.camera2.CaptureResult
import pl.slava.kopernikadr.camera.controls.ColorGains
import pl.slava.kopernikadr.camera.controls.ColorTransform
import pl.slava.kopernikadr.camera.controls.ResultSummary

/**
 * Camera2 `CaptureResult` → [ResultSummary]. [fromResult] only extracts the keys; the mapping
 * itself ([map]) works on plain values, so it is unit-tested without the Android framework.
 */
object ResultSummaryMapper {
    fun fromResult(r: CaptureResult): ResultSummary = map(
        frameNumber = r.frameNumber,
        captureIntent = r[CaptureResult.CONTROL_CAPTURE_INTENT],
        aeMode = r[CaptureResult.CONTROL_AE_MODE],
        aeState = r[CaptureResult.CONTROL_AE_STATE],
        aeLock = r[CaptureResult.CONTROL_AE_LOCK],
        compensation = r[CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION],
        iso = r[CaptureResult.SENSOR_SENSITIVITY],
        exposureTimeNs = r[CaptureResult.SENSOR_EXPOSURE_TIME],
        frameDurationNs = r[CaptureResult.SENSOR_FRAME_DURATION],
        awbMode = r[CaptureResult.CONTROL_AWB_MODE],
        awbState = r[CaptureResult.CONTROL_AWB_STATE],
        awbLock = r[CaptureResult.CONTROL_AWB_LOCK],
        ccMode = r[CaptureResult.COLOR_CORRECTION_MODE],
        gainsRggb = r[CaptureResult.COLOR_CORRECTION_GAINS]
            ?.let { floatArrayOf(it.red, it.greenEven, it.greenOdd, it.blue) },
        transformRationals = r[CaptureResult.COLOR_CORRECTION_TRANSFORM]
            ?.let { t -> IntArray(TRANSFORM_INTS).also { t.copyElements(it, 0) } },
        afMode = r[CaptureResult.CONTROL_AF_MODE],
        afState = r[CaptureResult.CONTROL_AF_STATE],
        lensState = r[CaptureResult.LENS_STATE],
        focusDistanceDiopters = r[CaptureResult.LENS_FOCUS_DISTANCE],
        sensorTimestampNs = r[CaptureResult.SENSOR_TIMESTAMP],
    )

    /** `ColorSpaceTransform.copyElements`: 9 rationals as numerator, denominator pairs, row-major. */
    const val TRANSFORM_INTS = 18

    /**
     * @param gainsRggb `RggbChannelVector` as `[red, greenEven, greenOdd, blue]`; any other length → null.
     * @param transformRationals 18 ints (numerator, denominator) × 9, row-major; any other length or a
     *   zero denominator → null (never NaN/∞, so the summary always serializes).
     * Times stay in ns and the focus distance in diopters, as Camera2 reports them.
     */
    fun map(
        frameNumber: Long,
        captureIntent: Int? = null,
        aeMode: Int? = null,
        aeState: Int? = null,
        aeLock: Boolean? = null,
        compensation: Int? = null,
        iso: Int? = null,
        exposureTimeNs: Long? = null,
        frameDurationNs: Long? = null,
        awbMode: Int? = null,
        awbState: Int? = null,
        awbLock: Boolean? = null,
        ccMode: Int? = null,
        gainsRggb: FloatArray? = null,
        transformRationals: IntArray? = null,
        afMode: Int? = null,
        afState: Int? = null,
        lensState: Int? = null,
        focusDistanceDiopters: Float? = null,
        sensorTimestampNs: Long? = null,
    ): ResultSummary = ResultSummary(
        frameNumber = frameNumber,
        captureIntent = captureIntent,
        aeMode = aeMode,
        aeState = aeState,
        aeLock = aeLock,
        compensation = compensation,
        iso = iso,
        exposureTimeNs = exposureTimeNs,
        frameDurationNs = frameDurationNs,
        awbMode = awbMode,
        awbState = awbState,
        awbLock = awbLock,
        ccMode = ccMode,
        gains = gainsRggb?.takeIf { it.size == 4 }?.let { ColorGains(r = it[0], gEven = it[1], gOdd = it[2], b = it[3]) },
        transform = transformRationals?.let(::rationalsToDoubles)?.let(::ColorTransform),
        afMode = afMode,
        afState = afState,
        lensState = lensState,
        focusDistance = focusDistanceDiopters,
        timestampNs = sensorTimestampNs,
    )

    private fun rationalsToDoubles(ints: IntArray): List<Double>? {
        if (ints.size != TRANSFORM_INTS) return null
        return List(TRANSFORM_INTS / 2) { i ->
            val num = ints[2 * i]
            val den = ints[2 * i + 1]
            if (den == 0) return null
            num.toDouble() / den
        }
    }
}
