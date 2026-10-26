package pl.slava.kopernikadr.camera.controls

/**
 * The Camera2 constant values this package uses, copied from `android.hardware.camera2.
 * CameraMetadata` (same names without the `CONTROL_` prefix where Camera2 has it), so `:core`
 * stays JVM-only and the Android mapper is a plain copy of `CaptureResult` ints.
 */
object Camera2 {
    const val CAPTURE_INTENT_PREVIEW = 1
    const val CAPTURE_INTENT_STILL_CAPTURE = 2

    const val CONTROL_MODE_OFF = 0
    const val CONTROL_MODE_AUTO = 1

    const val AE_MODE_OFF = 0
    const val AE_MODE_ON = 1

    const val AE_STATE_INACTIVE = 0
    const val AE_STATE_SEARCHING = 1
    const val AE_STATE_CONVERGED = 2
    const val AE_STATE_LOCKED = 3
    const val AE_STATE_FLASH_REQUIRED = 4
    const val AE_STATE_PRECAPTURE = 5

    const val AE_ANTIBANDING_MODE_OFF = 0
    const val AE_ANTIBANDING_MODE_50HZ = 1
    const val AE_ANTIBANDING_MODE_60HZ = 2
    const val AE_ANTIBANDING_MODE_AUTO = 3

    const val AWB_MODE_OFF = 0
    const val AWB_MODE_AUTO = 1

    const val AWB_STATE_INACTIVE = 0
    const val AWB_STATE_SEARCHING = 1
    const val AWB_STATE_CONVERGED = 2
    const val AWB_STATE_LOCKED = 3

    const val COLOR_CORRECTION_MODE_TRANSFORM_MATRIX = 0
    const val COLOR_CORRECTION_MODE_FAST = 1
    const val COLOR_CORRECTION_MODE_HIGH_QUALITY = 2

    const val AF_MODE_OFF = 0
    const val AF_MODE_AUTO = 1
    const val AF_MODE_MACRO = 2
    const val AF_MODE_CONTINUOUS_VIDEO = 3
    const val AF_MODE_CONTINUOUS_PICTURE = 4

    const val AF_STATE_INACTIVE = 0
    const val AF_STATE_PASSIVE_SCAN = 1
    const val AF_STATE_PASSIVE_FOCUSED = 2
    const val AF_STATE_ACTIVE_SCAN = 3
    const val AF_STATE_FOCUSED_LOCKED = 4
    const val AF_STATE_NOT_FOCUSED_LOCKED = 5
    const val AF_STATE_PASSIVE_UNFOCUSED = 6

    const val LENS_STATE_STATIONARY = 0
    const val LENS_STATE_MOVING = 1
}

/**
 * The `CaptureRequest` keys of an option set ([ControlsPlan.options]), with the Kotlin type of
 * the value. The adapter maps each to its `CaptureRequest` key in one `when`.
 */
enum class RequestOption {
    /** Int, [Camera2.CONTROL_MODE_AUTO]. */
    CONTROL_MODE,

    /** Int, `AE_MODE_*`. */
    AE_MODE,

    /** Boolean. */
    AE_LOCK,

    /** Int, steps. */
    AE_EXPOSURE_COMPENSATION,

    /** Int, `AE_ANTIBANDING_MODE_*`. */
    AE_ANTIBANDING_MODE,

    /** Int, ISO. */
    SENSOR_SENSITIVITY,

    /** Long, ns. */
    SENSOR_EXPOSURE_TIME,

    /** Long, ns. */
    SENSOR_FRAME_DURATION,

    /** Int, `AWB_MODE_*`. */
    AWB_MODE,

    /** Boolean. */
    AWB_LOCK,

    /** Int, `COLOR_CORRECTION_MODE_*`. */
    COLOR_CORRECTION_MODE,

    /** [ColorGains] → `RggbChannelVector(r, gEven, gOdd, b)`. */
    COLOR_CORRECTION_GAINS,

    /** [ColorTransform] → `ColorSpaceTransform(transform.toRationals())`. */
    COLOR_CORRECTION_TRANSFORM,

    /** Int, `AF_MODE_*`. */
    AF_MODE,

    /** Float, diopters. */
    LENS_FOCUS_DISTANCE,
}
