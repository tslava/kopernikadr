package pl.slava.kopernikadr.camera.camera

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.camera.CameraControls.Companion.toArgs
import pl.slava.kopernikadr.camera.camera.RequestOptionMapping.ValueType
import pl.slava.kopernikadr.camera.controls.ColorGains
import pl.slava.kopernikadr.camera.controls.ColorTransform
import pl.slava.kopernikadr.camera.controls.ControlLock
import pl.slava.kopernikadr.camera.controls.ControlsPlan
import pl.slava.kopernikadr.camera.controls.ControlsState
import pl.slava.kopernikadr.camera.controls.FrozenExposure
import pl.slava.kopernikadr.camera.controls.FrozenFocus
import pl.slava.kopernikadr.camera.controls.FrozenWhiteBalance
import pl.slava.kopernikadr.camera.controls.LockIntent
import pl.slava.kopernikadr.camera.controls.LockPhase
import pl.slava.kopernikadr.camera.controls.RequestOption
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.CompensationCapability
import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.ExposureCapability
import pl.slava.kopernikadr.camera.protocol.ExposureLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusCapability
import pl.slava.kopernikadr.camera.protocol.FocusLockCapability
import pl.slava.kopernikadr.camera.protocol.FocusLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.Rational
import pl.slava.kopernikadr.camera.protocol.SetControlArgs
import pl.slava.kopernikadr.camera.protocol.Size
import pl.slava.kopernikadr.camera.protocol.Sizes
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceCapability
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceLockMethod
import pl.slava.kopernikadr.camera.server.ControlChange

class RequestOptionMappingTest {
    private val caps = Capabilities(
        aspect = "4:3",
        sizes = Sizes(Size(3264, 2448), Size(1440, 1080), Size(256, 192)),
        rotations = listOf(0, 180),
        exposure = ExposureCapability(true, ExposureLockMethod.FREEZE, CompensationCapability(true, -4, 4, Rational(1, 2))),
        whiteBalance = WhiteBalanceCapability(true, WhiteBalanceLockMethod.FREEZE),
        focusLock = FocusLockCapability(FocusLockMethod.FREEZE),
        focus = FocusCapability(listOf(FocusMode.AUTO, FocusMode.LOCKED), 10.0),
        previewQualities = PreviewQuality.entries,
    )
    private val gains = ColorGains(1.9f, 1.0f, 1.0f, 1.6f)
    private val transform = ColorTransform(listOf(1.5, -0.4, -0.1, -0.2, 1.4, -0.2, 0.0, -0.6, 1.6))

    @Test
    fun `every option has its Camera2 key name, all distinct`() {
        val expected = mapOf(
            RequestOption.CONTROL_MODE to "android.control.mode",
            RequestOption.AE_MODE to "android.control.aeMode",
            RequestOption.AE_LOCK to "android.control.aeLock",
            RequestOption.AE_EXPOSURE_COMPENSATION to "android.control.aeExposureCompensation",
            RequestOption.AE_ANTIBANDING_MODE to "android.control.aeAntibandingMode",
            RequestOption.SENSOR_SENSITIVITY to "android.sensor.sensitivity",
            RequestOption.SENSOR_EXPOSURE_TIME to "android.sensor.exposureTime",
            RequestOption.SENSOR_FRAME_DURATION to "android.sensor.frameDuration",
            RequestOption.AWB_MODE to "android.control.awbMode",
            RequestOption.AWB_LOCK to "android.control.awbLock",
            RequestOption.COLOR_CORRECTION_MODE to "android.colorCorrection.mode",
            RequestOption.COLOR_CORRECTION_GAINS to "android.colorCorrection.gains",
            RequestOption.COLOR_CORRECTION_TRANSFORM to "android.colorCorrection.transform",
            RequestOption.AF_MODE to "android.control.afMode",
            RequestOption.LENS_FOCUS_DISTANCE to "android.lens.focusDistance",
        )
        assertEquals(RequestOption.entries.toSet(), expected.keys)
        RequestOption.entries.forEach { assertEquals(it.name, expected[it], RequestOptionMapping.spec(it).keyName) }
        assertEquals(RequestOption.entries.size, RequestOption.entries.map { RequestOptionMapping.spec(it).keyName }.toSet().size)
    }

    @Test
    fun `value types match what the plan sends`() {
        val confirmed = ControlLock(LockIntent.LOCKED, LockPhase.Confirmed)
        val states = listOf(
            ControlsState(caps),
            ControlsState(caps, exposure = ControlLock(LockIntent.LOCKED, LockPhase.Metering(1000)), compensationSteps = 2),
            ControlsState(
                caps,
                exposure = confirmed,
                whiteBalance = confirmed,
                focus = confirmed,
                frozenExposure = FrozenExposure(200, 10_000_000L, 33_333_333L),
                frozenWhiteBalance = FrozenWhiteBalance(gains, transform),
                frozenFocus = FrozenFocus(-0.5f),
            ),
        )
        val seen = mutableSetOf<RequestOption>()
        for (s in states) {
            for ((o, v) in ControlsPlan.options(s)) {
                assertTrue("$o = ${v::class.simpleName}", RequestOptionMapping.accepts(o, v))
                seen += o
            }
        }
        assertEquals("every option is exercised", RequestOption.entries.toSet(), seen)
    }

    @Test
    fun `accepts rejects a wrong numeric type`() {
        assertTrue(!RequestOptionMapping.accepts(RequestOption.SENSOR_EXPOSURE_TIME, 10))
        assertTrue(!RequestOptionMapping.accepts(RequestOption.LENS_FOCUS_DISTANCE, 1.0))
        assertEquals(ValueType.FLOAT, RequestOptionMapping.spec(RequestOption.LENS_FOCUS_DISTANCE).type)
    }

    @Test
    fun `gains and transform conversion`() {
        assertArrayEquals(floatArrayOf(1.9f, 1.0f, 1.0f, 1.6f), RequestOptionMapping.gainsArgs(gains), 0f)
        val r = RequestOptionMapping.transformArgs(transform)
        assertEquals(18, r.size)
        assertEquals(98_304, r[0]) // 1.5 * 65536
        assertEquals(65_536, r[1])
        assertEquals(-26_214, r[2]) // -0.4 * 65536 rounded
        assertEquals(0, r[12])
        for (i in 0 until 9) assertEquals(65_536, r[2 * i + 1])
        for (i in 0 until 9) assertEquals(transform.m[i], r[2 * i].toDouble() / r[2 * i + 1], 1.0 / 65_536)
    }

    @Test
    fun `port changes map to setControl args`() {
        assertEquals(SetControlArgs("exposure", mode = "locked"), ControlChange.Exposure(ControlMode.LOCKED).toArgs())
        assertEquals(SetControlArgs("whiteBalance", mode = "auto"), ControlChange.WhiteBalance(ControlMode.AUTO).toArgs())
        assertEquals(SetControlArgs("focus", mode = "locked"), ControlChange.Focus(FocusMode.LOCKED).toArgs())
        assertEquals(SetControlArgs("exposureCompensation", steps = -2), ControlChange.ExposureCompensation(-2).toArgs())
        assertEquals(SetControlArgs("rotation", degrees = 180), ControlChange.Rotation(180).toArgs())
        assertEquals(SetControlArgs("previewQuality", value = "high"), ControlChange.Preview(PreviewQuality.HIGH).toArgs())
    }
}
