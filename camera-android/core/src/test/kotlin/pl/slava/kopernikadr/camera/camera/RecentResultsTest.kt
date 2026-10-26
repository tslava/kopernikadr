package pl.slava.kopernikadr.camera.camera

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.controls.Camera2
import pl.slava.kopernikadr.camera.controls.ColorGains
import pl.slava.kopernikadr.camera.controls.ResultSummary

class RecentResultsTest {
    private fun r(frame: Long, ts: Long?, iso: Int? = null) = ResultSummary(frameNumber = frame, timestampNs = ts, iso = iso)

    // ---- StillPairing ----

    @Test
    fun `match needs the exact sensor timestamp`() {
        val list = listOf(r(1, 1_000), r(2, 34_000_000), r(3, 67_000_000))
        assertEquals(2L, StillPairing.match(34_000_000, list)?.frameNumber)
        assertNull(StillPairing.match(34_000_001, list))
        assertNull(StillPairing.match(5, emptyList()))
    }

    @Test
    fun `match ignores results without a timestamp and prefers the newest duplicate`() {
        val list = listOf(r(1, null), r(2, 500, iso = 100), r(3, 500, iso = 200))
        assertEquals(200, StillPairing.match(500, list)?.iso)
        assertNull(StillPairing.match(0, listOf(r(1, null))))
    }

    @Test
    fun `nearest reports the signed delta of the closest candidate`() {
        val list = listOf(r(1, 1_000), r(2, 2_000), r(3, null), r(4, 3_500))
        val (res, delta) = StillPairing.nearest(3_000, list)!!
        assertEquals(4L, res.frameNumber)
        assertEquals(500L, delta)
        assertEquals(-1_000L, StillPairing.nearest(3_000, list.take(2))!!.second)
        assertNull(StillPairing.nearest(3_000, listOf(r(1, null))))
    }

    // ---- RecentResults ----

    @Test
    fun `ring keeps the last capacity results and counts all`() {
        val ring = RecentResults(3)
        (1L..5L).forEach { ring.add(r(it, it * 10)) }
        assertEquals(listOf(3L, 4L, 5L), ring.snapshot().map { it.frameNumber })
        assertEquals(5L, ring.count)
        assertEquals(5L, ring.latest()?.frameNumber)
        assertNull(ring.find(10))
        assertEquals(4L, ring.find(40)?.frameNumber)
        ring.clear()
        assertNull(ring.latest())
        assertEquals(0L, ring.count)
    }

    @Test
    fun `capacity must be positive`() {
        assertThrows(IllegalArgumentException::class.java) { RecentResults(0) }
    }

    @Test
    fun `await returns a result that is already there`() = runTest {
        val ring = RecentResults(4)
        ring.add(r(7, 700))
        assertEquals(7L, ring.awaitTimestamp(700, timeoutMs = 10)?.frameNumber)
    }

    @Test
    fun `await waits for a result that arrives after the image`() = runTest {
        val ring = RecentResults(4)
        val waiting = async { ring.awaitTimestamp(900, timeoutMs = 1_000) }
        launch {
            delay(100)
            ring.add(r(8, 800))
            delay(100)
            ring.add(r(9, 900))
        }
        assertEquals(9L, waiting.await()?.frameNumber)
    }

    @Test
    fun `await gives null on timeout`() = runTest {
        val ring = RecentResults(4)
        launch {
            delay(50)
            ring.add(r(1, 1))
        }
        assertNull(ring.awaitTimestamp(2, timeoutMs = 500))
    }

    // ---- FrameRateMeter ----

    @Test
    fun `fps over the window`() {
        val m = FrameRateMeter(capacity = 4)
        assertNull(m.fps())
        m.record(0)
        assertNull(m.fps())
        m.record(33_333_333)
        assertEquals(30.0, m.fps()!!, 0.01)
        // 10 frames at 10 fps; only the last 4 count
        val m2 = FrameRateMeter(capacity = 4)
        (0 until 10).forEach { m2.record(1_000_000_000L + it * 100_000_000L) }
        assertEquals(10.0, m2.fps()!!, 1e-9)
        assertEquals(10L, m2.count)
    }

    @Test
    fun `fps window slides`() {
        val m = FrameRateMeter(capacity = 3)
        listOf(0L, 50_000_000L, 100_000_000L).forEach(m::record) // 20 fps
        assertEquals(20.0, m.fps()!!, 1e-9)
        listOf(200_000_000L, 300_000_000L, 400_000_000L).forEach(m::record) // 10 fps
        assertEquals(10.0, m.fps()!!, 1e-9)
        m.reset()
        assertNull(m.fps())
        assertEquals(0L, m.count)
    }

    @Test
    fun `zero span gives null`() {
        val m = FrameRateMeter(capacity = 2)
        m.record(5)
        m.record(5)
        assertNull(m.fps())
        assertThrows(IllegalArgumentException::class.java) { FrameRateMeter(1) }
    }

    // ---- ResultSummary (controls type) log form + serialization ----

    @Test
    fun `short form names states and keeps nulls`() {
        val s = ResultSummary(
            frameNumber = 12, aeMode = Camera2.AE_MODE_ON, aeState = Camera2.AE_STATE_CONVERGED, iso = 200,
            exposureTimeNs = 10_000_000, awbMode = Camera2.AWB_MODE_AUTO, awbState = 9,
            gains = ColorGains(2f, 1f, 1f, 1.5f), afMode = Camera2.AF_MODE_OFF, focusDistance = 4.1f, timestampNs = 77,
        ).short()
        assertTrue(s, s.startsWith("#12 ae=ON/CONVERGED iso=200 t=10.000ms fd=null awb=AUTO/UNKNOWN_9"))
        assertTrue(s, s.contains("gains=2.000,1.000,1.000,1.500"))
        assertTrue(s, s.contains("af=OFF/null lens=null d=4.10dpt ts=77"))
    }

    @Test
    fun `serializes without nulls for probe reports`() {
        val json = Json { explicitNulls = false }
        val s = ResultSummary(3, captureIntent = Camera2.CAPTURE_INTENT_STILL_CAPTURE, iso = 100, gains = ColorGains(1f, 2f, 3f, 4f))
        val text = json.encodeToString(ResultSummary.serializer(), s)
        assertEquals("""{"frameNumber":3,"captureIntent":2,"iso":100,"gains":{"r":1.0,"gEven":2.0,"gOdd":3.0,"b":4.0}}""", text)
        assertEquals(s, json.decodeFromString(ResultSummary.serializer(), text))
    }
}
