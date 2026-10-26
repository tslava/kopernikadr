package pl.slava.kopernikadr.camera.camera

import android.hardware.camera2.CameraMetadata
import pl.slava.kopernikadr.camera.controls.Camera2
import pl.slava.kopernikadr.camera.controls.ColorGains
import pl.slava.kopernikadr.camera.controls.ColorTransform
import pl.slava.kopernikadr.camera.controls.ResultSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ResultSummaryMapperTest {
    @Test
    fun `all keys missing gives nulls`() {
        val s = ResultSummaryMapper.map(frameNumber = 42)
        assertEquals(ResultSummary(frameNumber = 42), s)
        listOf(
            s.captureIntent, s.aeMode, s.aeState, s.aeLock, s.compensation, s.iso, s.exposureTimeNs,
            s.frameDurationNs, s.awbMode, s.awbState, s.awbLock, s.ccMode, s.gains, s.transform, s.afMode, s.afState, s.lensState, s.focusDistance, s.timestampNs,
        ).forEach { assertNull(it) }
    }

    @Test
    fun `values pass through in Camera2 units`() {
        val s = ResultSummaryMapper.map(
            frameNumber = 7,
            captureIntent = 2,
            aeMode = 0,
            aeState = 2,
            aeLock = true,
            compensation = -2,
            iso = 400,
            exposureTimeNs = 16_666_666,
            frameDurationNs = 33_333_333,
            awbMode = 1,
            awbState = 3,
            awbLock = false,
            ccMode = 0,
            afMode = 4,
            afState = 2,
            lensState = 0,
            focusDistanceDiopters = 3.25f,
            sensorTimestampNs = 123_456_789_012,
        )
        assertEquals(2, s.captureIntent)
        assertEquals(0, s.aeMode)
        assertEquals(2, s.aeState)
        assertEquals(true, s.aeLock)
        assertEquals(-2, s.compensation)
        assertEquals(400, s.iso)
        assertEquals(16_666_666L, s.exposureTimeNs) // ns, not ms
        assertEquals(33_333_333L, s.frameDurationNs)
        assertEquals(1, s.awbMode)
        assertEquals(3, s.awbState)
        assertEquals(false, s.awbLock)
        assertEquals(0, s.ccMode)
        assertEquals(4, s.afMode)
        assertEquals(2, s.afState)
        assertEquals(0, s.lensState)
        assertEquals(3.25f, s.focusDistance!!, 0f) // diopters
        assertEquals(123_456_789_012L, s.timestampNs)
    }

    @Test
    fun `gains keep the order R, Gr, Gb, B`() {
        val s = ResultSummaryMapper.map(frameNumber = 1, gainsRggb = floatArrayOf(2.1f, 1.0f, 1.01f, 1.7f))
        assertEquals(ColorGains(r = 2.1f, gEven = 1.0f, gOdd = 1.01f, b = 1.7f), s.gains)
    }

    @Test
    fun `gains of the wrong length are dropped`() {
        assertNull(ResultSummaryMapper.map(frameNumber = 1, gainsRggb = floatArrayOf(1f, 2f, 3f)).gains)
    }

    @Test
    fun `transform rationals become row-major doubles`() {
        val ints = intArrayOf(
            128, 128, 0, 1, -1, 4,
            1, 2, 3, 2, 0, 1,
            0, 1, -64, 128, 256, 128,
        )
        val s = ResultSummaryMapper.map(frameNumber = 1, transformRationals = ints)
        assertEquals(ColorTransform(listOf(1.0, 0.0, -0.25, 0.5, 1.5, 0.0, 0.0, -0.5, 2.0)), s.transform)
    }

    @Test
    fun `transform with a zero denominator or the wrong length is null`() {
        val zeroDen = IntArray(18) { 1 }.also { it[5] = 0 } // third rational: 1/0
        assertNull(ResultSummaryMapper.map(frameNumber = 1, transformRationals = zeroDen).transform)
        assertNull(ResultSummaryMapper.map(frameNumber = 1, transformRationals = IntArray(16) { 1 }).transform)
    }

    @Test
    fun `transform survives the controls round trip through rationals`() {
        val t = ColorTransform.of(1.0, 0.0, -0.25, 0.5, 1.5, 0.0, 0.0, -0.5, 2.0)
        assertEquals(t, ResultSummaryMapper.map(frameNumber = 1, transformRationals = t.toRationals()).transform)
    }

    /** The :core [Camera2] constants mirror the framework's (compile-time constants, no framework call). */
    @Test
    fun `Camera2 constants equal CameraMetadata`() {
        assertEquals(CameraMetadata.CONTROL_CAPTURE_INTENT_PREVIEW, Camera2.CAPTURE_INTENT_PREVIEW)
        assertEquals(CameraMetadata.CONTROL_CAPTURE_INTENT_STILL_CAPTURE, Camera2.CAPTURE_INTENT_STILL_CAPTURE)
        assertEquals(CameraMetadata.CONTROL_MODE_OFF, Camera2.CONTROL_MODE_OFF)
        assertEquals(CameraMetadata.CONTROL_MODE_AUTO, Camera2.CONTROL_MODE_AUTO)
        assertEquals(CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_OFF, Camera2.AE_ANTIBANDING_MODE_OFF)
        assertEquals(CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_50HZ, Camera2.AE_ANTIBANDING_MODE_50HZ)
        assertEquals(CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_60HZ, Camera2.AE_ANTIBANDING_MODE_60HZ)
        assertEquals(CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_AUTO, Camera2.AE_ANTIBANDING_MODE_AUTO)
        assertEquals(CameraMetadata.CONTROL_AE_MODE_OFF, Camera2.AE_MODE_OFF)
        assertEquals(CameraMetadata.CONTROL_AE_MODE_ON, Camera2.AE_MODE_ON)
        assertEquals(CameraMetadata.CONTROL_AE_STATE_INACTIVE, Camera2.AE_STATE_INACTIVE)
        assertEquals(CameraMetadata.CONTROL_AE_STATE_SEARCHING, Camera2.AE_STATE_SEARCHING)
        assertEquals(CameraMetadata.CONTROL_AE_STATE_CONVERGED, Camera2.AE_STATE_CONVERGED)
        assertEquals(CameraMetadata.CONTROL_AE_STATE_LOCKED, Camera2.AE_STATE_LOCKED)
        assertEquals(CameraMetadata.CONTROL_AE_STATE_FLASH_REQUIRED, Camera2.AE_STATE_FLASH_REQUIRED)
        assertEquals(CameraMetadata.CONTROL_AE_STATE_PRECAPTURE, Camera2.AE_STATE_PRECAPTURE)
        assertEquals(CameraMetadata.CONTROL_AWB_MODE_OFF, Camera2.AWB_MODE_OFF)
        assertEquals(CameraMetadata.CONTROL_AWB_MODE_AUTO, Camera2.AWB_MODE_AUTO)
        assertEquals(CameraMetadata.CONTROL_AWB_STATE_INACTIVE, Camera2.AWB_STATE_INACTIVE)
        assertEquals(CameraMetadata.CONTROL_AWB_STATE_SEARCHING, Camera2.AWB_STATE_SEARCHING)
        assertEquals(CameraMetadata.CONTROL_AWB_STATE_CONVERGED, Camera2.AWB_STATE_CONVERGED)
        assertEquals(CameraMetadata.CONTROL_AWB_STATE_LOCKED, Camera2.AWB_STATE_LOCKED)
        assertEquals(CameraMetadata.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX, Camera2.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX)
        assertEquals(CameraMetadata.COLOR_CORRECTION_MODE_FAST, Camera2.COLOR_CORRECTION_MODE_FAST)
        assertEquals(CameraMetadata.COLOR_CORRECTION_MODE_HIGH_QUALITY, Camera2.COLOR_CORRECTION_MODE_HIGH_QUALITY)
        assertEquals(CameraMetadata.CONTROL_AF_MODE_OFF, Camera2.AF_MODE_OFF)
        assertEquals(CameraMetadata.CONTROL_AF_MODE_AUTO, Camera2.AF_MODE_AUTO)
        assertEquals(CameraMetadata.CONTROL_AF_MODE_MACRO, Camera2.AF_MODE_MACRO)
        assertEquals(CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO, Camera2.AF_MODE_CONTINUOUS_VIDEO)
        assertEquals(CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE, Camera2.AF_MODE_CONTINUOUS_PICTURE)
        assertEquals(CameraMetadata.CONTROL_AF_STATE_INACTIVE, Camera2.AF_STATE_INACTIVE)
        assertEquals(CameraMetadata.CONTROL_AF_STATE_PASSIVE_SCAN, Camera2.AF_STATE_PASSIVE_SCAN)
        assertEquals(CameraMetadata.CONTROL_AF_STATE_PASSIVE_FOCUSED, Camera2.AF_STATE_PASSIVE_FOCUSED)
        assertEquals(CameraMetadata.CONTROL_AF_STATE_ACTIVE_SCAN, Camera2.AF_STATE_ACTIVE_SCAN)
        assertEquals(CameraMetadata.CONTROL_AF_STATE_FOCUSED_LOCKED, Camera2.AF_STATE_FOCUSED_LOCKED)
        assertEquals(CameraMetadata.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED, Camera2.AF_STATE_NOT_FOCUSED_LOCKED)
        assertEquals(CameraMetadata.CONTROL_AF_STATE_PASSIVE_UNFOCUSED, Camera2.AF_STATE_PASSIVE_UNFOCUSED)
        assertEquals(CameraMetadata.LENS_STATE_STATIONARY, Camera2.LENS_STATE_STATIONARY)
        assertEquals(CameraMetadata.LENS_STATE_MOVING, Camera2.LENS_STATE_MOVING)
    }
}
