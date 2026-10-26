package pl.slava.kopernikadr.camera.controls

import kotlin.math.abs

/** A new settings generation: apply [options] with `setCaptureRequestOptions`, then report its fence. */
data class Apply(val generation: Long, val options: Map<RequestOption, Any>)

/**
 * What the adapter must do after an input.
 * - [apply]: call `Camera2CameraControl.setCaptureRequestOptions(options)`; when its future
 *   completes, report `onFence(generation, frameNumber of the completing result)`.
 * - [triggerAf]: `CameraControl.startFocusAndMetering` (FLAG_AF only, auto-cancel disabled).
 * - [cancelAf]: `CameraControl.cancelFocusAndMetering()`.
 */
data class Step(val apply: Apply? = null, val triggerAf: Boolean = false, val cancelAf: Boolean = false)

data class Transition(val state: ControlsState, val step: Step = Step())

/**
 * The lock procedure and its confirmation (ARCHITECTURE §4.4), as pure functions of
 * [ControlsState]:
 *
 * 1. lock request → `Metering` (auto options; focus: `AF_MODE=AUTO`) + a new generation. At that
 *    generation's fence, focus asks for the AF trigger.
 * 2. the first result at or after the fence with 3A converged (AE CONVERGED/FLASH_REQUIRED, AWB
 *    CONVERGED, AF FOCUSED_LOCKED/NOT_FOCUSED_LOCKED) → freeze its values (freeze methods) →
 *    `Confirming` + a new generation with the locked option set. No convergence within
 *    [ControlsConfig.meterTimeoutMs] → `Failed(lockApplied=false)`.
 * 3. a result at or after the new fence matching the request → `Confirmed`; none within
 *    [ControlsConfig.confirmTimeoutMs] of the fence → `Failed(lockApplied=true)` (the values stay
 *    applied; a late match still confirms).
 *
 * Every generation bump sends confirmed controls back to `Confirming`: only results of the
 * current generation confirm. Results before the fence (frame number below it, or no fence yet)
 * are ignored. A failure never changes the option set.
 */
object ConfirmationMachine {

    fun requestLock(s: ControlsState, c: LockControl, nowMs: Long, cfg: ControlsConfig = ControlsConfig()): Transition {
        val cur = s.lock(c)
        if (cur.intent == LockIntent.LOCKED && cur.phase !is LockPhase.Failed && cur.phase !is LockPhase.Pending) {
            return bump(s, nowMs, cfg) // already locking/locked: nothing to redo
        }
        val metering = ControlLock(LockIntent.LOCKED, LockPhase.Metering(nowMs + cfg.meterTimeoutMs))
        return bump(s.clearFrozen(c).withLock(c, metering), nowMs, cfg)
    }

    fun requestUnlock(s: ControlsState, c: LockControl, nowMs: Long, cfg: ControlsConfig = ControlsConfig()): Transition {
        val wasLocked = s.lock(c).intent == LockIntent.LOCKED
        val t = bump(s.clearFrozen(c).withLock(c, ControlLock()), nowMs, cfg)
        return if (c == LockControl.FOCUS && wasLocked) t.copy(step = t.step.copy(cancelAf = true)) else t
    }

    /**
     * The camera was (re)bound: every frame number and 3A state before is gone. Frozen values are
     * re-applied as they are (`exact` stays true); Camera2 locks and freezes without values
     * re-meter (`exact:false`, unless the control was still on its first metering).
     */
    fun onCameraBound(s: ControlsState, nowMs: Long, cfg: ControlsConfig = ControlsConfig()): Transition {
        var n = s
        for (c in LockControl.entries) {
            val cur = n.lock(c)
            if (cur.intent != LockIntent.LOCKED) continue
            n = if (n.freezes(c) == true && n.hasFrozen(c)) {
                n.withLock(c, cur.copy(phase = LockPhase.Confirming(nowMs + cfg.confirmTimeoutMs)))
            } else {
                val exact = cur.exact && cur.phase is LockPhase.Metering
                n.clearFrozen(c).withLock(c, cur.copy(phase = LockPhase.Metering(nowMs + cfg.meterTimeoutMs), exact = exact, focusOk = true))
            }
        }
        return bump(n, nowMs, cfg)
    }

    /** The `setCaptureRequestOptions` future of [generation] completed at [frameNumber]. */
    fun onFence(s: ControlsState, generation: Long, frameNumber: Long, nowMs: Long, cfg: ControlsConfig = ControlsConfig()): Transition {
        if (generation != s.generation || s.fenceFrame != null) return Transition(s)
        var n = s.copy(fenceFrame = frameNumber)
        var triggerAf = false
        for (c in LockControl.entries) {
            val cur = n.lock(c)
            when (val p = cur.phase) {
                is LockPhase.Confirming -> n = n.withLock(c, cur.copy(phase = LockPhase.Confirming(nowMs + cfg.confirmTimeoutMs)))
                is LockPhase.Metering -> if (c == LockControl.FOCUS && !p.afTriggered) {
                    n = n.withLock(c, cur.copy(phase = p.copy(afTriggered = true)))
                    triggerAf = true
                }
                else -> Unit
            }
        }
        return Transition(n, Step(triggerAf = triggerAf))
    }

