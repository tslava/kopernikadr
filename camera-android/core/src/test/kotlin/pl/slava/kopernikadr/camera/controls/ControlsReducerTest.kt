package pl.slava.kopernikadr.camera.controls

import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.Fixtures
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.ProtocolJson
import pl.slava.kopernikadr.camera.protocol.SetControlArgs
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.EXPOSURE
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.FOCUS
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.ROTATION
import pl.slava.kopernikadr.camera.protocol.SetControlArgs.Companion.WHITE_BALANCE
import pl.slava.kopernikadr.camera.protocol.assertJsonEquals

class ControlsReducerTest {

    private fun wire(c: Controls) = ProtocolJson.encodeToJsonElement(Controls.serializer(), c)

    @Test
    fun `initial auto state equals the hello fixture controls`() {
        val expected = Fixtures.json("hello.res.json").jsonObject["data"]!!.jsonObject["controls"]!!
        val state = ControlsState(TestCaps.G05).copy(generation = 3)
        assertJsonEquals(expected, wire(ControlsReducer.reduce(state)))
    }

    @Test
    fun `all frozen and confirmed at rotation 180 equals the controls event fixture`() {
        val expected = Fixtures.json("controls.evt.json").jsonObject["data"]!!
        val confirmed = ControlLock(LockIntent.LOCKED, LockPhase.Confirmed)
        val state = ControlsState(TestCaps.G05).copy(
            generation = 4,
            exposure = confirmed, whiteBalance = confirmed, focus = confirmed,
            frozenExposure = FrozenExposure(400, 20_000_000L, 33_333_333L),
            frozenWhiteBalance = FrozenWhiteBalance(GAINS, TRANSFORM),
            frozenFocus = FrozenFocus(9.5f),
            rotation = 180,
        )
        assertJsonEquals(expected, wire(ControlsReducer.reduce(state)))
    }

    @Test
    fun `the full lock flow ends in the controls event fixture shape`() {
        val rig = Rig()
        rig.lock(EXPOSURE)
        rig.lock(WHITE_BALANCE)
        rig.lock(FOCUS)
        rig.set(SetControlArgs(ROTATION, degrees = 180))
        rig.fence()
        rig.result(::autoResult)
        rig.fence()
        val done = rig.result(::frozenResult)
        val expected = Fixtures.json("controls.evt.json").jsonObject["data"]!!
        assertJsonEquals(expected, wire(done.controls.copy(generation = 4)))
    }

    @Test
    fun `no lock method - unsupported, fixed focus - fixed and confirmed`() {
        val c = ControlsReducer.reduce(ControlsState(TestCaps.BARE))
        assertEquals(ControlMode.UNSUPPORTED, c.exposure.mode)
        assertEquals(ControlMode.UNSUPPORTED, c.whiteBalance.mode)
        assertFalse(c.exposure.compensationEnabled)
        assertEquals(FocusMode.FIXED, c.focus.mode)
        assertTrue(c.focus.confirmed)
        assertFalse(c.settling)
    }

    @Test
    fun `failed - mode failed, unconfirmed, not settling`() {
        val failed = ControlLock(LockIntent.LOCKED, LockPhase.Failed(lockApplied = false))
        val c = ControlsReducer.reduce(ControlsState(TestCaps.G05).copy(exposure = failed, whiteBalance = failed))
        assertEquals(ControlMode.FAILED, c.exposure.mode)
        assertEquals(ControlMode.FAILED, c.whiteBalance.mode)
        assertFalse(c.exposure.confirmed)
        assertFalse(c.settling)
    }

    @Test
    fun `pending after a restore - locked, unconfirmed, settling`() {
        val c = ControlsReducer.reduce(ControlsState(TestCaps.G05).copy(exposure = ControlLock(LockIntent.LOCKED, LockPhase.Pending)))
        assertEquals(ControlMode.LOCKED, c.exposure.mode)
        assertFalse(c.exposure.confirmed)
        assertTrue(c.settling)
    }
}
