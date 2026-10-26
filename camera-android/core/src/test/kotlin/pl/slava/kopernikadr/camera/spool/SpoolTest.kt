package pl.slava.kopernikadr.camera.spool

import androidx.sqlite.SQLiteException
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import pl.slava.kopernikadr.camera.protocol.ExposureInfo
import pl.slava.kopernikadr.camera.protocol.OperationError
import pl.slava.kopernikadr.camera.protocol.OperationState
import pl.slava.kopernikadr.camera.server.AckResult
import pl.slava.kopernikadr.camera.server.FrameVariant

class SpoolTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var dir: File
    private lateinit var spool: Spool
    private var now = 1_000L

    @Before
    fun setUp() {
        dir = File(tmp.root, "spool")
        spool = open()
    }

    @After
    fun tearDown() = spool.close()

    private fun open() = Spool.open(dir, BundledSQLiteDriver(), clock = { now })

    private fun meta(sha: String = "ab", exposure: ExposureInfo? = null) =
        CommitMeta(3264, 2448, 2_000_000, sha, "2026-10-26T15:04:05.123Z", exposure)

    private fun committed(client: String, req: String, project: String = "p1"): String {
        val p = spool.insertPending(client, req, "h", project, 0)
        spool.commit(p.frameId, meta())
        return p.frameId
    }

    @Test
    fun `pending, commit and lookup`() {
        assertEquals(SpoolLookup.None, spool.lookup("c1", "r1", "h"))
        val p = spool.insertPending("c1", "r1", "h", "p1", 180)
        assertEquals(1L, p.seq)
        assertEquals(SpoolLookup.Pending(p.frameId), spool.lookup("c1", "r1", "h"))
        assertEquals(OperationState.Pending, spool.getOperation("c1", "r1"))

        val info = spool.commit(p.frameId, meta(exposure = ExposureInfo(200, 16_666_666)))
        assertEquals(p.frameId, info.frameId)
        assertEquals(1L, info.seq)
        assertEquals("p1", info.projectId)
        assertEquals("c1", info.clientId)
        assertEquals(180, info.rotation)
        assertEquals("2026-10-26T15:04:05.123Z", info.capturedAt)
        assertEquals(3264, info.full.w)
        assertEquals(2448, info.full.h)
        assertEquals(2_000_000L, info.full.bytes)
        assertEquals("ab", info.full.sha256)
        assertEquals(1440, info.derived.play.w)
        assertEquals(192, info.derived.thumb.h)
        assertEquals(ExposureInfo(200, 16_666_666), info.exposure)

        assertEquals(SpoolLookup.Committed(info), spool.lookup("c1", "r1", "h"))
        assertEquals(OperationState.Done(info), spool.getOperation("c1", "r1"))
        assertEquals(info, spool.frame(p.frameId))
    }

    @Test
    fun `fail, reused args and unknown`() {
        val p = spool.insertPending("c1", "r1", "h", "p1", 0)
        spool.fail(p.frameId, "CAPTURE_FAILED", "boom")
        assertEquals(SpoolLookup.Failed("CAPTURE_FAILED", "boom"), spool.lookup("c1", "r1", "h"))
        assertEquals(OperationState.Failed(OperationError("CAPTURE_FAILED", "boom")), spool.getOperation("c1", "r1"))
        assertEquals(SpoolLookup.Reused, spool.lookup("c1", "r1", "other"))
        assertEquals(OperationState.Unknown, spool.getOperation("c2", "r1"))
        assertNull(spool.frame(p.frameId))
        try {
            spool.commit(p.frameId, meta())
            fail("commit of a failed frame")
        } catch (_: IllegalStateException) {
        }
    }

    @Test
    fun `clientId reqId is unique`() {
        spool.insertPending("c1", "r1", "h", "p1", 0)
        try {
            spool.insertPending("c1", "r1", "h", "p1", 0)
            fail("expected UNIQUE violation")
        } catch (_: SQLiteException) {
        }
        // same reqId for another client is fine
        assertEquals(2L, spool.insertPending("c2", "r1", "h", "p1", 0).seq)
    }

    @Test
    fun `seq increases across reopen`() {
        committed("c1", "r1")
        val failed = spool.insertPending("c1", "r2", "h", "p1", 0)
        spool.fail(failed.frameId, "CAPTURE_FAILED", "x")
        spool.close()
        spool = open()
        val p = spool.insertPending("c1", "r3", "h", "p1", 0)
        assertEquals(3L, p.seq)
        assertTrue(spool.lookup("c1", "r1", "h") is SpoolLookup.Committed)
    }

    @Test
    fun `listUnacked pages by seq, only committed and unacked of the client`() {
        val ids = (1..5).map { committed("c1", "r$it") }
        committed("c2", "x1")
        spool.insertPending("c1", "pending", "h", "p1", 0)

        val first = spool.listUnacked("c1", null, 2)
        assertEquals(ids.take(2), first.frames.map { it.frameId })
        assertTrue(first.hasMore)
        val second = spool.listUnacked("c1", first.frames.last().seq, 10)
        assertEquals(ids.drop(2), second.frames.map { it.frameId })
        assertFalse(second.hasMore)

        spool.ack("c1", listOf(ids[0], ids[3]))
        assertEquals(listOf(ids[1], ids[2], ids[4]), spool.listUnacked("c1", null, 100).frames.map { it.frameId })
    }

    @Test
    fun `ack is idempotent and scoped to the client`() {
        val mine = committed("c1", "r1")
        val theirs = committed("c2", "r1")
        val pending = spool.insertPending("c1", "r2", "h", "p1", 0).frameId
        assertEquals(AckResult(1, listOf(theirs, pending, "nope")), spool.ack("c1", listOf(mine, theirs, pending, "nope")))
        assertEquals(AckResult(1, emptyList()), spool.ack("c1", listOf(mine, mine)))
        assertEquals(1, spool.listUnacked("c2", null, 10).frames.size)
    }

    @Test
    fun `file names in the spool dir`() {
        val id = committed("c1", "r1")
        assertEquals(File(dir, "$id.full.jpg"), spool.file(id, FrameVariant.FULL))
        assertEquals(File(dir, "$id.play.jpg"), spool.file(id, FrameVariant.PLAY))
        assertEquals(File(dir, "$id.thumb.jpg"), spool.file(id, FrameVariant.THUMB))
        try {
            spool.file("../etc/passwd", FrameVariant.FULL)
            fail("path traversal")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun `stats count committed unacked frames and their bytes across clients`() {
        assertEquals(SpoolStats(0, 0), spool.stats())
        val a = committed("c1", "r1")
        committed("c2", "r1")
        spool.insertPending("c1", "r2", "h", "p1", 0)
        val failed = spool.insertPending("c1", "r3", "h", "p1", 0)
        spool.fail(failed.frameId, "CAPTURE_FAILED", "x")
        assertEquals(SpoolStats(2, 4_000_000), spool.stats())
        spool.ack("c1", listOf(a))
        assertEquals(SpoolStats(1, 4_000_000), spool.stats())
    }
}
