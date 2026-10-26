package pl.slava.kopernikadr.camera.camera

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraCharacteristics.Key
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata as M
import android.hardware.camera2.params.StreamConfigurationMap
import android.util.Range
import pl.slava.kopernikadr.camera.core.CharacteristicsSnapshot
import pl.slava.kopernikadr.camera.core.IntRect
import pl.slava.kopernikadr.camera.core.IntSpan
import pl.slava.kopernikadr.camera.core.LongSpan
import pl.slava.kopernikadr.camera.core.Ratio
import pl.slava.kopernikadr.camera.core.Size
import android.util.Size as ASize

/**
 * Camera2 characteristics → [CharacteristicsSnapshot]. Works without the CAMERA permission, but
 * then the keys of `getKeysNeedingPermission()` (min focus / hyperfocal distance among them) read
 * as null; the snapshot records whether the permission was held.
 */
class CharacteristicsReader(private val context: Context) {
    private val manager: CameraManager = context.getSystemService(CameraManager::class.java)

    /** Camera "0" if it faces back, else the first back-facing camera. */
    fun backCameraId(): String {
        val ids = manager.cameraIdList.toList()
        fun isBack(id: String) = manager.getCameraCharacteristics(id)[CameraCharacteristics.LENS_FACING] == M.LENS_FACING_BACK
        return ids.firstOrNull { it == "0" && isBack(it) }
            ?: ids.firstOrNull(::isBack)
            ?: throw IllegalStateException("no back-facing camera in ${ids}")
    }

