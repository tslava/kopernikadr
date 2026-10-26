package pl.slava.kopernikadr.camera.controls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.controls.RequestOption.AE_EXPOSURE_COMPENSATION
import pl.slava.kopernikadr.camera.controls.RequestOption.AE_LOCK
import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.SetControlArgs
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.EXPOSURE
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.EXPOSURE_COMPENSATION
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.FOCUS
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.PREVIEW_QUALITY
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.ROTATION
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.WHITE_BALANCE

class SetControlTest {

    @Test
    fun `unknown control - UNSUPPORTED_CONTROL`() {
        assertEquals(ErrorCodes.UNSUPPORTED_CONTROL, Rig().reject(SetControlArgs("zoom", mode = "auto")).code)
    }

    @Test
    fun `locks the device cannot do - UNSUPPORTED_CONTROL, auto is accepted`() {
        val rig = Rig(TestCaps.BARE)
        assertEquals(ErrorCodes.UNSUPPORTED_CONTROL, rig.reject(SetControlArgs(EXPOSURE, mode = "locked")).code)
        assertEquals(ErrorCodes.UNSUPPORTED_CONTROL, rig.reject(SetControlArgs(WHITE_BALANCE, mode = "locked")).code)
        assertEquals(ErrorCodes.UNSUPPORTED_CONTROL, rig.reject(SetControlArgs(FOCUS, mode = "auto")).code) // fixed
        assertEquals(ErrorCodes.UNSUPPORTED_CONTROL, rig.reject(SetControlArgs(EXPOSURE_COMPENSATION, steps = 1)).code)
        rig.set(SetControlArgs(EXPOSURE, mode = "auto"))
    }

    @Test
    fun `bad mode values - INVALID_VALUE, missing field - INVALID_ARGS`() {
        val rig = Rig()
        for (mode in listOf("failed", "fixed", "unsupported", "LOCKED", "")) {
            assertEquals(mode, ErrorCodes.INVALID_VALUE, rig.reject(SetControlArgs(EXPOSURE, mode = mode)).code)
        }
        assertEquals(ErrorCodes.INVALID_ARGS, rig.reject(SetControlArgs(EXPOSURE)).code)
        assertEquals(ErrorCodes.INVALID_ARGS, rig.reject(SetControlArgs(EXPOSURE_COMPENSATION)).code)
        assertEquals(ErrorCodes.INVALID_ARGS, rig.reject(SetControlArgs(ROTATION)).code)
        assertEquals(ErrorCodes.INVALID_ARGS, rig.reject(SetControlArgs(PREVIEW_QUALITY)).code)
    }

    @Test
    fun `compensation - range checked, applied in auto`() {
        val rig = Rig()
        assertEquals(ErrorCodes.INVALID_VALUE, rig.reject(SetControlArgs(EXPOSURE_COMPENSATION, steps = 5)).code)
        assertEquals(ErrorCodes.INVALID_VALUE, rig.reject(SetControlArgs(EXPOSURE_COMPENSATION, steps = -5)).code)
        val u = rig.set(SetControlArgs(EXPOSURE_COMPENSATION, steps = -4))
        assertEquals(-4, u.controls.exposure.compensationSteps)
        assertTrue(u.controls.exposure.compensationEnabled)
        assertEquals(-4, u.options()[AE_EXPOSURE_COMPENSATION])
    }

    @Test
    fun `compensation while frozen - INVALID_VALUE with a clear message, allowed again after unlock`() {
        val rig = Rig()
        rig.lock(EXPOSURE) // even while still metering for the freeze
        val e = rig.reject(SetControlArgs(EXPOSURE_COMPENSATION, steps = 1))
        assertEquals(ErrorCodes.INVALID_VALUE, e.code)
        assertTrue(e.message, e.message.contains("unlock"))
        assertEquals(false, rig.controls.exposure.compensationEnabled)
        rig.unlock(EXPOSURE)
        assertEquals(1, rig.set(SetControlArgs(EXPOSURE_COMPENSATION, steps = 1)).controls.exposure.compensationSteps)
    }

    @Test
    fun `compensation with ae_lock - allowed, the lock stays and re-confirms`() {
        val rig = Rig(TestCaps.FALLBACK)
        rig.lockAndConfirm(EXPOSURE, echo = ::lockedResult)
        assertTrue(rig.controls.exposure.confirmed)
        val u = rig.set(SetControlArgs(EXPOSURE_COMPENSATION, steps = 2))
        assertEquals(true, u.options()[AE_LOCK])
        assertEquals(2, u.options()[AE_EXPOSURE_COMPENSATION])
        assertTrue(u.controls.exposure.compensationEnabled)
        assertTrue(u.controls.settling)
        rig.fence()
        assertTrue(rig.result(::lockedResult).controls.exposure.confirmed)
    }

    @Test
    fun `rotation and preview quality - validated against the capabilities`() {
        val rig = Rig()
        assertEquals(ErrorCodes.INVALID_VALUE, rig.reject(SetControlArgs(ROTATION, degrees = 90)).code)
        assertEquals(ErrorCodes.INVALID_VALUE, rig.reject(SetControlArgs(PREVIEW_QUALITY, value = "ultra")).code)
        assertEquals(180, rig.set(SetControlArgs(ROTATION, degrees = 180)).controls.rotation)
        assertEquals(PreviewQuality.HIGH, rig.set(SetControlArgs(PREVIEW_QUALITY, value = "high")).controls.previewQuality)
    }

    @Test
    fun `every accepted change returns a new generation, a rejection changes nothing`() {
        val rig = Rig()
        val g = rig.state.generation
        val before = rig.state
        rig.reject(SetControlArgs(ROTATION, degrees = 45))
        assertEquals(before, rig.state)
        assertEquals(g + 1, rig.set(SetControlArgs(ROTATION, degrees = 0)).controls.generation)
        assertEquals(g + 2, rig.set(SetControlArgs(EXPOSURE, mode = "auto")).controls.generation)
        assertEquals(g + 3, rig.set(SetControlArgs(PREVIEW_QUALITY, value = "low")).step.apply!!.generation)
    }

    @Test
    fun `the pure handler returns the transition`() {
        val s = ControlsState(TestCaps.G05)
        val r = SetControlHandler.handle(s, SetControlArgs(FOCUS, mode = "locked"), 0L)
        r as SetControlHandler.Result.Ok
        assertTrue(r.transition.state.focus.phase is LockPhase.Metering)
        val e = SetControlHandler.handle(s, SetControlArgs("nope", mode = "auto"), 0L)
        assertTrue(e is SetControlHandler.Result.Rejected)
    }
}
