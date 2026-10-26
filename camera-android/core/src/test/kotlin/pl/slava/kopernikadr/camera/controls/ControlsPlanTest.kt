package pl.slava.kopernikadr.camera.controls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
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

class ControlsPlanTest {

    private val auto = ControlsState(TestCaps.G05)
    private val frozenExposure = FrozenExposure(iso = 400, exposureTimeNs = 20_000_000L, frameDurationNs = 33_333_333L)
    private val lockedConfirmed = ControlLock(LockIntent.LOCKED, LockPhase.Confirmed)

    @Test
    fun `auto - CONTROL_MODE AUTO with every 3A on and unlocked, no manual keys`() {
        assertEquals(
            mapOf(
                CONTROL_MODE to Camera2.CONTROL_MODE_AUTO,
                AE_MODE to Camera2.AE_MODE_ON,
                AE_LOCK to false,
                AE_EXPOSURE_COMPENSATION to 0,
                AE_ANTIBANDING_MODE to Camera2.AE_ANTIBANDING_MODE_AUTO,
                AWB_MODE to Camera2.AWB_MODE_AUTO,
                AWB_LOCK to false,
                AF_MODE to Camera2.AF_MODE_CONTINUOUS_PICTURE,
            ),
            ControlsPlan.options(auto),
        )
    }

    @Test
    fun `compensation is applied in auto`() {
        assertEquals(-3, ControlsPlan.options(auto.copy(compensationSteps = -3))[AE_EXPOSURE_COMPENSATION])
    }

    @Test
    fun `frozen exposure - AE OFF with ISO, time and frame duration, compensation neutral`() {
        val s = auto.copy(exposure = lockedConfirmed, frozenExposure = frozenExposure, compensationSteps = 2)
        val o = ControlsPlan.options(s)
        assertEquals(Camera2.CONTROL_MODE_AUTO, o[CONTROL_MODE])
        assertEquals(Camera2.AE_MODE_OFF, o[AE_MODE])
        assertEquals(false, o[AE_LOCK])
        assertEquals(400, o[SENSOR_SENSITIVITY])
        assertEquals(20_000_000L, o[SENSOR_EXPOSURE_TIME])
        assertEquals(33_333_333L, o[SENSOR_FRAME_DURATION])
        assertEquals(0, o[AE_EXPOSURE_COMPENSATION])
        assertFalse(AE_ANTIBANDING_MODE in o)
        // the other controls stay auto
        assertEquals(Camera2.AWB_MODE_AUTO, o[AWB_MODE])
        assertEquals(Camera2.AF_MODE_CONTINUOUS_PICTURE, o[AF_MODE])
    }

    @Test
    fun `exposure still metering for a freeze stays in auto`() {
        val s = auto.copy(exposure = ControlLock(LockIntent.LOCKED, LockPhase.Metering(0)))
        assertEquals(ControlsPlan.options(auto), ControlsPlan.options(s))
    }

    @Test
    fun `failed confirmation keeps the frozen values applied, failed metering stays auto`() {
        val confirmFailed = auto.copy(exposure = ControlLock(LockIntent.LOCKED, LockPhase.Failed(lockApplied = true)), frozenExposure = frozenExposure)
        assertEquals(Camera2.AE_MODE_OFF, ControlsPlan.options(confirmFailed)[AE_MODE])
        val meterFailed = auto.copy(exposure = ControlLock(LockIntent.LOCKED, LockPhase.Failed(lockApplied = false)))
        assertEquals(ControlsPlan.options(auto), ControlsPlan.options(meterFailed))
    }

    @Test
    fun `frozen white balance - AWB OFF, TRANSFORM_MATRIX, gains and transform`() {
        val s = auto.copy(whiteBalance = lockedConfirmed, frozenWhiteBalance = FrozenWhiteBalance(GAINS, TRANSFORM))
        val o = ControlsPlan.options(s)
        assertEquals(Camera2.AWB_MODE_OFF, o[AWB_MODE])
        assertEquals(false, o[AWB_LOCK])
        assertEquals(Camera2.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX, o[COLOR_CORRECTION_MODE])
        assertEquals(GAINS, o[COLOR_CORRECTION_GAINS])
        assertEquals(TRANSFORM, o[COLOR_CORRECTION_TRANSFORM])
        assertEquals(Camera2.AE_MODE_ON, o[AE_MODE])
    }

    @Test
    fun `frozen focus - AF OFF with the distance`() {
        val s = auto.copy(focus = lockedConfirmed, frozenFocus = FrozenFocus(9.5f))
        val o = ControlsPlan.options(s)
        assertEquals(Camera2.AF_MODE_OFF, o[AF_MODE])
        assertEquals(9.5f, o[LENS_FOCUS_DISTANCE])
    }

    @Test
    fun `focus metering uses AF_MODE AUTO for the adapter's trigger`() {
        val s = auto.copy(focus = ControlLock(LockIntent.LOCKED, LockPhase.Metering(0)))
        assertEquals(Camera2.AF_MODE_AUTO, ControlsPlan.options(s)[AF_MODE])
        assertFalse(LENS_FOCUS_DISTANCE in ControlsPlan.options(s))
    }

    @Test
    fun `fallback locks - AE_LOCK and AWB_LOCK with compensation, AF_MODE AUTO`() {
        val s = ControlsState(TestCaps.FALLBACK).copy(
            exposure = lockedConfirmed, whiteBalance = lockedConfirmed, focus = lockedConfirmed, compensationSteps = 2,
        )
        val o = ControlsPlan.options(s)
        assertEquals(Camera2.AE_MODE_ON, o[AE_MODE])
        assertEquals(true, o[AE_LOCK])
        assertEquals(2, o[AE_EXPOSURE_COMPENSATION])
        assertEquals(Camera2.AE_ANTIBANDING_MODE_AUTO, o[AE_ANTIBANDING_MODE])
        assertEquals(Camera2.AWB_MODE_AUTO, o[AWB_MODE])
        assertEquals(true, o[AWB_LOCK])
        assertEquals(Camera2.AF_MODE_AUTO, o[AF_MODE])
        assertFalse(SENSOR_SENSITIVITY in o)
        assertFalse(COLOR_CORRECTION_MODE in o)
    }

    @Test
    fun `fixed focus and no compensation - no AF keys, neutral compensation`() {
        val o = ControlsPlan.options(ControlsState(TestCaps.BARE).copy(compensationSteps = 3))
        assertFalse(AF_MODE in o)
        assertEquals(0, o[AE_EXPOSURE_COMPENSATION])
    }

    @Test
    fun `transform converts to exact power-of-two rationals`() {
        val t = ColorTransform(listOf(1.5, -0.25, 1.0 / 128, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0))
        val r = t.toRationals()
        assertEquals(18, r.size)
        assertEquals(1.5, r[0].toDouble() / r[1], 0.0)
        assertEquals(-0.25, r[2].toDouble() / r[3], 0.0)
        assertEquals(1.0 / 128, r[4].toDouble() / r[5], 0.0)
    }
}
