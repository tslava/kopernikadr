package pl.slava.kopernikadr.camera.spool

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import java.io.File
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import pl.slava.kopernikadr.camera.camera.AnalysisFrame
import pl.slava.kopernikadr.camera.core.FrameTransform
import pl.slava.kopernikadr.camera.core.UlidGenerator
import pl.slava.kopernikadr.camera.image.ImageCodec
import pl.slava.kopernikadr.camera.image.ImageIoCodec
import pl.slava.kopernikadr.camera.image.Pixels
import pl.slava.kopernikadr.camera.image.StillPipeline
import pl.slava.kopernikadr.camera.server.CameraPorts
import pl.slava.kopernikadr.camera.server.CameraServer
import pl.slava.kopernikadr.camera.server.FakeCamera
import pl.slava.kopernikadr.camera.server.FrameFile
import pl.slava.kopernikadr.camera.server.ServerConfig
import pl.slava.kopernikadr.camera.server.TEST_STATIC_ROOT
import pl.slava.kopernikadr.camera.server.FrameUnavailableException
import pl.slava.kopernikadr.camera.server.FrameVariant

/**
 * A codec whose decode (one per cache generation) is slow like the phone's and observable:
 * it counts decodes per source JPEG, tracks the peak concurrency, can block on a gate and can fail.
 */
private class SlowCodec(private val delayMs: Long = 0) : ImageCodec {
    private val real = ImageIoCodec()
    private val running = AtomicInteger()
    val peak = AtomicInteger()
    val decodes = AtomicInteger()

    /** Decodes block here (after [entered]) until it is counted down. */
    @Volatile var gate: CountDownLatch? = null
    val entered = CountDownLatch(1)

    /** The next this-many decodes throw. */
    val failNext = AtomicInteger()

    override fun decode(jpeg: ByteArray, sampleSize: Int): Pixels {
        val now = running.incrementAndGet()
        peak.accumulateAndGet(now) { a, b -> maxOf(a, b) }
        try {
            decodes.incrementAndGet()
            entered.countDown()
            gate?.await(10, TimeUnit.SECONDS)
            if (delayMs > 0) Thread.sleep(delayMs)
            if (failNext.getAndUpdate { if (it > 0) it - 1 else 0 } > 0) throw IOException("injected decode failure")
            return real.decode(jpeg, sampleSize)
        } finally {
            running.decrementAndGet()
        }
    }

    override fun encodeJpeg(pixels: Pixels, quality: Int): ByteArray = real.encodeJpeg(pixels, quality)
    override fun transform(pixels: Pixels, t: FrameTransform): Pixels = real.transform(pixels, t)
    override fun fromYuv(frame: AnalysisFrame): Pixels = real.fromYuv(frame)
}

class DerivedFilesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var spool: Spool
    private val files = DurableFiles(DirSync.NONE)
    private val ids = UlidGenerator()
    private val logs = CopyOnWriteArrayList<String>()
    private val pool = Executors.newCachedThreadPool()
    private val reference = StillPipeline(ImageIoCodec())

    @Before
    fun setUp() {
        spool = Spool.open(File(tmp.root, "spool"), BundledSQLiteDriver())
    }

    @After
    fun tearDown() {
        pool.shutdownNow()
        spool.close()
    }

    private fun derived(codec: SlowCodec, maxParallel: Int = 2) =
        DerivedFiles(spool, StillPipeline(codec), files, maxParallel, log = { logs += it })

    /** Committed-looking frames: just a distinct `full` file each (DerivedFiles reads no rows). */
    private fun fulls(n: Int): List<String> = List(n) { i ->
        val id = ids.next()
        val jpeg = ImageIoCodec.jpeg(640, 480, 0x101010 * (i % 15 + 1), intArrayOf(i * 20, 10, 30, 40, 0xFF0000))
        files.writeAtomic(spool.dir, spool.file(id, FrameVariant.FULL).name, jpeg)
        id
    }

    private fun expectedPlay(id: String): ByteArray =
        reference.derive(spool.file(id, FrameVariant.FULL).readBytes(), StillPipeline.PLAY)

    private fun DerivedFiles.background(frames: List<String>): Future<*> = pool.submit {
        for (id in frames) {
            prefetch(id, FrameVariant.THUMB)
            prefetch(id, FrameVariant.PLAY)
        }
    }

    @Test
    fun `concurrent play requests while the background derives all succeed with correct bytes, each file once`() {
        val codec = SlowCodec(delayMs = 30)
        val derived = derived(codec)
        val store = SpoolFrameStore(spool, derived)
        val frames = fulls(12)
        val bg = derived.background(frames)
        // The export asks for every frame (several at once, plus the player's ring) right away.
        val requests = frames.flatMap { id -> List(2) { pool.submit<ByteArray> { (store.open(id, FrameVariant.PLAY) as FrameFile.OnDisk).file.readBytes() } } }
        for ((i, f) in requests.withIndex()) {
            val id = frames[i / 2]
            assertArrayEquals("play of frame ${i / 2}", expectedPlay(id), f.get(30, TimeUnit.SECONDS))
        }
        bg.get(30, TimeUnit.SECONDS)
        for (id in frames) assertTrue(spool.file(id, FrameVariant.THUMB).isFile)
        // One thumb + one play per frame: nobody generated a file twice.
        assertEquals(frames.size * 2, codec.decodes.get())
        assertTrue("peak ${codec.peak.get()}", codec.peak.get() <= 2)
        assertTrue(logs.toString(), logs.isEmpty())
        assertTrue(spool.dir.listFiles()!!.none { it.name.endsWith(".tmp") })
    }

    @Test
    fun `HTTP play requests right after a burst all answer 200 with the right bytes`() {
        val codec = SlowCodec(delayMs = 30)
        val derived = derived(codec)
        val frames = fulls(10)
        val cam = FakeCamera()
        val ports = CameraPorts(cam.identity, cam.status, cam.controls, cam.capture, SpoolFrameStore(spool, derived), cam.preview)
        val server = CameraServer(ports, ServerConfig(staticRoot = TEST_STATIC_ROOT), port = 0)
        val port = server.start()
        try {
            val bg = derived.background(frames)
            val http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()
            val responses = frames.map { id ->
                val req = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/frames/$id/play.jpg")).timeout(Duration.ofSeconds(30)).build()
                http.sendAsync(req, HttpResponse.BodyHandlers.ofByteArray())
            }
            responses.forEachIndexed { i, f ->
                val r = f.get(30, TimeUnit.SECONDS)
                assertEquals(200, r.statusCode())
                assertArrayEquals("play of frame $i", expectedPlay(frames[i]), r.body())
            }
            bg.get(30, TimeUnit.SECONDS)
            assertEquals(frames.size * 2, codec.decodes.get())
        } finally {
            server.stop()
        }
    }

    @Test
    fun `a request for a file being generated waits for that generation instead of failing or redoing it`() {
        val codec = SlowCodec().apply { gate = CountDownLatch(1) }
        val derived = derived(codec)
        val (id) = fulls(1)
        val bg = pool.submit { derived.prefetch(id, FrameVariant.PLAY) }
        assertTrue(codec.entered.await(5, TimeUnit.SECONDS))
        val request = pool.submit<File?> { derived.ensure(id, FrameVariant.PLAY) }
        Thread.sleep(200)
        assertFalse("must wait for the running generation", request.isDone)
        codec.gate!!.countDown()
        val file = request.get(10, TimeUnit.SECONDS)
        bg.get(10, TimeUnit.SECONDS)
        assertNotNull(file)
        assertArrayEquals(expectedPlay(id), file!!.readBytes())
        assertEquals(1, codec.decodes.get())
    }

    @Test
    fun `a request is not starved by the background backlog`() {
        val codec = SlowCodec(delayMs = 100)
        val derived = derived(codec, maxParallel = 1)
        val frames = fulls(10)
        val bg = derived.background(frames)
        assertTrue(codec.entered.await(5, TimeUnit.SECONDS))
        val t0 = System.nanoTime()
        val last = derived.ensure(frames.last(), FrameVariant.PLAY)
        val ms = (System.nanoTime() - t0) / 1_000_000
        assertNotNull(last)
        // At most the running background generation plus our own (~200 ms), not the 2 s backlog.
        assertTrue("took $ms ms", ms < 1_000)
        assertFalse("background still busy", spool.file(frames[frames.size - 3], FrameVariant.PLAY).isFile)
        bg.get(30, TimeUnit.SECONDS)
        assertEquals(frames.size * 2, codec.decodes.get())
    }

    @Test
    fun `a failed generation is logged and retried once`() {
        val codec = SlowCodec().apply { failNext.set(1) }
        val derived = derived(codec)
        val (id) = fulls(1)
        val file = derived.ensure(id, FrameVariant.PLAY)
        assertArrayEquals(expectedPlay(id), file!!.readBytes())
        assertEquals(2, codec.decodes.get())
        assertEquals(1, logs.size)
        assertTrue(logs[0], logs[0].contains("failed (attempt 1/2)"))
    }

    @Test
    fun `two failures are FrameUnavailableException, and the next request tries again`() {
        val codec = SlowCodec().apply { failNext.set(2) }
        val derived = derived(codec)
        val (id) = fulls(1)
        val e = runCatching { derived.ensure(id, FrameVariant.PLAY) }.exceptionOrNull()
        assertTrue("$e", e is FrameUnavailableException)
        assertEquals(2, codec.decodes.get())
        assertFalse(spool.file(id, FrameVariant.PLAY).isFile)
        assertNotNull(derived.ensure(id, FrameVariant.PLAY))
    }

    @Test
    fun `waiters of a failed generation retry it themselves`() {
        val codec = SlowCodec().apply {
            gate = CountDownLatch(1)
            failNext.set(1)
        }
        val derived = derived(codec)
        val (id) = fulls(1)
        val first = pool.submit<File?> { derived.ensure(id, FrameVariant.PLAY) }
        assertTrue(codec.entered.await(5, TimeUnit.SECONDS))
        val waiters = List(4) { pool.submit<File?> { derived.ensure(id, FrameVariant.PLAY) } }
        Thread.sleep(100)
        codec.gate!!.countDown() // the running generation fails once
        for (w in waiters + first) assertArrayEquals(expectedPlay(id), w.get(10, TimeUnit.SECONDS)!!.readBytes())
        assertEquals(2, codec.decodes.get())
    }

    @Test
    fun `background failures are logged, never thrown, and a missing full is a quiet no-op`() {
        val codec = SlowCodec().apply { failNext.set(2) }
        val derived = derived(codec)
        val (id) = fulls(1)
        derived.prefetch(id, FrameVariant.PLAY)
        assertEquals(2, logs.size)
        assertFalse(spool.file(id, FrameVariant.PLAY).isFile)
        spool.file(id, FrameVariant.FULL).delete()
        derived.prefetch(id, FrameVariant.PLAY)
        assertNull(derived.ensure(id, FrameVariant.PLAY))
        assertEquals(2, codec.decodes.get())
    }
}
