package pl.slava.kopernikadr.camera.spool

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import pl.slava.kopernikadr.camera.camera.AnalysisFrame
import pl.slava.kopernikadr.camera.camera.CameraNotReadyException
import pl.slava.kopernikadr.camera.camera.CameraPort
import pl.slava.kopernikadr.camera.camera.CameraStatus
import pl.slava.kopernikadr.camera.camera.StillCapture
import pl.slava.kopernikadr.camera.controls.ResultSummary
import pl.slava.kopernikadr.camera.image.ImageIoCodec
import pl.slava.kopernikadr.camera.image.StillPipeline
import pl.slava.kopernikadr.camera.image.markedStill
import pl.slava.kopernikadr.camera.protocol.CaptureArgs
import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.ExposureInfo
import pl.slava.kopernikadr.camera.protocol.FrameInfo
import pl.slava.kopernikadr.camera.protocol.OperationState
import pl.slava.kopernikadr.camera.protocol.ProtocolError
import pl.slava.kopernikadr.camera.server.FrameFile
import pl.slava.kopernikadr.camera.server.FrameVariant
import pl.slava.kopernikadr.camera.server.PortResult

class FakeStillCamera(var still: () -> StillCapture = { markedStill(640, 480) }) : CameraPort {
    override val status = MutableStateFlow(CameraStatus(bound = true, open = true))
    override val results = MutableSharedFlow<ResultSummary>()
    override fun latestResult(): ResultSummary? = null

    val calls = AtomicInteger()
    var gate: CompletableDeferred<Unit>? = null
    val entered = CompletableDeferred<Unit>()
    var failure: Throwable? = null

    override suspend fun takePicture(): StillCapture {
        calls.incrementAndGet()
        entered.complete(Unit)
        gate?.await()
        failure?.let { throw it }
        return still()
    }

    override suspend fun <T> withNextAnalysisFrame(block: (AnalysisFrame) -> T): T = error("not used")
}

class SpoolCaptureServiceTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var spool: Spool
    private lateinit var scope: CoroutineScope
    private lateinit var camera: FakeStillCamera
    private lateinit var service: SpoolCaptureService
    private lateinit var store: SpoolFrameStore
    private var check: ProtocolError? = null
    private val args = CaptureArgs("p1", 0)

    @Before
    fun setUp() {
        spool = Spool.open(File(tmp.root, "spool"), BundledSQLiteDriver())
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        camera = FakeStillCamera()
        val pipeline = StillPipeline(ImageIoCodec())
        val files = DurableFiles(DirSync.NONE)
        val derived = DerivedFiles(spool, pipeline, files)
        service = SpoolCaptureService(
            camera, pipeline, spool, files, derived, scope,
            admissionCheck = { _, _ -> check },
        )
        store = SpoolFrameStore(spool, derived)
    }

    @After
    fun tearDown() {
        scope.cancel()
        spool.close()
    }

    private fun PortResult<FrameInfo>.ok(): FrameInfo = (this as? PortResult.Ok)?.value ?: error("expected Ok, got $this")
    private fun PortResult<FrameInfo>.code(): String = (this as? PortResult.Err)?.error?.code ?: error("expected Err, got $this")

    @Test
    fun `success commits a durable full file and replays without a second takePicture`() = runBlocking {
        camera.still = { markedStill(640, 480, result = ResultSummary(1, iso = 200, exposureTimeNs = 16_666_666)) }
        val info = service.capture("c1", "r1", args).ok()
        assertEquals(1L, info.seq)
        assertEquals(640, info.full.w)
        assertEquals(480, info.full.h)
        assertEquals(ExposureInfo(200, 16_666_666), info.exposure)
        assertTrue(info.capturedAt.matches(Regex("""\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z""")))
        val full = spool.file(info.frameId, FrameVariant.FULL)
        assertEquals(info.full.bytes, full.length())
        assertEquals(info.full.sha256, DurableFiles.sha256(full.readBytes()))

        assertEquals(info, service.capture("c1", "r1", args).ok())
        assertEquals(1, camera.calls.get())
        assertEquals(OperationState.Done(info), service.getOperation("c1", "r1"))

        // background caches appear
        withTimeout(10_000) {
            while (!spool.file(info.frameId, FrameVariant.PLAY).isFile || !spool.file(info.frameId, FrameVariant.THUMB).isFile) delay(20)
        }
    }

    @Test
    fun `second capture while one runs gets CAPTURE_IN_PROGRESS, same reqId awaits the same result`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        camera.gate = gate
        val first = async { service.capture("c1", "r1", args) }
        camera.entered.await()
        assertTrue(service.isCapturing)
        assertEquals(OperationState.Pending, service.getOperation("c1", "r1"))
        assertEquals(ErrorCodes.CAPTURE_IN_PROGRESS, service.capture("c1", "r2", args).code())
        val again = async { service.capture("c1", "r1", args) }
        delay(50)
        gate.complete(Unit)
        val a = first.await().ok()
        assertEquals(a, again.await().ok())
        assertEquals(1, camera.calls.get())
        assertFalse(service.isCapturing)
        // r2 was rejected at admission: never recorded
        assertEquals(OperationState.Unknown, service.getOperation("c1", "r2"))
    }

    @Test
    fun `camera not ready records a failed row and replays the failure`() = runBlocking {
        camera.failure = CameraNotReadyException("unbound")
        val r = service.capture("c1", "r1", args)
        assertEquals(ErrorCodes.CAMERA_NOT_READY, r.code())
        assertTrue(service.getOperation("c1", "r1") is OperationState.Failed)
        camera.failure = null
        assertEquals(ErrorCodes.CAMERA_NOT_READY, service.capture("c1", "r1", args).code())
        assertEquals(1, camera.calls.get())
    }

    @Test
    fun `other camera failure is CAPTURE_FAILED and leaves no file`() = runBlocking {
        camera.failure = RuntimeException("hal error")
        assertEquals(ErrorCodes.CAPTURE_FAILED, service.capture("c1", "r1", args).code())
        val op = service.getOperation("c1", "r1") as OperationState.Failed
        assertEquals(ErrorCodes.CAPTURE_FAILED, op.error.code)
        assertTrue(spool.dir.listFiles()!!.none { it.name.endsWith(".jpg") })
        // the next capture works
        camera.failure = null
        assertEquals(2L, service.capture("c1", "r2", args).ok().seq)
    }

    @Test
    fun `undecodable still is CAPTURE_FAILED`() = runBlocking {
        val good = markedStill(640, 480)
        camera.still = {
            StillCapture(byteArrayOf(1, 2, 3), good.bufferSize, good.cropRect, 0, 0, null, good.pairing, good.timings)
        }
        assertEquals(ErrorCodes.CAPTURE_FAILED, service.capture("c1", "r1", args).code())
    }

    @Test
    fun `reqId reused with other args, bad rotation, admission hook`() = runBlocking {
        service.capture("c1", "r1", args).ok()
        assertEquals(ErrorCodes.REQ_ID_REUSED, service.capture("c1", "r1", CaptureArgs("p1", 180)).code())
        assertEquals(ErrorCodes.INVALID_ARGS, service.capture("c1", "r2", CaptureArgs("p1", 90)).code())
        check = ProtocolError(ErrorCodes.GEOMETRY_MISMATCH, "rotation")
        assertEquals(ErrorCodes.GEOMETRY_MISMATCH, service.capture("c1", "r3", args).code())
        assertEquals(OperationState.Unknown, service.getOperation("c1", "r3"))
        assertEquals(1, camera.calls.get())
    }

    @Test
    fun `rotation 180 stores rotation and the flipped image`() = runBlocking {
        val info = service.capture("c1", "r1", CaptureArgs("p1", 180)).ok()
        assertEquals(180, info.rotation)
        val img = ImageIoCodec.read(spool.file(info.frameId, FrameVariant.FULL).readBytes())
        assertTrue(ImageIoCodec.near(img.getRGB(10, 10) and 0xFFFFFF, 0x0000FF))
    }

    @Test
    fun `pending row left by a dead process is failed INTERRUPTED, never re-executed`() = runBlocking {
        val p = spool.insertPending("c1", "r1", SpoolCaptureService.argsHash(args), "p1", 0)
        assertEquals(ErrorCodes.INTERRUPTED, service.capture("c1", "r1", args).code())
        assertEquals(0, camera.calls.get())
        assertEquals(SpoolLookup.Failed(ErrorCodes.INTERRUPTED, "interrupted by an app restart"), spool.lookup("c1", "r1", SpoolCaptureService.argsHash(args)))
        assertNull(spool.frame(p.frameId))
    }

    @Test
    fun `frame store lists, acks and serves files with on-demand caches`() = runBlocking {
        val info = service.capture("c1", "r1", args).ok()
        assertEquals(listOf(info), store.listUnacked("c1", null, 10).frames)
        assertTrue(store.listUnacked("c2", null, 10).frames.isEmpty())

        val full = store.open(info.frameId, FrameVariant.FULL) as FrameFile.OnDisk
        assertEquals(info.full.bytes, full.file.length())

        // drop the background caches; on-demand regenerates them
        withTimeout(10_000) { while (!spool.file(info.frameId, FrameVariant.PLAY).isFile) delay(20) }
        spool.file(info.frameId, FrameVariant.PLAY).delete()
        spool.file(info.frameId, FrameVariant.THUMB).delete()
        val play = store.open(info.frameId, FrameVariant.PLAY) as FrameFile.OnDisk
        val img = ImageIoCodec.read(play.file.readBytes())
        assertEquals(1440, img.width)
        assertEquals(1080, img.height)
        val thumb = store.open(info.frameId, FrameVariant.THUMB) as FrameFile.OnDisk
        assertEquals(256, ImageIoCodec.read(thumb.file.readBytes()).width)

        assertEquals(1, store.ack("c1", listOf(info.frameId)).acked)
        assertTrue(store.listUnacked("c1", null, 10).frames.isEmpty())
    }

    @Test
    fun `frame store 404 cases`() = runBlocking {
        assertNull(store.open("not-a-ulid", FrameVariant.FULL))
        assertNull(store.open("../spool.db", FrameVariant.FULL))
        assertNull(store.open("01JAAAAAAAAAAAAAAAAAAAAAAA", FrameVariant.FULL))
        assertNull(store.open("01JAAAAAAAAAAAAAAAAAAAAAAA", FrameVariant.PLAY))
        val info = service.capture("c1", "r1", args).ok()
        withTimeout(10_000) { while (!spool.file(info.frameId, FrameVariant.PLAY).isFile) delay(20) }
        val fullBytes = spool.file(info.frameId, FrameVariant.FULL).readBytes()
        assertArrayEquals(fullBytes, (store.open(info.frameId, FrameVariant.FULL) as FrameFile.OnDisk).file.readBytes())
        // full gone (reclaimed) → no full, no caches even if they exist
        spool.file(info.frameId, FrameVariant.FULL).delete()
        assertNull(store.open(info.frameId, FrameVariant.FULL))
        assertNull(store.open(info.frameId, FrameVariant.PLAY))
    }
}
