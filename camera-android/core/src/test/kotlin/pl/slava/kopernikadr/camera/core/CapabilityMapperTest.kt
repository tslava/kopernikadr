package pl.slava.kopernikadr.camera.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.core.CharacteristicsSnapshot.Companion.CAP_BACKWARD_COMPATIBLE
import pl.slava.kopernikadr.camera.core.CharacteristicsSnapshot.Companion.CAP_MANUAL_POST_PROCESSING
import pl.slava.kopernikadr.camera.core.CharacteristicsSnapshot.Companion.CAP_MANUAL_SENSOR
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.ExposureLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.ProtocolJson
import pl.slava.kopernikadr.camera.protocol.Rational
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceLockMethod
import pl.slava.kopernikadr.camera.protocol.Size as WireSize

class CapabilityMapperTest {
    private fun sizes(vararg wh: Pair<Int, Int>) = wh.map { (w, h) -> Size(w, h) }

    /** Shaped like the moto g05 back camera (values from its real `caps` dump, g05-caps.json). */
    private val g05Like = CharacteristicsSnapshot(
        cameraId = "0",
        cameraPermissionGranted = true,
        lensFacing = "BACK",
        hardwareLevel = "FULL",
        capabilities = listOf(CAP_BACKWARD_COMPATIBLE, CAP_MANUAL_SENSOR, CAP_MANUAL_POST_PROCESSING, "READ_SENSOR_SETTINGS"),
        aeModes = listOf("OFF", "ON", "ON_AUTO_FLASH", "ON_ALWAYS_FLASH"),
        aeAntibandingModes = listOf("OFF", "50HZ", "60HZ", "AUTO"),
        awbModes = listOf("OFF", "AUTO", "DAYLIGHT"),
        afModes = listOf("OFF", "AUTO", "MACRO", "CONTINUOUS_VIDEO", "CONTINUOUS_PICTURE"),
        aeLockAvailable = true,
        awbLockAvailable = true,
        aeCompensationRange = IntSpan(-4, 4),
        aeCompensationStep = Ratio(1, 2),
        isoRange = IntSpan(100, 16_000),
        exposureTimeRangeNs = LongSpan(100_000, 32_000_000_000),
        maxFrameDurationNs = 32_000_000_000,
        // the real list has no 4080x3072 (that is a high-resolution-only size)
        jpegSizes = sizes(3072 to 3072, 4080 to 2296, 3840 to 2160, 3264 to 2448, 2560 to 1920, 1920 to 1080, 640 to 480),
        jpegHighResolutionSizes = sizes(4080 to 3072, 4032 to 3024),
        yuvSizes = sizes(3264 to 2448, 1280 to 960, 960 to 720),
        privateSizes = sizes(3264 to 2448, 1440 to 1080),
        activeArraySize = IntRect(0, 0, 4080, 3072),
        pixelArraySize = Size(4080, 3072),
        sensorOrientation = 90,
        minFocusDistanceDiopters = 10f,
        hyperfocalDistanceDiopters = 0.33333334f,
        focusDistanceCalibration = "UNCALIBRATED",
        focalLengthsMm = listOf(4.266f),
        maxDigitalZoom = 4f,
    )

    private val noManual = g05Like.copy(capabilities = listOf(CAP_BACKWARD_COMPATIBLE))

    @Test
    fun `g05-like snapshot maps to freeze everywhere`() {
        val caps = CapabilityMapper.map(g05Like)
        assertEquals("4:3", caps.aspect)
        assertEquals(WireSize(3264, 2448), caps.sizes.full)
        assertEquals(WireSize(1440, 1080), caps.sizes.play)
        assertEquals(WireSize(256, 192), caps.sizes.thumb)
        assertEquals(listOf(0, 180), caps.rotations)
        assertTrue(caps.exposure.lock)
        assertEquals(ExposureLockMethod.FREEZE, caps.exposure.method)
        assertTrue(caps.whiteBalance.lock)
        assertEquals(WhiteBalanceLockMethod.FREEZE, caps.whiteBalance.method)
        assertEquals(FocusLockMethod.FREEZE, caps.focusLock.method)
        assertEquals(listOf(FocusMode.AUTO, FocusMode.LOCKED), caps.focus.modes)
        assertEquals(10.0, caps.focus.minFocusDistanceDiopters!!, 0.0)
        assertEquals(listOf(PreviewQuality.LOW, PreviewQuality.NORMAL, PreviewQuality.HIGH), caps.previewQualities)
    }

    @Test
    fun `compensation comes from range and step`() {
        val c = CapabilityMapper.map(g05Like).exposure.compensation
        assertTrue(c.supported)
        assertEquals(-4, c.minSteps)
        assertEquals(4, c.maxSteps)
        assertEquals(Rational(1, 2), c.stepEv)
    }

    @Test
    fun `zero compensation range is unsupported`() {
        val c = CapabilityMapper.map(g05Like.copy(aeCompensationRange = IntSpan(0, 0))).exposure.compensation
        assertFalse(c.supported)
        assertEquals(0, c.minSteps)
        assertEquals(0, c.maxSteps)
    }

    @Test
    fun `missing compensation keys are unsupported`() {
        val c = CapabilityMapper.map(g05Like.copy(aeCompensationRange = null, aeCompensationStep = null))
            .exposure.compensation
        assertFalse(c.supported)
        assertEquals(Rational(0, 1), c.stepEv)
    }

