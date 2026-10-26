package pl.slava.kopernikadr.camera.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.ExposureLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.ProtocolJson
import pl.slava.kopernikadr.camera.protocol.Rational
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceLockMethod
import pl.slava.kopernikadr.camera.protocol.Size as WireSize

/**
 * Size selection and capability mapping against the real moto g05 back camera: `g05-caps.json` is
 * the `snapshot` of a `caps` run on the phone (probe build, CAMERA granted, 2026-10-26).
 */
class G05CapsTest {
    private val g05: CharacteristicsSnapshot = CharacteristicsSnapshot.Json.decodeFromString(
        CharacteristicsSnapshot.serializer(),
        checkNotNull(javaClass.getResource("/g05-caps.json")) { "g05-caps.json missing" }.readText(),
    )

    @Test
    fun `the dump is the g05 back camera read with the CAMERA permission`() {
        assertEquals("0", g05.cameraId)
        assertEquals("BACK", g05.lensFacing)
        assertEquals("FULL", g05.hardwareLevel)
        assertEquals(true, g05.cameraPermissionGranted)
        assertTrue(g05.hasManualSensor && g05.hasManualPostProcessing)
        assertEquals(90, g05.sensorOrientation)
        assertEquals(IntRect(0, 0, 4080, 3072), g05.activeArraySize)
        // Not exactly 4:3: 4:3 streams are a 4080x3060 crop of it (12 sensor rows lost, negligible).
        val active = g05.activeArraySize!!.size
        assertTrue("active array is not exact 4:3", !active.isExact4by3)
        assertEquals(3060, active.width * 3 / 4)
    }

    @Test
    fun `full is 3264x2448 from the real JPEG list`() {
        assertTrue(Size(3264, 2448) in g05.jpegSizes)
        assertEquals(Size(3264, 2448), SizeSelection.selectFull(g05.jpegSizes))
    }

    @Test
    fun `analysis is 1280x960 from the real YUV list`() {
        assertEquals(Size(1280, 960), SizeSelection.selectAnalysis(g05.yuvSizes))
    }

    @Test
    fun `preview is 960x720 from the real PRIVATE list`() {
        assertEquals(Size(960, 720), SizeSelection.selectPreview(g05.privateSizes))
    }

    @Test
    fun `preview, play and analysis 4 by 3 sizes are offered by the streams`() {
        for (s in listOf(Size(3264, 2448), Size(1440, 1080), Size(1280, 960), Size(960, 720))) {
            assertTrue("PRIVATE has $s", s in g05.privateSizes)
            assertTrue("YUV has $s", s in g05.yuvSizes)
        }
    }

    @Test
    fun `capabilities use freeze for exposure, white balance and focus`() {
        val caps = CapabilityMapper.map(g05)
        assertEquals(WireSize(3264, 2448), caps.sizes.full)
        assertEquals(ExposureLockMethod.FREEZE, caps.exposure.method)
        assertEquals(WhiteBalanceLockMethod.FREEZE, caps.whiteBalance.method)
        assertEquals(FocusLockMethod.FREEZE, caps.focusLock.method)
        assertEquals(listOf(FocusMode.AUTO, FocusMode.LOCKED), caps.focus.modes)
        assertEquals(10.0, caps.focus.minFocusDistanceDiopters!!, 0.0)
        with(caps.exposure.compensation) {
            assertTrue(supported)
            assertEquals(-4, minSteps)
            assertEquals(4, maxSteps)
            assertEquals(Rational(1, 2), stepEv)
        }
    }

    @Test
    fun `real capabilities equal the hello fixture capabilities`() {
        val fixture = java.io.File(pl.slava.kopernikadr.camera.protocol.Fixtures.dir, "hello.res.json").readText()
        val expected = Json.parseToJsonElement(fixture).jsonObject["data"]!!.jsonObject["capabilities"] as JsonObject
        assertEquals(expected, ProtocolJson.encodeToJsonElement(Capabilities.serializer(), CapabilityMapper.map(g05)))
    }

    @Test
    fun `without the CAMERA permission the same camera falls back to af_lock`() {
        val noPermission = g05.copy(cameraPermissionGranted = false, minFocusDistanceDiopters = null, hyperfocalDistanceDiopters = null)
        val caps = CapabilityMapper.map(noPermission)
        assertEquals(FocusLockMethod.AF_LOCK, caps.focusLock.method)
        assertEquals(ExposureLockMethod.FREEZE, caps.exposure.method)
    }
}
