package pl.slava.kopernikadr.camera.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json as KJson

/** Closed integer range `[lower, upper]` (Camera2 `Range<Integer>`). */
@Serializable
data class IntSpan(val lower: Int, val upper: Int)

/** Closed long range `[lower, upper]` (Camera2 `Range<Long>`). */
@Serializable
data class LongSpan(val lower: Long, val upper: Long)

/** Camera2 `Rational`. */
@Serializable
data class Ratio(val num: Int, val den: Int)

/**
 * Plain copy of the Camera2 characteristics the `caps` probe dumps and [CapabilityMapper] reads.
 * Enum-valued keys hold the Camera2 constant names without their prefix (`"FULL"`,
 * `"MANUAL_SENSOR"`, `"CONTINUOUS_PICTURE"`, `"50HZ"`); an unknown value is `"UNKNOWN_<n>"`.
 * A key the device does not report is null (or an empty list). Floats stay floats so the JSON
 * shows what the device reported, without double noise.
 */
@Serializable
data class CharacteristicsSnapshot(
    val cameraId: String,
    /**
     * Whether the app held CAMERA when reading. Without it, the keys in [keysNeedingPermission]
     * (e.g. min focus / hyperfocal distance) read as null.
     */
    val cameraPermissionGranted: Boolean? = null,
    /** `getKeysNeedingPermission()` key names (the g05 lists them only while CAMERA is not held). */
    val keysNeedingPermission: List<String> = emptyList(),
    /** `LENS_FACING`: FRONT / BACK / EXTERNAL. */
    val lensFacing: String? = null,
    /** `INFO_SUPPORTED_HARDWARE_LEVEL`: LEGACY / LIMITED / FULL / LEVEL_3 / EXTERNAL. */
    val hardwareLevel: String? = null,
    /** `REQUEST_AVAILABLE_CAPABILITIES`. */
    val capabilities: List<String> = emptyList(),
    /** `CONTROL_AE_AVAILABLE_MODES`. */
    val aeModes: List<String> = emptyList(),
    /** `CONTROL_AE_AVAILABLE_ANTIBANDING_MODES`: OFF / 50HZ / 60HZ / AUTO. */
    val aeAntibandingModes: List<String> = emptyList(),
    /** `CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES`. */
    val aeTargetFpsRanges: List<IntSpan> = emptyList(),
    /** `CONTROL_AWB_AVAILABLE_MODES`. */
    val awbModes: List<String> = emptyList(),
    /** `CONTROL_AF_AVAILABLE_MODES`. */
    val afModes: List<String> = emptyList(),
    /** `CONTROL_AE_LOCK_AVAILABLE`. */
    val aeLockAvailable: Boolean? = null,
    /** `CONTROL_AWB_LOCK_AVAILABLE`. */
    val awbLockAvailable: Boolean? = null,
    /** `CONTROL_AE_COMPENSATION_RANGE`, in steps. */
    val aeCompensationRange: IntSpan? = null,
    /** `CONTROL_AE_COMPENSATION_STEP`, EV per step. */
    val aeCompensationStep: Ratio? = null,
    /** `SENSOR_INFO_SENSITIVITY_RANGE` (ISO). */
    val isoRange: IntSpan? = null,
    /** `SENSOR_INFO_EXPOSURE_TIME_RANGE`, ns. */
    val exposureTimeRangeNs: LongSpan? = null,
    /** `SENSOR_INFO_MAX_FRAME_DURATION`, ns. */
    val maxFrameDurationNs: Long? = null,
    /** `SCALER_STREAM_CONFIGURATION_MAP` output sizes for JPEG. */
    val jpegSizes: List<Size> = emptyList(),
    /** `getHighResolutionOutputSizes(JPEG)`: slow (< 20 fps) sizes, listed for the record only. */
    val jpegHighResolutionSizes: List<Size> = emptyList(),
    /** … for YUV_420_888. */
    val yuvSizes: List<Size> = emptyList(),
    /** … for PRIVATE (`SurfaceTexture`, i.e. Preview). */
    val privateSizes: List<Size> = emptyList(),
    /** `SENSOR_INFO_ACTIVE_ARRAY_SIZE`. */
    val activeArraySize: IntRect? = null,
    /** `SENSOR_INFO_PIXEL_ARRAY_SIZE`. */
    val pixelArraySize: Size? = null,
    /** `SENSOR_ORIENTATION`, degrees. */
    val sensorOrientation: Int? = null,
    /** `LENS_INFO_MINIMUM_FOCUS_DISTANCE`, diopters; 0 = fixed focus; null without CAMERA permission. */
    val minFocusDistanceDiopters: Float? = null,
    /** `LENS_INFO_HYPERFOCAL_DISTANCE`, diopters. */
    val hyperfocalDistanceDiopters: Float? = null,
    /** `LENS_INFO_FOCUS_DISTANCE_CALIBRATION`: UNCALIBRATED / APPROXIMATE / CALIBRATED. */
    val focusDistanceCalibration: String? = null,
    /** `LENS_INFO_AVAILABLE_FOCAL_LENGTHS`, mm. */
    val focalLengthsMm: List<Float> = emptyList(),
    /** `SCALER_AVAILABLE_MAX_DIGITAL_ZOOM`. */
    val maxDigitalZoom: Float? = null,
) {
    val hasManualSensor: Boolean get() = CAP_MANUAL_SENSOR in capabilities
    val hasManualPostProcessing: Boolean get() = CAP_MANUAL_POST_PROCESSING in capabilities
    val hasAutoFocus: Boolean get() = AF_MODE_AUTO in afModes

    companion object {
        const val CAP_BACKWARD_COMPATIBLE = "BACKWARD_COMPATIBLE"
        const val CAP_MANUAL_SENSOR = "MANUAL_SENSOR"
        const val CAP_MANUAL_POST_PROCESSING = "MANUAL_POST_PROCESSING"
        const val AF_MODE_AUTO = "AUTO"

        /** JSON for snapshots in reports and test resources: pretty, nulls written, unknown keys ignored. */
        val Json: KJson = KJson {
            prettyPrint = true
            encodeDefaults = true
            ignoreUnknownKeys = true
        }
    }
}