    @Test
    fun `g05-like capabilities equal the hello fixture capabilities`() {
        val fixture = java.io.File(pl.slava.kopernikadr.camera.protocol.Fixtures.dir, "hello.res.json").readText()
        val expected = Json.parseToJsonElement(fixture).jsonObject["data"]!!.jsonObject["capabilities"] as JsonObject
        val actual = ProtocolJson.encodeToJsonElement(Capabilities.serializer(), CapabilityMapper.map(g05Like))
        assertEquals(expected, actual)
    }

    @Test
    fun `no manual capabilities fall back to the lock methods`() {
        val caps = CapabilityMapper.map(noManual)
        assertEquals(ExposureLockMethod.AE_LOCK, caps.exposure.method)
        assertTrue(caps.exposure.lock)
        assertEquals(WhiteBalanceLockMethod.AWB_LOCK, caps.whiteBalance.method)
        assertTrue(caps.whiteBalance.lock)
        assertEquals(FocusLockMethod.AF_LOCK, caps.focusLock.method)
        assertEquals(listOf(FocusMode.AUTO, FocusMode.LOCKED), caps.focus.modes)
    }

    @Test
    fun `manual post-processing alone freezes only white balance`() {
        val caps = CapabilityMapper.map(g05Like.copy(capabilities = listOf(CAP_MANUAL_POST_PROCESSING)))
        assertEquals(ExposureLockMethod.AE_LOCK, caps.exposure.method)
        assertEquals(WhiteBalanceLockMethod.FREEZE, caps.whiteBalance.method)
        assertEquals(FocusLockMethod.AF_LOCK, caps.focusLock.method)
    }

    @Test
    fun `no AE or AWB lock and no manual caps means not supported`() {
        val caps = CapabilityMapper.map(noManual.copy(aeLockAvailable = false, awbLockAvailable = null))
        assertFalse(caps.exposure.lock)
        assertNull(caps.exposure.method)
        assertFalse(caps.whiteBalance.lock)
        assertNull(caps.whiteBalance.method)
    }

    @Test
    fun `fixed-focus lens maps to fixed with no focus lock`() {
        for (minFocus in listOf(0f, null)) {
            val caps = CapabilityMapper.map(g05Like.copy(minFocusDistanceDiopters = minFocus, afModes = listOf("OFF")))
            assertEquals(listOf(FocusMode.FIXED), caps.focus.modes)
            assertNull(caps.focusLock.method)
            // exposure/WB freeze still work on a fixed lens
            assertEquals(ExposureLockMethod.FREEZE, caps.exposure.method)
        }
    }

    @Test
    fun `unknown min focus distance with AF auto falls back to af_lock`() {
        // LENS_INFO_MINIMUM_FOCUS_DISTANCE needs the CAMERA permission; without it the key is null.
        val caps = CapabilityMapper.map(g05Like.copy(minFocusDistanceDiopters = null, cameraPermissionGranted = false))
        assertEquals(FocusLockMethod.AF_LOCK, caps.focusLock.method)
        assertEquals(listOf(FocusMode.AUTO, FocusMode.LOCKED), caps.focus.modes)
        assertNull(caps.focus.minFocusDistanceDiopters)
    }

    @Test
    fun `unknown min focus distance without AF auto is fixed`() {
        val caps = CapabilityMapper.map(g05Like.copy(minFocusDistanceDiopters = null, afModes = listOf("OFF")))
        assertEquals(listOf(FocusMode.FIXED), caps.focus.modes)
        assertNull(caps.focusLock.method)
    }

    @Test
    fun `min focus distance keeps the float value without binary noise`() {
        val caps = CapabilityMapper.map(g05Like.copy(minFocusDistanceDiopters = 8.333333f))
        assertEquals(8.333333, caps.focus.minFocusDistanceDiopters!!, 0.0)
    }

    @Test
    fun `full falls back to the next lower 4 by 3 JPEG size`() {
        val caps = CapabilityMapper.map(g05Like.copy(jpegSizes = sizes(4000 to 3000, 2560 to 1920, 1920 to 1080)))
        assertEquals(WireSize(2560, 1920), caps.sizes.full)
    }

    @Test
    fun `no 4 by 3 JPEG size fails`() {
        assertThrows(NoSuitableSizeException::class.java) {
            CapabilityMapper.map(g05Like.copy(jpegSizes = sizes(1920 to 1080)))
        }
    }

    @Test
    fun `snapshot round-trips through JSON`() {
        val json = CharacteristicsSnapshot.Json.encodeToString(CharacteristicsSnapshot.serializer(), g05Like)
        assertEquals(g05Like, CharacteristicsSnapshot.Json.decodeFromString(CharacteristicsSnapshot.serializer(), json))
        assertTrue("sizes are written as width/height: $json", "\"width\": 3264" in json)
    }

    @Test
    fun `snapshot JSON ignores unknown keys and tolerates missing optional ones`() {
        val s = CharacteristicsSnapshot.Json.decodeFromString(
            CharacteristicsSnapshot.serializer(),
            """{"cameraId":"0","futureKey":1}""",
        )
        assertEquals("0", s.cameraId)
        assertTrue(s.jpegSizes.isEmpty())
        assertNull(s.minFocusDistanceDiopters)
    }
}
