package pl.slava.kopernikadr.camera.controls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.controls.RequestOption.AE_LOCK
import pl.slava.kopernikadr.camera.controls.RequestOption.AE_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.AF_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.AWB_LOCK
import pl.slava.kopernikadr.camera.controls.RequestOption.AWB_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.LENS_FOCUS_DISTANCE
import pl.slava.kopernikadr.camera.controls.RequestOption.SENSOR_EXPOSURE_TIME
import pl.slava.kopernikadr.camera.controls.RequestOption.SENSOR_FRAME_DURATION
import pl.slava.kopernikadr.camera.controls.RequestOption.SENSOR_SENSITIVITY
import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.EXPOSURE
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.FOCUS
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.WHITE_BALANCE

class ConfirmationMachineTest {

    // --- freeze exposure: the full procedure ---

    @Test
    fun `freeze exposure - meter, freeze from the first converged result, confirm after the fence`() {
        val rig = Rig()
        val g0 = rig.state.generation

        val req = rig.lock(EXPOSURE)
        assertEquals(g0 + 1, req.step.apply!!.generation)
        assertEquals(Camera2.AE_MODE_ON, req.options()[AE_MODE]) // metering in auto
        assertEquals(ControlMode.LOCKED, req.controls.exposure.mode)
        assertFalse(req.controls.exposure.confirmed)
        assertTrue(req.controls.settling)

        // A converged result before the fence is stale.
        assertNull(rig.result(::autoResult).step.apply)
        rig.fence()
        assertNull(rig.result(::searchingResult).step.apply)

        val freeze = rig.result(::autoResult)
        val apply = freeze.step.apply!!
        assertEquals(g0 + 2, apply.generation)
        assertEquals(Camera2.AE_MODE_OFF, apply.options[AE_MODE])
        assertEquals(400, apply.options[SENSOR_SENSITIVITY])
        assertEquals(20_000_000L, apply.options[SENSOR_EXPOSURE_TIME])
        assertEquals(33_333_333L, apply.options[SENSOR_FRAME_DURATION])
        assertEquals(FrozenExposure(400, 20_000_000L, 33_333_333L), rig.state.frozenExposure)
        assertTrue(freeze.controls.settling)

        // The echo before the new fence does not count.
        assertFalse(rig.result(::frozenResult).controls.exposure.confirmed)
        rig.fence()
        val done = rig.result { frozenResult(it).copy(exposureTimeNs = 20_150_000L) } // within 1%
        assertTrue(done.controls.exposure.confirmed)
        assertTrue(done.controlsChanged)
        assertFalse(done.controls.settling)
        assertTrue(done.controls.exposure.exact)
        assertEquals(g0 + 2, done.controls.generation)
        assertNull(done.step.apply)
    }

