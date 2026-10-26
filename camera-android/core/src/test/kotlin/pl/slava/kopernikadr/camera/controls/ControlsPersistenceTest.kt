package pl.slava.kopernikadr.camera.controls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.controls.RequestOption.AE_LOCK
import pl.slava.kopernikadr.camera.controls.RequestOption.AE_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.AF_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.AWB_MODE
import pl.slava.kopernikadr.camera.controls.RequestOption.LENS_FOCUS_DISTANCE
import pl.slava.kopernikadr.camera.controls.RequestOption.SENSOR_SENSITIVITY
import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.SetControlArgs
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.EXPOSURE
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.EXPOSURE_COMPENSATION
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.FOCUS
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.PREVIEW_QUALITY
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.ROTATION
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.WHITE_BALANCE

class ControlsPersistenceTest {

    private fun lockedEverything(caps: pl.slava.kopernikadr.camera.protocol.Capabilities = TestCaps.G05): MemoryStore {
        val rig = Rig(caps)
        rig.set(SetControlArgs(ROTATION, degrees = 180))
        rig.set(SetControlArgs(PREVIEW_QUALITY, value = "low"))
        rig.lock(EXPOSURE)
        rig.lock(WHITE_BALANCE)
        rig.lock(FOCUS)
        rig.fence()
        rig.result(::autoResult)
        rig.fence()
        rig.result(if (caps == TestCaps.G05) ::frozenResult else ::lockedResult)
        return rig.store
    }

    @Test
    fun `intent and frozen values are written on every change, with commit semantics`() {
        val rig = Rig()
        val puts0 = rig.store.puts
        rig.lock(EXPOSURE)
        assertTrue(rig.store.puts > puts0)
        val afterIntent = ControlsPersistence.decode(rig.store.map[ControlsPersistence.KEY]!!)!!
        assertEquals(LockIntent.LOCKED, afterIntent.exposure)
        assertNull(afterIntent.frozenExposure)
        rig.fence()
        rig.result(::autoResult)
        val afterFreeze = ControlsPersistence.decode(rig.store.map[ControlsPersistence.KEY]!!)!!
        assertEquals(FrozenExposure(400, 20_000_000L, 33_333_333L), afterFreeze.frozenExposure)
        // confirmation alone changes nothing durable: no write
        val puts = rig.store.puts
        rig.fence()
        rig.result(::frozenResult)
        rig.tick(10)
        assertEquals(puts, rig.store.puts)
    }

    @Test
    fun `restore with frozen values - pending, then re-applied directly on bind, exact true`() {
        val store = lockedEverything()
        val rig = Rig(store = store)
        assertEquals(180, rig.controls.rotation)
        assertEquals(PreviewQuality.LOW, rig.controls.previewQuality)
        assertEquals(ControlMode.LOCKED, rig.controls.exposure.mode)
        assertFalse(rig.controls.exposure.confirmed)
        assertTrue(rig.controls.settling)

        val bound = rig.engine.onCameraBound(rig.now)
        val o = bound.options()
        assertEquals(Camera2.AE_MODE_OFF, o[AE_MODE]) // no re-metering
        assertEquals(400, o[SENSOR_SENSITIVITY])
        assertEquals(Camera2.AWB_MODE_OFF, o[AWB_MODE])
        assertEquals(Camera2.AF_MODE_OFF, o[AF_MODE])
        assertEquals(9.5f, o[LENS_FOCUS_DISTANCE])
        assertFalse(bound.step.triggerAf)

        rig.fence()
        val done = rig.result(::frozenResult)
        assertTrue(done.controls.exposure.confirmed && done.controls.exposure.exact)
        assertTrue(done.controls.whiteBalance.confirmed && done.controls.whiteBalance.exact)
        assertTrue(done.controls.focus.confirmed)
        assertFalse(done.controls.settling)
    }

