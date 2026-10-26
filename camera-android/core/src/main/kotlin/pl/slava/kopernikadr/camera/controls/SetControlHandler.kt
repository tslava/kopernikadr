package pl.slava.kopernikadr.camera.controls

import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.ExposureLockMethod
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.ProtocolError
import pl.slava.kopernikadr.camera.protocol.SetControlArgs

/**
 * `setControl` (PROTOCOL §6): validate against the capabilities, then the transition. Every
 * accepted call makes a new generation. Not checked here: rotation vs an in-flight capture or a
 * non-empty project (the server / the remote).
 */
object SetControlHandler {

    sealed interface Result {
        data class Ok(val transition: Transition) : Result
        data class Rejected(val error: ProtocolError) : Result
    }

    fun handle(s: ControlsState, a: SetControlArgs, nowMs: Long, cfg: ControlsConfig = ControlsConfig()): Result =
        when (a.control) {
            SetControlArgs.EXPOSURE -> lockControl(s, LockControl.EXPOSURE, a, nowMs, cfg)
            SetControlArgs.WHITE_BALANCE -> lockControl(s, LockControl.WHITE_BALANCE, a, nowMs, cfg)
            SetControlArgs.FOCUS ->
                if (s.focusFixed) unsupported("focus is fixed on this camera")
                else lockControl(s, LockControl.FOCUS, a, nowMs, cfg)
            SetControlArgs.EXPOSURE_COMPENSATION -> compensation(s, a, nowMs, cfg)
            SetControlArgs.ROTATION -> {
                val d = a.degrees ?: return missing("degrees")
                if (d !in s.caps.rotations) invalid("rotation must be one of ${s.caps.rotations}, got $d")
                else ok(ConfirmationMachine.bump(s.copy(rotation = d), nowMs, cfg))
            }
            SetControlArgs.PREVIEW_QUALITY -> {
                val v = a.value ?: return missing("value")
                val q = PreviewQuality.entries.firstOrNull { it.wire == v }?.takeIf { it in s.caps.previewQualities }
                if (q == null) invalid("previewQuality must be one of ${s.caps.previewQualities.map { it.wire }}, got \"$v\"")
                else ok(ConfirmationMachine.bump(s.copy(previewQuality = q), nowMs, cfg))
            }
            else -> unsupported("unknown control: ${a.control}")
        }

    private fun lockControl(s: ControlsState, c: LockControl, a: SetControlArgs, nowMs: Long, cfg: ControlsConfig): Result {
        val mode = a.mode ?: return missing("mode")
        return when (mode) {
            "auto" -> ok(ConfirmationMachine.requestUnlock(s, c, nowMs, cfg))
            "locked" ->
                if (s.freezes(c) == null) unsupported("${a.control} lock is not supported on this camera")
                else ok(ConfirmationMachine.requestLock(s, c, nowMs, cfg))
            else -> invalid("${a.control} mode must be \"auto\" or \"locked\", got \"$mode\"")
        }
    }

    private fun compensation(s: ControlsState, a: SetControlArgs, nowMs: Long, cfg: ControlsConfig): Result {
        val steps = a.steps ?: return missing("steps")
        val cap = s.caps.exposure.compensation
        return when {
            !cap.supported -> unsupported("exposure compensation is not supported on this camera")
            s.exposure.intent == LockIntent.LOCKED && s.exposureMethod == ExposureLockMethod.FREEZE ->
                invalid("exposure compensation is disabled while exposure is locked (frozen); unlock exposure first")
            steps !in cap.minSteps..cap.maxSteps ->
                invalid("exposure compensation must be in ${cap.minSteps}..${cap.maxSteps} steps, got $steps")
            else -> ok(ConfirmationMachine.bump(s.copy(compensationSteps = steps), nowMs, cfg))
        }
    }

    private val PreviewQuality.wire: String get() = name.lowercase()

    private fun ok(t: Transition) = Result.Ok(t)
    private fun invalid(msg: String) = Result.Rejected(ProtocolError(ErrorCodes.INVALID_VALUE, msg))
    private fun unsupported(msg: String) = Result.Rejected(ProtocolError(ErrorCodes.UNSUPPORTED_CONTROL, msg))
    private fun missing(field: String) = Result.Rejected(ProtocolError.invalidArgs("setControl: $field is required for this control"))
}