    fun onResult(s: ControlsState, r: ResultSummary, nowMs: Long, cfg: ControlsConfig = ControlsConfig()): Transition {
        val fence = s.fenceFrame ?: return Transition(s)
        if (r.frameNumber < fence) return Transition(s)
        var n = s
        var metered = false
        for (c in LockControl.entries) {
            val cur = n.lock(c)
            when (val p = cur.phase) {
                is LockPhase.Confirming, is LockPhase.Failed -> {
                    if (p is LockPhase.Failed && !p.lockApplied) continue
                    if (confirms(n, c, r, cfg)) {
                        val focusOk = if (c == LockControl.FOCUS) focusOkAfterConfirm(n, r) else cur.focusOk
                        n = n.withLock(c, cur.copy(phase = LockPhase.Confirmed, focusOk = focusOk))
                    }
                }
                is LockPhase.Metering -> {
                    val frozen = meter(n, c, p, r) ?: continue
                    n = frozen.withLock(c, frozen.lock(c).copy(phase = LockPhase.Confirming(nowMs + cfg.confirmTimeoutMs)))
                    metered = true
                }
                else -> Unit
            }
        }
        return if (metered) bump(n, nowMs, cfg) else Transition(n)
    }

    fun onTick(s: ControlsState, nowMs: Long): Transition {
        var n = s
        for (c in LockControl.entries) {
            val cur = n.lock(c)
            val failed = when (val p = cur.phase) {
                is LockPhase.Metering -> if (nowMs >= p.deadlineMs) LockPhase.Failed(lockApplied = false) else null
                is LockPhase.Confirming -> if (nowMs >= p.deadlineMs) LockPhase.Failed(lockApplied = true) else null
                else -> null
            }
            if (failed != null) n = n.withLock(c, cur.copy(phase = failed))
        }
        return Transition(n)
    }

    /** New generation: confirmations reset, the fence is unknown, the full option set goes out. */
    fun bump(s: ControlsState, nowMs: Long, cfg: ControlsConfig = ControlsConfig()): Transition {
        var n = s.copy(generation = s.generation + 1, fenceFrame = null)
        for (c in LockControl.entries) {
            val cur = n.lock(c)
            if (cur.phase is LockPhase.Confirmed || cur.phase is LockPhase.Confirming) {
                n = n.withLock(c, cur.copy(phase = LockPhase.Confirming(nowMs + cfg.confirmTimeoutMs)))
            }
        }
        return Transition(n, Step(apply = Apply(n.generation, ControlsPlan.options(n))))
    }

    /**
     * Metering of [c] converged in [r]: the state with the frozen values (freeze) or unchanged
     * (Camera2 lock), or null to keep waiting.
     */
    private fun meter(s: ControlsState, c: LockControl, p: LockPhase.Metering, r: ResultSummary): ControlsState? {
        val freeze = s.freezes(c) ?: return null
        return when (c) {
            LockControl.EXPOSURE -> {
                if (r.aeState != Camera2.AE_STATE_CONVERGED && r.aeState != Camera2.AE_STATE_FLASH_REQUIRED) return null
                if (!freeze) return s
                val iso = r.iso ?: return null
                val time = r.exposureTimeNs ?: return null
                val duration = maxOf(time, r.frameDurationNs ?: ControlsConfig.FALLBACK_FRAME_DURATION_NS)
                s.copy(frozenExposure = FrozenExposure(iso, time, duration))
            }
            LockControl.WHITE_BALANCE -> {
                if (r.awbState != Camera2.AWB_STATE_CONVERGED) return null
                if (!freeze) return s
                s.copy(frozenWhiteBalance = FrozenWhiteBalance(r.gains ?: return null, r.transform ?: return null))
            }
            LockControl.FOCUS -> {
                if (!p.afTriggered || !afLocked(r.afState)) return null
                val ok = r.afState == Camera2.AF_STATE_FOCUSED_LOCKED
                val withOk = s.withLock(c, s.focus.copy(focusOk = ok))
                if (!freeze) return withOk
                withOk.copy(frozenFocus = FrozenFocus(r.focusDistance ?: return null, ok))
            }
        }
    }

    private fun confirms(s: ControlsState, c: LockControl, r: ResultSummary, cfg: ControlsConfig): Boolean {
        val freeze = s.freezes(c) ?: return false
        return when (c) {
            LockControl.EXPOSURE -> if (freeze) {
                val f = s.frozenExposure ?: return false
                val time = r.exposureTimeNs ?: return false
                val iso = r.iso ?: return false
                r.aeMode == Camera2.AE_MODE_OFF && abs(iso - f.iso) <= cfg.isoTolerance * f.iso &&
                    abs(time - f.exposureTimeNs) <= cfg.exposureTimeTolerance * f.exposureTimeNs
            } else {
                r.aeState == Camera2.AE_STATE_LOCKED
            }
            LockControl.WHITE_BALANCE -> if (freeze) {
                val f = s.frozenWhiteBalance ?: return false
                r.awbMode == Camera2.AWB_MODE_OFF && r.ccMode == Camera2.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX &&
                    r.gains?.near(f.gains, cfg.colorTolerance) == true &&
                    r.transform?.near(f.transform, cfg.colorTolerance) == true
            } else {
                r.awbState == Camera2.AWB_STATE_LOCKED
            }
            LockControl.FOCUS -> if (freeze) {
                val f = s.frozenFocus ?: return false
                val d = r.focusDistance ?: return false
                r.afMode == Camera2.AF_MODE_OFF && r.lensState == Camera2.LENS_STATE_STATIONARY &&
                    abs(d - f.distanceDiopters) <= cfg.focusToleranceDiopters
            } else {
                afLocked(r.afState)
            }
        }
    }

    private fun focusOkAfterConfirm(s: ControlsState, r: ResultSummary): Boolean =
        if (s.freezes(LockControl.FOCUS) == true) s.frozenFocus?.focusOk ?: true
        else r.afState == Camera2.AF_STATE_FOCUSED_LOCKED

    private fun afLocked(afState: Int?) =
        afState == Camera2.AF_STATE_FOCUSED_LOCKED || afState == Camera2.AF_STATE_NOT_FOCUSED_LOCKED
}
