package pl.slava.kopernikadr.camera.controls

import pl.slava.kopernikadr.camera.controls.ControlLock.Stage
import pl.slava.kopernikadr.camera.controls.RequestOption.AE_ANTIBANDING_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.AE_EXPOSURE_COMPENSATION
import pl.slava.kopernikadr.camera.controls.RequestOption.AE_LOCK
import pl.slava.kopernikadr.camera.controls.RequestOption.AE_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.AF_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.AWB_LOCK
import pl.slava.kopernikadr.camera.controls.RequestOption.AWB_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.COLOR_CORRECTION_GAINS
import pl.slava.kopernikadr.camera.controls.RequestOption.COLOR_CORRECTION_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.COLOR_CORRECTION_TRANSFORM
import pl.slava.kopernikadr.camera.controls.RequestOption.CONTROL_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.LENS_FOCUS_DISTANCE
import pl.slava.kopernikadr.camera.controls.RequestOption.SENSOR_EXPOSURE_TIME
import pl.slava.kopernikadr.camera.controls.RequestOption.SENSOR_FRAME_DURATION
import pl.slava.kopernikadr.camera.controls.RequestOption.SENSOR_SENSITIVITY
import pl.slava.kopernikadr.camera.protocol.ExposureLockMethod
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceLockMethod

/**
 * State → the complete option set of a generation, for one
 * `Camera2CameraControl.setCaptureRequestOptions` call (it replaces the previous set; a key left
 * out falls back to CameraX's default, which is auto).
 *
 * - `CONTROL_MODE=AUTO` always, with per-control modes.
 * - Exposure: frozen → `AE_MODE=OFF` + ISO, exposure time, frame duration (compensation 0, it
 *   is ignored with AE off anyway); else `AE_MODE=ON` + compensation + antibanding AUTO +
 *   `AE_LOCK` (true only for a locked `ae_lock`).
 * - White balance: frozen → `AWB_MODE=OFF` + `TRANSFORM_MATRIX` + gains + transform; else
 *   `AWB_MODE=AUTO` + `AWB_LOCK`. In auto the colour-correction mode is left to the template.
 * - Focus: frozen → `AF_MODE=OFF` + distance; metering or `af_lock` → `AF_MODE=AUTO` (the adapter
 *   triggers AF with `startFocusAndMetering`); auto → `CONTINUOUS_PICTURE`; fixed focus → no keys.
 *
 * A control in the "locked" stage without its frozen values cannot happen ([ConfirmationMachine]
 * only freezes with values); it degrades to the auto keys.
 */
object ControlsPlan {

    fun options(s: ControlsState): Map<RequestOption, Any> {
        val o = LinkedHashMap<RequestOption, Any>()
        o[CONTROL_MODE] = Camera2.CONTROL_MODE_AUTO

        val fe = s.frozenExposure
        if (s.exposure.stage == Stage.LOCKED && s.exposureMethod == ExposureLockMethod.FREEZE && fe != null) {
            o[AE_MODE] = Camera2.AE_MODE_OFF
            o[AE_LOCK] = false
            o[SENSOR_SENSITIVITY] = fe.iso
            o[SENSOR_EXPOSURE_TIME] = fe.exposureTimeNs
            o[SENSOR_FRAME_DURATION] = fe.frameDurationNs
            o[AE_EXPOSURE_COMPENSATION] = 0
        } else {
            o[AE_MODE] = Camera2.AE_MODE_ON
            o[AE_LOCK] = s.exposure.stage == Stage.LOCKED && s.exposureMethod == ExposureLockMethod.AE_LOCK
            o[AE_EXPOSURE_COMPENSATION] = if (s.caps.exposure.compensation.supported) s.compensationSteps else 0
            o[AE_ANTIBANDING_MODE] = Camera2.AE_ANTIBANDING_MODE_AUTO
        }

        val fw = s.frozenWhiteBalance
        if (s.whiteBalance.stage == Stage.LOCKED && s.whiteBalanceMethod == WhiteBalanceLockMethod.FREEZE && fw != null) {
            o[AWB_MODE] = Camera2.AWB_MODE_OFF
            o[AWB_LOCK] = false
            o[COLOR_CORRECTION_MODE] = Camera2.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX
            o[COLOR_CORRECTION_GAINS] = fw.gains
            o[COLOR_CORRECTION_TRANSFORM] = fw.transform
        } else {
            o[AWB_MODE] = Camera2.AWB_MODE_AUTO
            o[AWB_LOCK] = s.whiteBalance.stage == Stage.LOCKED && s.whiteBalanceMethod == WhiteBalanceLockMethod.AWB_LOCK
        }

        if (!s.focusFixed) {
            val ff = s.frozenFocus
            val stage = s.focus.stage
            when {
                stage == Stage.LOCKED && s.freezes(LockControl.FOCUS) == true && ff != null -> {
                    o[AF_MODE] = Camera2.AF_MODE_OFF
                    o[LENS_FOCUS_DISTANCE] = ff.distanceDiopters
                }
                stage != Stage.AUTO -> o[AF_MODE] = Camera2.AF_MODE_AUTO
                else -> o[AF_MODE] = Camera2.AF_MODE_CONTINUOUS_PICTURE
            }
        }
        return o
    }
}
