package pl.slava.kopernikadr.camera.host

import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import pl.slava.kopernikadr.camera.camera.AnalysisFrame
import pl.slava.kopernikadr.camera.camera.CameraPort
import pl.slava.kopernikadr.camera.camera.CameraStatus
import pl.slava.kopernikadr.camera.camera.StillCapture
import pl.slava.kopernikadr.camera.controls.ResultSummary
import pl.slava.kopernikadr.camera.image.ImageIoCodec
import pl.slava.kopernikadr.camera.image.PreviewEncoder
import pl.slava.kopernikadr.camera.image.yuvFrame
import pl.slava.kopernikadr.camera.protocol.CaptureArgs
import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.PreviewLocks
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.Thermal
import pl.slava.kopernikadr.camera.server.ControlChange
import pl.slava.kopernikadr.camera.server.FakeControls
import pl.slava.kopernikadr.camera.server.PortResult
import pl.slava.kopernikadr.camera.spool.DirSync
import pl.slava.kopernikadr.camera.spool.DurableFiles

class HostTest {
    @get:Rule
    val tmp = TemporaryFolder()

    // ---- CaptureAdmission ----

    private val controls = MutableStateFlow(FakeControls.DEFAULT)
    private var ready = true
    private var free = 10_000_000_000L
    private fun admission(timeout: Long = 1_500) =
        CaptureAdmission(controls, { controls.value }, { ready }, { free }, settleTimeoutMs = timeout)

    private fun args(rotation: Int = 0) = CaptureArgs("p1", rotation)

    @Test
    fun `admission passes when everything is fine`() = runTest {
        assertNull(admission().check(args()))
    }

    @Test
    fun `rotation mismatch is GEOMETRY_MISMATCH, not retryable`() = runTest {
        val e = admission().check(args(rotation = 180))!!
        assertEquals(ErrorCodes.GEOMETRY_MISMATCH, e.code)
        assertEquals(false, e.retryable)
    }

    @Test
    fun `camera not open is CAMERA_NOT_READY, retryable`() = runTest {
        ready = false
        val e = admission().check(args())!!
        assertEquals(ErrorCodes.CAMERA_NOT_READY, e.code)
        assertTrue(e.retryable)
    }

    @Test
    fun `less than 500 MB free is STORAGE_LOW`() = runTest {
        free = 499_999_999
        assertEquals(ErrorCodes.STORAGE_LOW, admission().check(args())!!.code)
        free = 500_000_000
        assertNull(admission().check(args()))
    }

    @Test
    fun `settling waits for the locks to settle`() = runTest {
        controls.value = FakeControls.DEFAULT.copy(settling = true)
        val r = async { admission().check(args()) }
        delay(1_000)
        controls.value = FakeControls.DEFAULT.copy(settling = false)
        assertNull(r.await())
    }

    @Test
    fun `settling longer than the timeout is CAMERA_NOT_READY`() = runTest {
        controls.value = FakeControls.DEFAULT.copy(settling = true)
        val e = admission().check(args())!!
        assertEquals(ErrorCodes.CAMERA_NOT_READY, e.code)
        assertTrue(e.retryable)
    }

    // ---- ThermalMapping ----

    @Test
    fun `thermal status maps to the wire enum`() {
        val expected = listOf(Thermal.NONE, Thermal.LIGHT, Thermal.MODERATE, Thermal.SEVERE, Thermal.CRITICAL, Thermal.EMERGENCY, Thermal.SHUTDOWN)
        expected.forEachIndexed { i, t -> assertEquals(t, ThermalMapping.fromAndroid(i)) }
        assertEquals(Thermal.UNKNOWN, ThermalMapping.fromAndroid(-1))
        assertEquals(Thermal.UNKNOWN, ThermalMapping.fromAndroid(7))
    }

    // ---- IdentityStore ----

    @Test
    fun `cameraId is created once, persisted and reused`() {
        val syncs = AtomicInteger()
        val files = DurableFiles(DirSync { syncs.incrementAndGet() })
        val dir = File(tmp.root, "files")
        val id = IdentityStore(dir, files).cameraId()
        assertTrue(File(dir, IdentityStore.FILE_NAME).isFile)
        assertTrue(syncs.get() > 0)
        assertEquals(id, IdentityStore(dir, files).cameraId())
        assertEquals(id, IdentityStore(dir, files, newId = { error("must not create") }).cameraId())
    }