    @Test
    fun `restore with fallback methods - re-meter and re-lock, exact false`() {
        val store = lockedEverything(TestCaps.FALLBACK)
        val rig = Rig(TestCaps.FALLBACK, store = store)
        val bound = rig.engine.onCameraBound(rig.now)
        assertEquals(false, bound.options()[AE_LOCK]) // metering first
        assertTrue(rig.fence().step.triggerAf)
        assertEquals(true, rig.result(::autoResult).options()[AE_LOCK])
        rig.fence()
        val done = rig.result(::lockedResult)
        assertTrue(done.controls.exposure.confirmed)
        assertFalse(done.controls.exposure.exact)
        assertFalse(done.controls.whiteBalance.exact)
        // a fresh lock is exact again
        rig.unlock(EXPOSURE)
        assertTrue(rig.lockAndConfirm(EXPOSURE, converged = ::autoResult, echo = ::lockedResult).controls.exposure.exact)
    }

    @Test
    fun `a rebind in the same run re-applies the frozen values`() {
        val rig = Rig()
        rig.lockAndConfirm(EXPOSURE)
        val bound = rig.engine.onCameraBound(rig.now)
        assertEquals(Camera2.AE_MODE_OFF, bound.options()[AE_MODE])
        assertFalse(bound.controls.exposure.confirmed)
        rig.fence()
        val done = rig.result(::frozenResult)
        assertTrue(done.controls.exposure.confirmed)
        assertTrue(done.controls.exposure.exact)
    }

    @Test
    fun `a rebind while metering restarts the metering`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        val bound = rig.engine.onCameraBound(rig.now + 2_000)
        assertEquals(Camera2.AE_MODE_ON, bound.options()[AE_MODE])
        val phase = rig.state.exposure.phase as LockPhase.Metering
        assertEquals(rig.now + 2_000 + 3_000, phase.deadlineMs)
        assertTrue(rig.state.exposure.exact)
    }

    @Test
    fun `restore drops frozen values of a method the device no longer uses`() {
        val store = lockedEverything()
        val rig = Rig(TestCaps.FALLBACK, store = store)
        assertNull(rig.state.frozenExposure)
        assertNull(rig.state.frozenWhiteBalance)
        assertNull(rig.state.frozenFocus)
        assertEquals(LockIntent.LOCKED, rig.state.exposure.intent)
        assertEquals(false, rig.engine.onCameraBound(rig.now).options()[AE_LOCK])
    }

    @Test
    fun `restore on a device without locks - intent falls back to auto`() {
        val store = lockedEverything()
        val rig = Rig(TestCaps.BARE, store = store)
        assertEquals(ControlMode.UNSUPPORTED, rig.controls.exposure.mode)
        assertFalse(rig.controls.settling)
    }

    @Test
    fun `restore clamps compensation, garbage or nothing stored gives defaults`() {
        val rig = Rig()
        rig.set(SetControlArgs(EXPOSURE_COMPENSATION, steps = 4))
        val narrow = TestCaps.G05.copy(exposure = TestCaps.G05.exposure.copy(compensation = TestCaps.G05.exposure.compensation.copy(minSteps = -2, maxSteps = 2)))
        assertEquals(2, Rig(narrow, store = rig.store).controls.exposure.compensationSteps)

        val garbage = MemoryStore().apply { map[ControlsPersistence.KEY] = "{not json" }
        assertEquals(ControlsState(TestCaps.G05), Rig(store = garbage).state)
        assertEquals(ControlsState(TestCaps.G05), Rig().state)
    }

    @Test
    fun `snapshot round-trips through JSON`() {
        val s = ControlsSnapshot(
            exposure = LockIntent.LOCKED, whiteBalance = LockIntent.AUTO, focus = LockIntent.LOCKED,
            exposureMethod = pl.slava.kopernikadr.camera.protocol.ExposureLockMethod.FREEZE,
            whiteBalanceMethod = null,
            focusMethod = pl.slava.kopernikadr.camera.protocol.FocusLockMethod.FREEZE,
            compensationSteps = -1, rotation = 180, previewQuality = PreviewQuality.HIGH,
            frozenExposure = FrozenExposure(100, 1_000_000L, 33_333_333L),
            frozenWhiteBalance = null,
            frozenFocus = FrozenFocus(9.75f, focusOk = false),
        )
        assertEquals(s, ControlsPersistence.decode(ControlsPersistence.encode(s)))
        assertNotNull(ControlsPersistence.encode(s))
    }
}