    @Test
    fun `a result with a frame number below the fence is ignored even after the fence`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        val fenceFrame = rig.frame + 10
        rig.engine.onFence(rig.state.generation, fenceFrame, rig.now)
        assertNull(rig.engine.onResult(autoResult(fenceFrame - 1), rig.now).step.apply)
        assertTrue(rig.engine.onResult(autoResult(fenceFrame), rig.now).step.apply != null)
    }

    @Test
    fun `a fence for another generation is ignored`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        rig.engine.onFence(rig.state.generation - 1, 50, rig.now)
        assertNull(rig.state.fenceFrame)
        assertNull(rig.engine.onResult(autoResult(60), rig.now).step.apply)
    }

    @Test
    fun `FLASH_REQUIRED counts as converged`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        rig.fence()
        assertTrue(rig.result { autoResult(it).copy(aeState = Camera2.AE_STATE_FLASH_REQUIRED) }.step.apply != null)
    }

    @Test
    fun `wrong ISO or time off by more than 1 percent does not confirm`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        rig.fence()
        rig.result(::autoResult)
        rig.fence()
        assertFalse(rig.result { frozenResult(it).copy(iso = 405) }.controls.exposure.confirmed)
        assertFalse(rig.result { frozenResult(it).copy(exposureTimeNs = 20_300_000L) }.controls.exposure.confirmed)
        assertFalse(rig.result { frozenResult(it).copy(aeMode = Camera2.AE_MODE_ON) }.controls.exposure.confirmed)
        assertTrue(rig.result(::frozenResult).controls.exposure.confirmed)
    }

    @Test
    fun `ISO quantized by the HAL within 1 percent confirms`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        rig.fence()
        rig.result(::autoResult)
        rig.fence()
        assertTrue(rig.result { frozenResult(it).copy(iso = 399) }.controls.exposure.confirmed)
    }

    @Test
    fun `frame duration - from the result, never below the exposure time, 1-15 s when not reported`() {
        val long = Rig()
        long.lock(EXPOSURE)
        long.fence()
        long.result { autoResult(it).copy(exposureTimeNs = 50_000_000L, frameDurationNs = 33_333_333L) }
        assertEquals(50_000_000L, long.state.frozenExposure!!.frameDurationNs)

        val missing = Rig()
        missing.lock(EXPOSURE)
        missing.fence()
        missing.result { autoResult(it).copy(frameDurationNs = null) }
        assertEquals(ControlsConfig.FALLBACK_FRAME_DURATION_NS, missing.state.frozenExposure!!.frameDurationNs)
    }

    // --- timeouts ---

    @Test
    fun `no convergence within 3 s - failed, settling ends, options unchanged`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        rig.fence()
        rig.result(::searchingResult)
        assertEquals(ControlMode.LOCKED, rig.tick(2_999).controls.exposure.mode)
        val failed = rig.tick(1)
        assertEquals(ControlMode.FAILED, failed.controls.exposure.mode)
        assertFalse(failed.controls.exposure.confirmed)
        assertFalse(failed.controls.settling)
        assertTrue(failed.controlsChanged)
        assertNull(failed.step.apply)
        // a converged result later does not revive a failed metering
        assertNull(rig.result(::autoResult).step.apply)
    }

    @Test
    fun `not confirmed within 3 s after the fence - failed, frozen values stay applied, late confirm recovers`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        rig.fence()
        rig.result(::autoResult)
        rig.tick(1_000) // the fence comes late: the timeout counts from it
        rig.fence()
        rig.result(::autoResult) // the device ignores the manual values
        assertEquals(ControlMode.LOCKED, rig.tick(2_999).controls.exposure.mode)
        val failed = rig.tick(1)
        assertEquals(ControlMode.FAILED, failed.controls.exposure.mode)
        assertFalse(failed.controls.settling)
        assertNull(failed.step.apply)
        assertEquals(Camera2.AE_MODE_OFF, ControlsPlan.options(rig.state)[AE_MODE])

        val late = rig.result(::frozenResult)
        assertEquals(ControlMode.LOCKED, late.controls.exposure.mode)
        assertTrue(late.controls.exposure.confirmed)
    }

    @Test
    fun `a fence that never comes - failed 3 s after the new generation`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        rig.fence()
        rig.result(::autoResult)
        rig.tick(2_999)
        assertEquals(ControlMode.FAILED, rig.tick(1).controls.exposure.mode)
    }

    @Test
    fun `locking again after a failure re-meters`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        rig.tick(3_000)
        assertEquals(ControlMode.FAILED, rig.controls.exposure.mode)
        val again = rig.lock(EXPOSURE)
        assertEquals(ControlMode.LOCKED, again.controls.exposure.mode)
        assertTrue(again.controls.settling)
        rig.fence()
        assertTrue(rig.result(::autoResult).step.apply != null)
    }

    // --- white balance ---

    @Test
    fun `freeze white balance - gains and transform within 1e-3, TRANSFORM_MATRIX, AWB OFF`() {
        val rig = Rig()
        rig.lock(WHITE_BALANCE)
        rig.fence()
        assertNull(rig.result { autoResult(it).copy(awbState = Camera2.AWB_STATE_SEARCHING) }.step.apply)
        val apply = rig.result(::autoResult).step.apply!!
        assertEquals(Camera2.AWB_MODE_OFF, apply.options[AWB_MODE])
        assertEquals(FrozenWhiteBalance(GAINS, TRANSFORM), rig.state.frozenWhiteBalance)
        rig.fence()
        val off = GAINS.copy(r = GAINS.r + 0.002f)
        assertFalse(rig.result { frozenResult(it).copy(gains = off) }.controls.whiteBalance.confirmed)
        val tOff = ColorTransform(TRANSFORM.m.mapIndexed { i, v -> if (i == 4) v + 0.002 else v })
        assertFalse(rig.result { frozenResult(it).copy(transform = tOff) }.controls.whiteBalance.confirmed)
        assertFalse(rig.result { frozenResult(it).copy(ccMode = Camera2.COLOR_CORRECTION_MODE_FAST) }.controls.whiteBalance.confirmed)
        val near = GAINS.copy(b = GAINS.b + 0.0005f)
        assertTrue(rig.result { frozenResult(it).copy(gains = near) }.controls.whiteBalance.confirmed)
    }

    // --- focus ---

    @Test
    fun `freeze focus - AF AUTO, trigger once at the fence, freeze the distance, confirm STATIONARY within 0_05`() {
        val rig = Rig()
        val req = rig.lock(FOCUS)
        assertEquals(Camera2.AF_MODE_AUTO, req.options()[AF_MODE])
        assertFalse(req.step.triggerAf)
        // a locked AF state before the trigger does not count
        assertTrue(rig.fence().step.triggerAf)
        assertEquals(Camera2.AF_MODE_AUTO, rig.lock(WHITE_BALANCE).options()[AF_MODE]) // another generation
        assertFalse(rig.fence().step.triggerAf) // no second trigger

        assertNull(rig.result { autoResult(it).copy(afState = Camera2.AF_STATE_ACTIVE_SCAN, awbState = 0) }.step.apply)
        val apply = rig.result { autoResult(it).copy(awbState = 0) }.step.apply!!
        assertEquals(Camera2.AF_MODE_OFF, apply.options[AF_MODE])
        assertEquals(9.5f, apply.options[LENS_FOCUS_DISTANCE])
        rig.fence()
        assertFalse(rig.result { frozenResult(it).copy(lensState = Camera2.LENS_STATE_MOVING, awbMode = 1) }.controls.focus.confirmed)
        assertFalse(rig.result { frozenResult(it).copy(focusDistance = 9.6f, awbMode = 1) }.controls.focus.confirmed)
        val done = rig.result { frozenResult(it).copy(focusDistance = 9.54f, awbMode = 1) }
        assertTrue(done.controls.focus.confirmed)
        assertTrue(done.controls.focus.focusOk)
        assertEquals(FocusMode.LOCKED, done.controls.focus.mode)
    }

    @Test
    fun `freeze focus - NOT_FOCUSED_LOCKED freezes anyway with focusOk false`() {
        val rig = Rig()
        rig.lock(FOCUS)
        rig.fence()
        rig.result { autoResult(it).copy(afState = Camera2.AF_STATE_NOT_FOCUSED_LOCKED) }
        rig.fence()
        val done = rig.result(::frozenResult)
        assertTrue(done.controls.focus.confirmed)
        assertFalse(done.controls.focus.focusOk)
    }

    @Test
    fun `focus metering timeout - reported locked, unconfirmed, focusOk false, not settling`() {
        val rig = Rig()
        rig.lock(FOCUS)
        rig.fence()
        val failed = rig.tick(3_000)
        assertEquals(FocusMode.LOCKED, failed.controls.focus.mode)
        assertFalse(failed.controls.focus.confirmed)
        assertFalse(failed.controls.focus.focusOk)
        assertFalse(failed.controls.settling)
    }

    // --- fallbacks ---

    @Test
    fun `ae_lock - converge, AE_LOCK true, confirmed by aeState LOCKED`() {
        val rig = Rig(TestCaps.FALLBACK)
        rig.lock(EXPOSURE)
        rig.fence()
        val apply = rig.result(::autoResult).step.apply!!
        assertEquals(true, apply.options[AE_LOCK])
        assertEquals(Camera2.AE_MODE_ON, apply.options[AE_MODE])
        assertNull(rig.state.frozenExposure)
        rig.fence()
        assertFalse(rig.result(::autoResult).controls.exposure.confirmed)
        assertTrue(rig.result(::lockedResult).controls.exposure.confirmed)
    }

    @Test
    fun `awb_lock - confirmed by awbState LOCKED`() {
        val rig = Rig(TestCaps.FALLBACK)
        rig.lock(WHITE_BALANCE)
        rig.fence()
        assertEquals(true, rig.result(::autoResult).options()[AWB_LOCK])
        rig.fence()
        assertTrue(rig.result(::lockedResult).controls.whiteBalance.confirmed)
    }

    @Test
    fun `af_lock - trigger, then confirmed by the AF lock states, NOT_FOCUSED reported as focusOk false`() {
        val rig = Rig(TestCaps.FALLBACK)
        rig.lock(FOCUS)
        assertTrue(rig.fence().step.triggerAf)
        val apply = rig.result(::lockedResult).step.apply!!
        assertEquals(Camera2.AF_MODE_AUTO, apply.options[AF_MODE])
        rig.fence()
        assertFalse(rig.result { lockedResult(it).copy(afState = Camera2.AF_STATE_PASSIVE_FOCUSED) }.controls.focus.confirmed)
        val done = rig.result { lockedResult(it).copy(afState = Camera2.AF_STATE_NOT_FOCUSED_LOCKED) }
        assertTrue(done.controls.focus.confirmed)
        assertFalse(done.controls.focus.focusOk)
    }

    // --- unlock, generations ---

    @Test
    fun `unlock returns to auto, clears the frozen values and cancels AF`() {
        val rig = Rig()
        rig.lockAndConfirm(EXPOSURE)
        rig.lockAndConfirm(FOCUS)
        val ue = rig.unlock(EXPOSURE)
        assertNull(rig.state.frozenExposure)
        assertEquals(Camera2.AE_MODE_ON, ue.options()[AE_MODE])
        assertEquals(ControlMode.AUTO, ue.controls.exposure.mode)
        assertTrue(ue.controls.exposure.confirmed)
        assertFalse(ue.step.cancelAf)
        val uf = rig.unlock(FOCUS)
        assertTrue(uf.step.cancelAf)
        assertNull(rig.state.frozenFocus)
        assertEquals(Camera2.AF_MODE_CONTINUOUS_PICTURE, uf.options()[AF_MODE])
        assertFalse(uf.controls.settling)
    }

    @Test
    fun `every change makes a new generation and the locked controls re-confirm on it`() {
        val rig = Rig()
        rig.lockAndConfirm(EXPOSURE)
        assertTrue(rig.controls.exposure.confirmed)
        val g = rig.state.generation
        val wb = rig.lock(WHITE_BALANCE)
        assertEquals(g + 1, wb.controls.generation)
        assertFalse(wb.controls.exposure.confirmed)
        assertTrue(wb.controls.settling)
        assertEquals(Camera2.AE_MODE_OFF, wb.options()[AE_MODE]) // the frozen exposure stays in the set
        rig.fence()
        val metered = rig.result { autoResult(it).copy(aeMode = Camera2.AE_MODE_OFF) }
        // exposure confirmed on g+1, then the WB freeze makes g+2: it re-confirms again
        assertFalse(metered.controls.exposure.confirmed)
        rig.fence()
        val done = rig.result(::frozenResult)
        assertTrue(done.controls.exposure.confirmed)
        assertTrue(done.controls.whiteBalance.confirmed)
        assertFalse(done.controls.settling)
    }

    @Test
    fun `two controls converging on the same result make a single generation`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        rig.lock(WHITE_BALANCE)
        val g = rig.state.generation
        rig.fence()
        val both = rig.result(::autoResult)
        assertEquals(g + 1, both.step.apply!!.generation)
        assertEquals(Camera2.AE_MODE_OFF, both.options()[AE_MODE])
        assertEquals(Camera2.AWB_MODE_OFF, both.options()[AWB_MODE])
    }

    @Test
    fun `the pure machine needs no engine`() {
        val s0 = ControlsState(TestCaps.G05)
        val t = ConfirmationMachine.requestLock(s0, LockControl.EXPOSURE, 0L)
        assertEquals(1L, t.state.generation)
        assertTrue(t.state.exposure.phase is LockPhase.Metering)
        assertEquals(ControlsPlan.options(t.state), t.step.apply!!.options)
    }
}