    fun read(cameraId: String = backCameraId()): CharacteristicsSnapshot {
        val c = manager.getCameraCharacteristics(cameraId)
        fun <T : Any> get(key: Key<T>): T? = c[key]
        val map: StreamConfigurationMap? = get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        return CharacteristicsSnapshot(
            cameraId = cameraId,
            cameraPermissionGranted = context.checkSelfPermission(Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
            keysNeedingPermission = c.keysNeedingPermission.map { it.name }.sorted(),
            lensFacing = get(CameraCharacteristics.LENS_FACING)?.let(::lensFacingName),
            hardwareLevel = get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)?.let(::hardwareLevelName),
            capabilities = get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES).names(::capabilityName),
            aeModes = get(CameraCharacteristics.CONTROL_AE_AVAILABLE_MODES).names(::aeModeName),
            aeAntibandingModes = get(CameraCharacteristics.CONTROL_AE_AVAILABLE_ANTIBANDING_MODES).names(::antibandingName),
            aeTargetFpsRanges = get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
                ?.map { it.toIntSpan() }.orEmpty(),
            awbModes = get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES).names(::awbModeName),
            afModes = get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES).names(::afModeName),
            aeLockAvailable = get(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE),
            awbLockAvailable = get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE),
            aeCompensationRange = get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)?.toIntSpan(),
            aeCompensationStep = get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)
                ?.let { Ratio(it.numerator, it.denominator) },
            isoRange = get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)?.toIntSpan(),
            exposureTimeRangeNs = get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
                ?.let { LongSpan(it.lower, it.upper) },
            maxFrameDurationNs = get(CameraCharacteristics.SENSOR_INFO_MAX_FRAME_DURATION),
            jpegSizes = map?.getOutputSizes(ImageFormat.JPEG).sizes(),
            jpegHighResolutionSizes = map?.getHighResolutionOutputSizes(ImageFormat.JPEG).sizes(),
            yuvSizes = map?.getOutputSizes(ImageFormat.YUV_420_888).sizes(),
            privateSizes = map?.getOutputSizes(SurfaceTexture::class.java).sizes(),
            activeArraySize = get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
                ?.let { IntRect(it.left, it.top, it.right, it.bottom) },
            pixelArraySize = get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)?.let { Size(it.width, it.height) },
            sensorOrientation = get(CameraCharacteristics.SENSOR_ORIENTATION),
            minFocusDistanceDiopters = get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE),
            hyperfocalDistanceDiopters = get(CameraCharacteristics.LENS_INFO_HYPERFOCAL_DISTANCE),
            focusDistanceCalibration = get(CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION)
                ?.let(::focusCalibrationName),
            focalLengthsMm = get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.toList().orEmpty(),
            maxDigitalZoom = get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM),
        )
    }

    private fun Range<Int>.toIntSpan() = IntSpan(lower, upper)

    private fun Array<ASize>?.sizes(): List<Size> =
        this.orEmpty().map { Size(it.width, it.height) }.sortedByDescending { it.area }

    private fun IntArray?.names(name: (Int) -> String): List<String> = this?.map(name).orEmpty()

    // Camera2 constant names without their prefix; unknown values as UNKNOWN_<n>.

    private fun lensFacingName(v: Int) = when (v) {
        M.LENS_FACING_FRONT -> "FRONT"
        M.LENS_FACING_BACK -> "BACK"
        M.LENS_FACING_EXTERNAL -> "EXTERNAL"
        else -> "UNKNOWN_$v"
    }

    private fun hardwareLevelName(v: Int) = when (v) {
        M.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "LIMITED"
        M.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> "FULL"
        M.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> "LEGACY"
        M.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> "LEVEL_3"
        M.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL -> "EXTERNAL"
        else -> "UNKNOWN_$v"
    }

    private fun capabilityName(v: Int) = when (v) {
        M.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE -> "BACKWARD_COMPATIBLE"
        M.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR -> "MANUAL_SENSOR"
        M.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING -> "MANUAL_POST_PROCESSING"
        M.REQUEST_AVAILABLE_CAPABILITIES_RAW -> "RAW"
        M.REQUEST_AVAILABLE_CAPABILITIES_PRIVATE_REPROCESSING -> "PRIVATE_REPROCESSING"
        M.REQUEST_AVAILABLE_CAPABILITIES_READ_SENSOR_SETTINGS -> "READ_SENSOR_SETTINGS"
        M.REQUEST_AVAILABLE_CAPABILITIES_BURST_CAPTURE -> "BURST_CAPTURE"
        M.REQUEST_AVAILABLE_CAPABILITIES_YUV_REPROCESSING -> "YUV_REPROCESSING"
        M.REQUEST_AVAILABLE_CAPABILITIES_DEPTH_OUTPUT -> "DEPTH_OUTPUT"
        M.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO -> "CONSTRAINED_HIGH_SPEED_VIDEO"
        M.REQUEST_AVAILABLE_CAPABILITIES_MOTION_TRACKING -> "MOTION_TRACKING"
        M.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA -> "LOGICAL_MULTI_CAMERA"
        M.REQUEST_AVAILABLE_CAPABILITIES_MONOCHROME -> "MONOCHROME"
        M.REQUEST_AVAILABLE_CAPABILITIES_SECURE_IMAGE_DATA -> "SECURE_IMAGE_DATA"
        M.REQUEST_AVAILABLE_CAPABILITIES_SYSTEM_CAMERA -> "SYSTEM_CAMERA"
        M.REQUEST_AVAILABLE_CAPABILITIES_OFFLINE_PROCESSING -> "OFFLINE_PROCESSING"
        M.REQUEST_AVAILABLE_CAPABILITIES_ULTRA_HIGH_RESOLUTION_SENSOR -> "ULTRA_HIGH_RESOLUTION_SENSOR"
        M.REQUEST_AVAILABLE_CAPABILITIES_REMOSAIC_REPROCESSING -> "REMOSAIC_REPROCESSING"
        M.REQUEST_AVAILABLE_CAPABILITIES_DYNAMIC_RANGE_TEN_BIT -> "DYNAMIC_RANGE_TEN_BIT"
        M.REQUEST_AVAILABLE_CAPABILITIES_STREAM_USE_CASE -> "STREAM_USE_CASE"
        M.REQUEST_AVAILABLE_CAPABILITIES_COLOR_SPACE_PROFILES -> "COLOR_SPACE_PROFILES"
        else -> "UNKNOWN_$v"
    }

    private fun aeModeName(v: Int) = when (v) {
        M.CONTROL_AE_MODE_OFF -> "OFF"
        M.CONTROL_AE_MODE_ON -> "ON"
        M.CONTROL_AE_MODE_ON_AUTO_FLASH -> "ON_AUTO_FLASH"
        M.CONTROL_AE_MODE_ON_ALWAYS_FLASH -> "ON_ALWAYS_FLASH"
        M.CONTROL_AE_MODE_ON_AUTO_FLASH_REDEYE -> "ON_AUTO_FLASH_REDEYE"
        M.CONTROL_AE_MODE_ON_EXTERNAL_FLASH -> "ON_EXTERNAL_FLASH"
        M.CONTROL_AE_MODE_ON_LOW_LIGHT_BOOST_BRIGHTNESS_PRIORITY -> "ON_LOW_LIGHT_BOOST_BRIGHTNESS_PRIORITY"
        else -> "UNKNOWN_$v"
    }

    private fun antibandingName(v: Int) = when (v) {
        M.CONTROL_AE_ANTIBANDING_MODE_OFF -> "OFF"
        M.CONTROL_AE_ANTIBANDING_MODE_50HZ -> "50HZ"
        M.CONTROL_AE_ANTIBANDING_MODE_60HZ -> "60HZ"
        M.CONTROL_AE_ANTIBANDING_MODE_AUTO -> "AUTO"
        else -> "UNKNOWN_$v"
    }

    private fun awbModeName(v: Int) = when (v) {
        M.CONTROL_AWB_MODE_OFF -> "OFF"
        M.CONTROL_AWB_MODE_AUTO -> "AUTO"
        M.CONTROL_AWB_MODE_INCANDESCENT -> "INCANDESCENT"
        M.CONTROL_AWB_MODE_FLUORESCENT -> "FLUORESCENT"
        M.CONTROL_AWB_MODE_WARM_FLUORESCENT -> "WARM_FLUORESCENT"
        M.CONTROL_AWB_MODE_DAYLIGHT -> "DAYLIGHT"
        M.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT -> "CLOUDY_DAYLIGHT"
        M.CONTROL_AWB_MODE_TWILIGHT -> "TWILIGHT"
        M.CONTROL_AWB_MODE_SHADE -> "SHADE"
        else -> "UNKNOWN_$v"
    }

    private fun afModeName(v: Int) = when (v) {
        M.CONTROL_AF_MODE_OFF -> "OFF"
        M.CONTROL_AF_MODE_AUTO -> "AUTO"
        M.CONTROL_AF_MODE_MACRO -> "MACRO"
        M.CONTROL_AF_MODE_CONTINUOUS_VIDEO -> "CONTINUOUS_VIDEO"
        M.CONTROL_AF_MODE_CONTINUOUS_PICTURE -> "CONTINUOUS_PICTURE"
        M.CONTROL_AF_MODE_EDOF -> "EDOF"
        else -> "UNKNOWN_$v"
    }

    private fun focusCalibrationName(v: Int) = when (v) {
        M.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_UNCALIBRATED -> "UNCALIBRATED"
        M.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_APPROXIMATE -> "APPROXIMATE"
        M.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_CALIBRATED -> "CALIBRATED"
        else -> "UNKNOWN_$v"
    }
}