    @Test
    fun `corrupt identity file is replaced`() {
        val dir = tmp.newFolder("files")
        File(dir, IdentityStore.FILE_NAME).writeText("{nope")
        val files = DurableFiles(DirSync.NONE)
        val id = IdentityStore(dir, files, newId = { "6b1f6f1e-0c5e-4a8e-9d2c-1f3a4b5c6d7e" }).cameraId()
        assertEquals("6b1f6f1e-0c5e-4a8e-9d2c-1f3a4b5c6d7e", id)
        assertEquals(id, IdentityStore(dir, files).cameraId())
    }

    // ---- GuardedControls ----

    @Test
    fun `rotation is rejected while capturing, other controls pass`() = runTest {
        var capturing = true
        val g = GuardedControls(FakeControls(), Mutex(), { capturing })
        val r = g.set(ControlChange.Rotation(180))
        assertEquals(ErrorCodes.CAPTURE_IN_PROGRESS, (r as PortResult.Err).error.code)
        assertTrue(g.set(ControlChange.Exposure(ControlMode.LOCKED)) is PortResult.Ok)
        capturing = false
        assertEquals(180, (g.set(ControlChange.Rotation(180)) as PortResult.Ok).value.rotation)
    }

    // ---- CameraPreviewSource ----

    private class FrameCamera : CameraPort {
        override val status = MutableStateFlow(CameraStatus(bound = true, open = true))
        override val results = MutableSharedFlow<ResultSummary>()
        override fun latestResult(): ResultSummary? = null
        override suspend fun takePicture(): StillCapture = error("not used")

        val frames = kotlinx.coroutines.channels.Channel<AnalysisFrame>(capacity = 16)
        val requests = AtomicInteger()

        override suspend fun <T> withNextAnalysisFrame(block: (AnalysisFrame) -> T): T {
            requests.incrementAndGet()
            return block(frames.receive())
        }
    }

    @Test
    fun `preview frames are upright 4x3 JPEGs with increasing seq and the controls' locks`() = runBlocking {
        val cam = FrameCamera()
        val c = FakeControls.DEFAULT.copy(
            generation = 9,
            exposure = FakeControls.DEFAULT.exposure.copy(mode = ControlMode.LOCKED),
        )
        val src = CameraPreviewSource(cam, PreviewEncoder(ImageIoCodec()), { c }, clock = { 1234L })
        assertEquals(0L, src.currentSeq())
        cam.frames.send(yuvFrame(640, 480))
        val a = src.nextFrame(PreviewQuality.LOW, 0)
        assertEquals(1L, a.seq)
        assertEquals(640, a.w)
        assertEquals(480, a.h)
        assertEquals(1234L, a.ts)
        assertEquals(9L, a.generation)
        assertEquals(PreviewLocks(ControlMode.LOCKED, ControlMode.AUTO, FocusMode.AUTO), a.locks)
        assertEquals(0xFF.toByte(), a.jpeg[0])
        assertEquals(0xD8.toByte(), a.jpeg[1])
        assertEquals(1L, src.currentSeq())

        // A frame newer than afterSeq at the same quality is reused, without a new analysis frame.
        assertEquals(1L, src.nextFrame(PreviewQuality.LOW, 0).seq)
        assertEquals(1, cam.requests.get())

        cam.frames.send(yuvFrame(640, 480))
        val b = src.nextFrame(PreviewQuality.NORMAL, 1)
        assertEquals(2L, b.seq)
        assertEquals(960, b.w)
        assertEquals(720, b.h)
    }

    @Test
    fun `preview keeps waiting after an encode failure`() = runBlocking {
        val cam = FrameCamera()
        val logged = CompletableDeferred<String>()
        val src = CameraPreviewSource(cam, PreviewEncoder(ImageIoCodec()), { FakeControls.DEFAULT }, retryDelayMs = 1, log = { logged.complete(it) })
        val job = async { withTimeout(5_000) { src.nextFrame(PreviewQuality.LOW, 0) } }
        cam.frames.send(yuvFrame(640, 480, rotationDegrees = 90)) // 90° is rejected by FrameTransform
        assertTrue(withTimeout(5_000) { logged.await() }.startsWith("preview encode failed"))
        launch { cam.frames.send(yuvFrame(640, 480)) }
        val f = job.await()
        assertNotEquals(0L, f.seq)
        assertEquals(640, f.w)
    }
}
