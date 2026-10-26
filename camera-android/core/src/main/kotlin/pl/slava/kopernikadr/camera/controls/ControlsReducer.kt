package pl.slava.kopernikadr.camera.controls

import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.ExposureControl
import pl.slava.kopernikadr.camera.protocol.FocusControl
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceControl

/**
 * [ControlsState] → the wire `Controls` (PROTOCOL §6) for `hello`, `getControls`, `setControl`
 * and the `controls` event.
 *
 * Focus has no `failed` mode on the wire: a failed focus lock is reported as
 * `{"mode":"locked","confirmed":false,"focusOk":false}` with `settling:false`.
 */
object ControlsReducer {

    fun reduce(s: ControlsState): Controls = Controls(
        generation = s.generation,
        settling = s.settling,
        exposure = ExposureControl(
            mode = mode(s.exposureMethod != null, s.exposure),
            confirmed = confirmed(s.exposure),
            exact = s.exposure.exact,
            compensationSteps = s.compensationSteps,
            compensationEnabled = s.compensationEnabled,
        ),
        whiteBalance = WhiteBalanceControl(
            mode = mode(s.whiteBalanceMethod != null, s.whiteBalance),
            confirmed = confirmed(s.whiteBalance),
            exact = s.whiteBalance.exact,
        ),
        focus = when {
            s.focusFixed -> FocusControl(FocusMode.FIXED, confirmed = true, focusOk = true)
            s.focus.intent == LockIntent.AUTO -> FocusControl(FocusMode.AUTO, confirmed = true, focusOk = true)
            else -> FocusControl(
                FocusMode.LOCKED,
                confirmed = confirmed(s.focus),
                focusOk = s.focus.focusOk && s.focus.phase !is LockPhase.Failed,
            )
        },
        rotation = s.rotation,
        previewQuality = s.previewQuality,
    )

    private fun mode(supported: Boolean, l: ControlLock): ControlMode = when {
        !supported -> ControlMode.UNSUPPORTED
        l.intent == LockIntent.AUTO -> ControlMode.AUTO
        l.phase is LockPhase.Failed -> ControlMode.FAILED
        else -> ControlMode.LOCKED
    }

    private fun confirmed(l: ControlLock): Boolean = l.intent == LockIntent.AUTO || l.phase == LockPhase.Confirmed
}
