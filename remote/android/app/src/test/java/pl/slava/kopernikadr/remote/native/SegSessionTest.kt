package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class SegSessionTest {
    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var guard: PathGuard
    private lateinit var state: File
    private val loader = FakeLoader()
    private val created = mutableListOf<FakeEngine>()
    private var factory: (Boolean) -> SegEngine = { gpu -> FakeEngine(gpu).also { created += it } }
    private var now = 0L
    private var n = 0
    private lateinit var seg: SegSession
    private val stroke = SegStroke(false, listOf(0.5f to 0.5f))

    @Before
    fun setUp() {
        guard = PathGuard.forFilesDir(temp.newFolder("files"))
        state = File(temp.root, "state")
        seg = SegSession(guard, loader, { gpu -> factory(gpu) }, state, clock = { now }, idleMs = 1000, ids = { "h${++n}" })
    }

    private fun source(name: String = "tmp/pick-1.jpg"): String {
        File(guard.root, name).also { it.parentFile!!.mkdirs(); it.writeBytes(byteArrayOf(9, 9)) }
        return name
    }

    private fun file(rel: String) = File(guard.root, rel)

    private fun segFiles() = file("tmp").listFiles().orEmpty().map { it.name }.filter { it.startsWith("seg-") }.sorted()

    @Test
    fun openWritesTheImageDeletesTheSourceAndCreatesNoEngine() {
        val o = seg.open(source(), 1024)
        assertEquals("h1", o.handle)
        assertEquals("tmp/seg-h1.png", o.image)
        assertEquals(8, o.width)
        assertEquals(6, o.height)
        assertFalse(o.hasAlpha)
        assertFalse("source is deleted", file("tmp/pick-1.jpg").exists())
        assertTrue(file(o.image).isFile)
        assertEquals(listOf(Triple("pick-1.jpg", "seg-h1.png", 1024)), loader.calls)
        assertTrue("no engine yet", created.isEmpty())
    }

    @Test
    fun openRejectsSourcesOutsideTmpAndMissingOnes() {
        expectCode(NativeErrorCode.PATH_INVALID) { seg.open("exports/a.jpg", 1024) }
        expectCode(NativeErrorCode.PATH_INVALID) { seg.open("tmp/../x.jpg", 1024) }
        expectCode(NativeErrorCode.NOT_FOUND) { seg.open("tmp/none.jpg", 1024) }
    }

    @Test
    fun aFailedDecodeKeepsTheSourceAndLeavesNoSessionFiles() {
        val failing = ImageLoader { _, dest, _ ->
            dest.writeBytes(byteArrayOf(1))
            raise(NativeErrorCode.UNSUPPORTED, "cannot decode")
        }
        val s = SegSession(guard, failing, { FakeEngine() }, state, ids = { "x" })
        expectCode(NativeErrorCode.UNSUPPORTED) { s.open(source(), 1024) }
        assertTrue(file("tmp/pick-1.jpg").isFile)
        assertEquals(emptyList<String>(), segFiles())
    }

    @Test
    fun openingAnotherSessionClosesTheFirst() {
        val a = seg.open(source("tmp/a.jpg"), 1024)
        val b = seg.open(source("tmp/b.jpg"), 1024)
        assertEquals(listOf("seg-${b.handle}.png"), segFiles())
        expectCode(NativeErrorCode.NO_SESSION) { seg.run(a.handle, listOf(stroke)) }
    }

    @Test
    fun runWritesTheRawMaskAndReportsTheDelegate() {
        val h = seg.open(source(), 1024).handle
        val r = seg.run(h, listOf(stroke))
        assertEquals("tmp/seg-h1.mask", r.mask)
        assertEquals(8, r.width)
        assertEquals(6, r.height)
        assertEquals("gpu", r.delegate)
        assertEquals(48L, file(r.mask).length())
        assertArrayEquals(ByteArray(48) { 200.toByte() }, file(r.mask).readBytes())
        assertEquals(1, created.size)
        assertTrue(created[0].gpu)
        assertEquals(1, created[0].images)
    }

    @Test
    fun theEngineIsKeptForLaterRunsAndGetsTheWholeStrokeList() {
        val h = seg.open(source(), 1024).handle
        seg.run(h, listOf(stroke))
        val two = listOf(stroke, SegStroke(true, listOf(0.1f to 0.2f)))
        seg.run(h, two)
        assertEquals(1, created.size)
        assertEquals(1, created[0].images)
        assertEquals(2, created[0].segments)
        assertEquals(two, created[0].lastStrokes)
    }

    @Test
    fun theGpuMarkerIsWrittenBeforeTheEngineAndGoneAfterAGoodRun() {
        factory = { gpu ->
            assertTrue("marker is written before the engine is created", File(state, "seg-gpu-attempt").isFile)
            FakeEngine(gpu).also { created += it }
        }
        seg.run(seg.open(source(), 1024).handle, listOf(stroke))
        assertFalse(File(state, "seg-gpu-attempt").exists())
        assertFalse(File(state, "seg-gpu-disabled").exists())
    }

    @Test
    fun aGpuExceptionFallsBackToCpuWithANewImageAndOneRetry() {
        factory = { gpu ->
            FakeEngine(gpu, onSegment = { e, _ -> if (e.gpu) throw IllegalStateException("gl failed") }).also { created += it }
        }
        val h = seg.open(source(), 1024).handle
        val r = seg.run(h, listOf(stroke))
        assertEquals("cpu", r.delegate)
        assertEquals(2, created.size)
        assertTrue(created[0].closed)
        assertFalse(created[1].gpu)
        assertEquals("setImage again on the CPU engine", 1, created[1].images)
        assertEquals(1, created[1].segments)
        assertFalse(File(state, "seg-gpu-attempt").exists())
        assertTrue("GPU stays off", File(state, "seg-gpu-disabled").exists())
        // later runs and later sessions go straight to CPU
        seg.run(h, listOf(stroke))
        assertEquals(2, created.size)
        seg.run(seg.open(source("tmp/p2.jpg"), 1024).handle, listOf(stroke))
        assertFalse(created[2].gpu)
    }

    @Test
    fun aGpuExceptionWhileCreatingTheEngineAlsoFallsBack() {
        factory = { gpu -> if (gpu) throw IllegalStateException("no gl") else FakeEngine(false).also { created += it } }
        val r = seg.run(seg.open(source(), 1024).handle, listOf(stroke))
        assertEquals("cpu", r.delegate)
        assertEquals(1, created.size)
    }

    @Test
    fun aMarkerLeftByACrashMeansCpuFromNowOn() {
        state.mkdirs()
        File(state, "seg-gpu-attempt").writeText("1")
        val r = seg.run(seg.open(source(), 1024).handle, listOf(stroke))
        assertEquals("cpu", r.delegate)
        assertFalse(created[0].gpu)
        assertFalse(File(state, "seg-gpu-attempt").exists())
        assertTrue(File(state, "seg-gpu-disabled").exists())
    }

    @Test
    fun theDisabledFlagKeepsGpuOffWithoutAnAttempt() {
        state.mkdirs()
        File(state, "seg-gpu-disabled").writeText("crash")
        val r = seg.run(seg.open(source(), 1024).handle, listOf(stroke))
        assertEquals("cpu", r.delegate)
        assertFalse(File(state, "seg-gpu-attempt").exists())
    }

    @Test
    fun aCpuFailureIsSegFailedAndTheNextRunStartsAFreshEngine() {
        state.mkdirs()
        File(state, "seg-gpu-disabled").writeText("x")
        var fail = true
        factory = { gpu -> FakeEngine(gpu, onSegment = { _, _ -> if (fail) throw IllegalStateException("boom") }).also { created += it } }
        val h = seg.open(source(), 1024).handle
        expectCode(NativeErrorCode.SEG_FAILED) { seg.run(h, listOf(stroke)) }
        assertTrue(created[0].closed)
        fail = false
        assertEquals("cpu", seg.run(h, listOf(stroke)).delegate)
    }

    @Test
    fun bothDelegatesFailingIsSegFailed() {
        factory = { gpu -> FakeEngine(gpu, onSegment = { _, _ -> throw IllegalStateException("boom") }).also { created += it } }
        expectCode(NativeErrorCode.SEG_FAILED) { seg.run(seg.open(source(), 1024).handle, listOf(stroke)) }
        assertTrue(created.all { it.closed })
    }

    @Test
    fun aMissingModelIsReportedAndDoesNotDisableGpu() {
        factory = { raise(NativeErrorCode.MODEL_MISSING, "no model") }
        val h = seg.open(source(), 1024).handle
        expectCode(NativeErrorCode.MODEL_MISSING) { seg.run(h, listOf(stroke)) }
        assertFalse(File(state, "seg-gpu-attempt").exists())
        assertFalse(File(state, "seg-gpu-disabled").exists())
    }

    @Test
    fun closeDeletesTheSessionFilesAndTheEngineAndIsIdempotent() {
        val h = seg.open(source(), 1024).handle
        seg.run(h, listOf(stroke))
        assertEquals(listOf("seg-h1.mask", "seg-h1.png"), segFiles())
        seg.close(h)
        assertEquals(emptyList<String>(), segFiles())
        assertTrue(created[0].closed)
        seg.close(h)
        seg.close("unknown")
    }

    @Test
    fun aRunAfterCloseIsNoSession() {
        val h = seg.open(source(), 1024).handle
        seg.close(h)
        expectCode(NativeErrorCode.NO_SESSION) { seg.run(h, listOf(stroke)) }
        expectCode(NativeErrorCode.NO_SESSION) { seg.run("nope", listOf(stroke)) }
    }

    @Test
    fun closeIdleClosesOnlyTheStaleSessions() {
        val h = seg.open(source(), 1024).handle
        seg.run(h, listOf(stroke))
        now = 999
        assertEquals(0, seg.closeIdle())
        now = 1500
        seg.run(h, listOf(stroke)) // a run refreshes the idle clock
        now = 2400
        assertEquals(0, seg.closeIdle())
        now = 2500
        assertEquals(1, seg.closeIdle())
        assertEquals(emptyList<String>(), segFiles())
        assertTrue(created[0].closed)
        expectCode(NativeErrorCode.NO_SESSION) { seg.run(h, listOf(stroke)) }
    }

    @Test
    fun closeAllClosesEverything() {
        val h = seg.open(source(), 1024).handle
        seg.run(h, listOf(stroke))
        seg.closeAll()
        assertEquals(emptyList<String>(), segFiles())
        assertTrue(created[0].closed)
    }
}
