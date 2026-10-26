package pl.slava.kopernikadr.camera.controls

import kotlinx.serialization.Serializable
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.ExposureLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceLockMethod

/** The parent's intent for a lockable control (persisted). */
@Serializable
enum class LockIntent { AUTO, LOCKED }

enum class LockControl { EXPOSURE, WHITE_BALANCE, FOCUS }

/** Where a control is in the lock procedure (ARCHITECTURE §4.4). Not persisted. */
sealed interface LockPhase {
    /** Intent `auto`: always confirmed. */
    data object Auto : LockPhase

    /** Intent `locked` restored from the store; waits for the camera bind. Settling. */
    data object Pending : LockPhase

    /**
     * Waiting for 3A convergence in auto (for focus: the AF trigger at the fence, then an AF
     * lock state). Fails at [deadlineMs].
     */
    data class Metering(val deadlineMs: Long, val afTriggered: Boolean = false) : LockPhase

    /** The locked option set is applied; waiting for a matching result after the fence. */
    data class Confirming(val deadlineMs: Long) : LockPhase

    data object Confirmed : LockPhase

    /**
     * Timed out. [lockApplied]: the locked options (frozen values / Camera2 lock) stay applied, and
     * a late matching result still confirms; otherwise the control stays metering in auto until
     * the parent locks again or the camera rebinds.
     */
    data class Failed(val lockApplied: Boolean) : LockPhase
}

/** Per-control state. [exact]: false after a restart re-metered the lock. */
data class ControlLock(
    val intent: LockIntent = LockIntent.AUTO,
    val phase: LockPhase = LockPhase.Auto,
    val exact: Boolean = true,
    /** False when the AF lock ended in NOT_FOCUSED_LOCKED. */
    val focusOk: Boolean = true,
) {
    val settling: Boolean
        get() = intent == LockIntent.LOCKED && phase !is LockPhase.Confirmed && phase !is LockPhase.Failed

    /** Which option set the control contributes ([ControlsPlan]). */
    internal val stage: Stage
        get() = when (phase) {
            LockPhase.Auto -> Stage.AUTO
            LockPhase.Pending, is LockPhase.Metering -> Stage.METERING
            is LockPhase.Confirming, LockPhase.Confirmed -> Stage.LOCKED
            is LockPhase.Failed -> if (phase.lockApplied) Stage.LOCKED else Stage.METERING
        }

    internal enum class Stage { AUTO, METERING, LOCKED }
}

/** Metered exposure, applied with `AE_MODE=OFF`. */
@Serializable
data class FrozenExposure(val iso: Int, val exposureTimeNs: Long, val frameDurationNs: Long)

/** Metered white balance, applied with `AWB_MODE=OFF` + `TRANSFORM_MATRIX`. */
@Serializable
data class FrozenWhiteBalance(val gains: ColorGains, val transform: ColorTransform)

/** Focus distance after the AF trigger, applied with `AF_MODE=OFF`. */
@Serializable
data class FrozenFocus(val distanceDiopters: Float, val focusOk: Boolean = true)

/** Timeouts and confirmation tolerances (ARCHITECTURE §4.4, plan Task 7). */
data class ControlsConfig(
    val meterTimeoutMs: Long = 3_000L,
    /** From the fence of the locked generation (or from the generation, if no fence comes). */
    val confirmTimeoutMs: Long = 3_000L,
    /** Relative. */
    val exposureTimeTolerance: Double = 0.01,
    /** Relative. The HAL quantizes a manual ISO (moto g05: 9781 requested → 9775 reported). */
    val isoTolerance: Double = 0.01,
    /** Absolute, per gain and per transform element. */
    val colorTolerance: Double = 1e-3,
    val focusToleranceDiopters: Double = 0.05,
) {
    companion object {
        /** Frame duration to freeze when the result reports none: 1/15 s (never below the exposure time). */
        const val FALLBACK_FRAME_DURATION_NS = 66_666_667L
    }
}

/**
 * The whole controls state: intents and phases, frozen values, the current settings generation
 * and its fence. Immutable; [ConfirmationMachine] and [SetControlHandler] make the next one.
 */
data class ControlsState(
    val caps: Capabilities,
    val exposure: ControlLock = ControlLock(),
    val whiteBalance: ControlLock = ControlLock(),
    val focus: ControlLock = ControlLock(),
    val compensationSteps: Int = 0,
    val rotation: Int = caps.rotations.firstOrNull() ?: 0,
    val previewQuality: PreviewQuality = PreviewQuality.NORMAL,
    val frozenExposure: FrozenExposure? = null,
    val frozenWhiteBalance: FrozenWhiteBalance? = null,
    val frozenFocus: FrozenFocus? = null,
    val generation: Long = 0,
    /** First frame number of [generation] (reported by the adapter); null until then. */
    val fenceFrame: Long? = null,
) {
    val exposureMethod: ExposureLockMethod? get() = caps.exposure.method.takeIf { caps.exposure.lock }
    val whiteBalanceMethod: WhiteBalanceLockMethod? get() = caps.whiteBalance.method.takeIf { caps.whiteBalance.lock }
    val focusFixed: Boolean get() = FocusMode.LOCKED !in caps.focus.modes || caps.focusLock.method == null
    val focusMethod: FocusLockMethod? get() = caps.focusLock.method.takeIf { !focusFixed }

    /** Compensation works in auto and with the AE lock, never while frozen (ARCHITECTURE §4.4). */
    val compensationEnabled: Boolean
        get() = caps.exposure.compensation.supported &&
            (exposure.intent == LockIntent.AUTO || exposureMethod == ExposureLockMethod.AE_LOCK)

    val settling: Boolean get() = exposure.settling || whiteBalance.settling || focus.settling

    fun lock(c: LockControl): ControlLock = when (c) {
        LockControl.EXPOSURE -> exposure
        LockControl.WHITE_BALANCE -> whiteBalance
        LockControl.FOCUS -> focus
    }

    fun withLock(c: LockControl, l: ControlLock): ControlsState = when (c) {
        LockControl.EXPOSURE -> copy(exposure = l)
        LockControl.WHITE_BALANCE -> copy(whiteBalance = l)
        LockControl.FOCUS -> copy(focus = l)
    }

    /** Whether [c] locks by freezing metered values (vs a Camera2 lock). Null: no lock method. */
    fun freezes(c: LockControl): Boolean? = when (c) {
        LockControl.EXPOSURE -> exposureMethod?.let { it == ExposureLockMethod.FREEZE }
        LockControl.WHITE_BALANCE -> whiteBalanceMethod?.let { it == WhiteBalanceLockMethod.FREEZE }
        LockControl.FOCUS -> focusMethod?.let { it == FocusLockMethod.FREEZE }
    }

    fun hasFrozen(c: LockControl): Boolean = when (c) {
        LockControl.EXPOSURE -> frozenExposure != null
        LockControl.WHITE_BALANCE -> frozenWhiteBalance != null
        LockControl.FOCUS -> frozenFocus != null
    }

    fun clearFrozen(c: LockControl): ControlsState = when (c) {
        LockControl.EXPOSURE -> copy(frozenExposure = null)
        LockControl.WHITE_BALANCE -> copy(frozenWhiteBalance = null)
        LockControl.FOCUS -> copy(frozenFocus = null)
    }
}
