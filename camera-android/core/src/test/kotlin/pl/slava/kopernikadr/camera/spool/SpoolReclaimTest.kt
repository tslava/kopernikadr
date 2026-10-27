package pl.slava.kopernikadr.camera.spool

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import pl.slava.kopernikadr.camera.image.ImageIoCodec
import pl.slava.kopernikadr.camera.image.StillPipeline
import pl.slava.kopernikadr.camera.protocol.OperationState
import pl.slava.kopernikadr.camera.server.FrameVariant

/** Reclaim of acked frames under low space (plan Task 2). */
class SpoolReclaimTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var dir: File
    private lateinit var spool: Spool
    private lateinit var derived: DerivedFiles
    private var now = 1_000L
    private val files = DurableFiles(DirSync.NONE)
    private val jpeg = ImageIoCodec.jpeg(640, 480, 0x203040, intArrayOf(10, 10, 100, 100, 0xFF0000))

    @Before
    fun setUp() {
        dir = File(tmp.root, "spool")
        spool = Spool.open(dir, BundledSQLiteDriver(), clock = { now })
        derived = DerivedFiles(spool, StillPipeline(ImageIoCodec()), files)
    }

    @After
    fun tearDown() = spool.close()

    private fun frame(client: String, req: String, ackedAt: Long? = null): String {
        val p = spool.insertPending(client, req, "h", "p1", 0)
        for (v in FrameVariant.entries) File(dir, spool.file(p.frameId, v).name).writeBytes(jpeg)
        spool.commit(p.frameId, CommitMeta(640, 480, jpeg.size.toLong(), "s", "2026-10-26T15:04:05.123Z"))
        if (ackedAt != null) {
            now = ackedAt
            spool.ack(client, listOf(p.frameId))
        }
        return p.frameId
    }

    private fun exists(id: String, v: FrameVariant = FrameVariant.FULL) = spool.file(id, v).exists()

    /** Free space as the disk would report it: a fixed budget minus what the spool dir holds. */
    private fun reclaimer(budget: Long, beforeDelete: (String) -> Unit = {}) = SpoolReclaimer(
        spool, derived,
        freeBytes = { budget - dir.listFiles()!!.filter { it.isFile && it.name.endsWith(".jpg") }.sumOf { it.length() } },
        beforeDelete = beforeDelete,
    )

    private val one = jpeg.size.toLong() * 3 // full + play + thumb

    @Test
    fun `only acked frames are reclaimed, never unacked or other clients' frames`() {
        val unacked = frame("native", "r1")
        val lite = frame("remote-lite", "r2")
        val acked = frame("native", "r3", ackedAt = 10)
        val n = reclaimer(budget = 0).reclaimUntil(Long.MAX_VALUE)
        assertEquals(1, n)
        for (v in FrameVariant.entries) {
            assertTrue(exists(unacked, v))
            assertTrue(exists(lite, v))
            assertFalse(exists(acked, v))
        }
        assertTrue(spool.isReclaimed(acked))
        assertFalse(spool.isReclaimed(unacked))
        assertFalse(spool.isReclaimed(lite))
        assertEquals(1, spool.listUnacked("remote-lite", null, 10).frames.size)
        assertEquals(1, spool.listUnacked("native", null, 10).frames.size)
    }

    @Test
    fun `oldest ackedAt first and it stops as soon as there is enough space`() {
        val newer = frame("native", "r1", ackedAt = 300)
        val oldest = frame("native", "r2", ackedAt = 100)
        val middle = frame("native", "r3", ackedAt = 200)
        // room for two frames' files; one more must be freed to reach three frames' worth of free space
        val total = 3 * one
        val r = reclaimer(budget = total + one) // free = one now; need 2*one → reclaim one frame
        assertEquals(1, r.reclaimUntil(2 * one))
        assertFalse(exists(oldest))
        assertTrue(exists(middle))
        assertTrue(exists(newer))
        assertEquals(1, r.reclaimUntil(3 * one))
        assertFalse(exists(middle))
        assertTrue(exists(newer))
    }

    @Test
    fun `nothing is reclaimed when there is enough space`() {
        val a = frame("native", "r1", ackedAt = 10)
        assertEquals(0, reclaimer(budget = 100 * one).reclaimUntil(one))
        assertTrue(exists(a))
        assertFalse(spool.isReclaimed(a))
    }

    @Test
    fun `reclaimedAt is committed before the files are deleted`() {
        val a = frame("native", "r1", ackedAt = 10)
        var seen = false
        reclaimer(budget = 0) { id ->
            // a second connection sees the committed mark while every file is still there
            val other = Spool.open(dir, BundledSQLiteDriver())
            try {
                assertTrue(other.isReclaimed(id))
            } finally {
                other.close()
            }
            assertTrue(FrameVariant.entries.all { exists(id, it) })
            seen = true
        }.reclaimUntil(1)
        assertTrue(seen)
        assertFalse(exists(a))
    }

    @Test
    fun `a crash between the mark and the delete is finished by recover`() {
        val a = frame("native", "r1", ackedAt = 10)
        val keep = frame("remote-lite", "r2")
        try {
            reclaimer(budget = 0) { throw IllegalStateException("process died") }.reclaimUntil(1)
        } catch (e: IllegalStateException) {
            // expected
        }
        assertTrue(exists(a)) // files still there, mark committed
        spool.close()
        spool = Spool.open(dir, BundledSQLiteDriver(), clock = { now })
        val report = spool.recover()
        assertEquals(1, report.reclaimFinished)
        assertFalse(exists(a))
        assertTrue(exists(keep))
        assertTrue(spool.getOperation("native", "r1") is OperationState.Done) // the row stays valid
    }

    @Test
    fun `a reclaimed frame answers 404 for every variant, including a missing cache`() {
        val a = frame("native", "r1", ackedAt = 10)
        val store = SpoolFrameStore(spool, derived)
        assertNotNull(store.open(a, FrameVariant.FULL))
        reclaimer(budget = 0).reclaimUntil(1)
        for (v in FrameVariant.entries) assertNull(store.open(a, v))
        assertTrue(spool.stats().let { it.unackedCount == 0 && it.fullBytes == 0L })
    }

    @Test
    fun `a reclaimed frame is not listed, acked again stays reclaimed`() {
        val a = frame("native", "r1", ackedAt = 10)
        reclaimer(budget = 0).reclaimUntil(1)
        assertFalse(spool.markReclaimed(a))
        assertNull(spool.nextReclaimable())
        assertEquals(1, spool.ack("native", listOf(a)).acked)
        assertTrue(spool.isReclaimed(a))
    }

    @Test
    fun `STORAGE_LOW path - nothing acked left means nothing to reclaim`() {
        frame("native", "r1")
        frame("remote-lite", "r2")
        assertNull(spool.nextReclaimable())
        assertEquals(0, reclaimer(budget = 0).reclaimUntil(Long.MAX_VALUE))
    }

    @Test
    fun `markReclaimed refuses unacked, unknown and failed frames`() {
        val u = frame("native", "r1")
        assertFalse(spool.markReclaimed(u))
        assertFalse(spool.markReclaimed("01ARZ3NDEKTSV4RRFFQ69G5FAV"))
        val p = spool.insertPending("native", "r2", "h", "p1", 0)
        spool.fail(p.frameId, "CAPTURE_FAILED", "x")
        assertFalse(spool.markReclaimed(p.frameId))
        assertTrue(exists(u))
    }

    @Test
    fun `expectedFullBytes is the recent maximum or the default`() {
        assertEquals(Spool.DEFAULT_EXPECTED_FULL_BYTES, spool.expectedFullBytes())
        frame("native", "r1")
        assertEquals(jpeg.size.toLong(), spool.expectedFullBytes())
    }

    @Test
    fun `a reclaim waits for a running generation of the same frame, then deletes its output`() {
        val a = frame("native", "r1", ackedAt = 10)
        File(dir, spool.file(a, FrameVariant.PLAY).name).delete()
        val entered = CountDownLatch(1)
        val gate = CountDownLatch(1)
        val slow = object : pl.slava.kopernikadr.camera.image.ImageCodec by ImageIoCodec() {
            private val real = ImageIoCodec()
            override fun decode(jpeg: ByteArray, sampleSize: Int): pl.slava.kopernikadr.camera.image.Pixels {
                entered.countDown()
                gate.await(10, TimeUnit.SECONDS)
                return real.decode(jpeg, sampleSize)
            }
        }
        val d = DerivedFiles(spool, StillPipeline(slow), files)
        val pool = Executors.newCachedThreadPool()
        try {
            val gen = pool.submit<java.io.File?> { d.ensure(a, FrameVariant.PLAY) }
            assertTrue(entered.await(10, TimeUnit.SECONDS))
            val rec = pool.submit {
                SpoolReclaimer(spool, d, { 0L }).reclaimUntil(1)
            }
            Thread.sleep(300)
            assertFalse("reclaim must wait for the generation", rec.isDone)
            assertTrue(spool.isReclaimed(a)) // already marked, files not yet deleted
            gate.countDown()
            gen.get(10, TimeUnit.SECONDS)
            rec.get(10, TimeUnit.SECONDS)
            // the generated play file did not survive the reclaim
            for (v in FrameVariant.entries) assertFalse(exists(a, v))
            assertNull(d.ensure(a, FrameVariant.PLAY))
        } finally {
            gate.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun `a generation that starts after the mark writes nothing`() {
        val a = frame("native", "r1", ackedAt = 10)
        File(dir, spool.file(a, FrameVariant.PLAY).name).delete()
        assertTrue(spool.markReclaimed(a)) // reclaim between mark and delete
        assertNull(derived.ensure(a, FrameVariant.PLAY))
        derived.prefetch(a, FrameVariant.THUMB)
        assertFalse(exists(a, FrameVariant.PLAY))
    }
}
