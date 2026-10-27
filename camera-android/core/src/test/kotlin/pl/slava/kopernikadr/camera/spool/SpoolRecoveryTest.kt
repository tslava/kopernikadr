package pl.slava.kopernikadr.camera.spool

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import java.io.File
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
import pl.slava.kopernikadr.camera.core.UlidGenerator
import pl.slava.kopernikadr.camera.image.ImageIoCodec
import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.OperationError
import pl.slava.kopernikadr.camera.protocol.OperationState
import pl.slava.kopernikadr.camera.server.FrameVariant

/** ARCHITECTURE §4.6: every row of the recovery table, the file rule, quarantine, idempotence. */
class SpoolRecoveryTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var dir: File
    private lateinit var spool: Spool
    private val ids = UlidGenerator()
    private var now = 1_000L

    @Before
    fun setUp() {
        dir = File(tmp.root, "spool")
        spool = open()
    }

    @After
    fun tearDown() = spool.close()

    private fun open() = Spool.open(dir, BundledSQLiteDriver(), clock = { now })

    private fun reopen() {
        spool.close()
        spool = open()
    }

    private val jpeg = ImageIoCodec.jpeg(640, 480, 0x203040, intArrayOf(10, 10, 100, 100, 0xFF0000))

    private fun write(name: String, bytes: ByteArray = jpeg): File = File(dir, name).also { it.writeBytes(bytes) }

    private fun fileOf(id: String, v: FrameVariant) = spool.file(id, v)

    /** A committed frame with its three files. */
    private fun committed(client: String = "c1", req: String, acked: Boolean = false): String {
        val p = spool.insertPending(client, req, "h", "p1", 0)
        write(fileOf(p.frameId, FrameVariant.FULL).name)
        write(fileOf(p.frameId, FrameVariant.PLAY).name, byteArrayOf(1))
        write(fileOf(p.frameId, FrameVariant.THUMB).name, byteArrayOf(2))
        spool.commit(p.frameId, CommitMeta(640, 480, jpeg.size.toLong(), DurableFiles.sha256(jpeg), "2026-10-26T15:04:05.123Z"))
        if (acked) spool.ack(client, listOf(p.frameId))
        return p.frameId
    }

    private fun names() = dir.listFiles()!!.filter { it.isFile }.map { it.name }.toSet()
    private fun quarantined() = File(dir, "quarantine").listFiles()?.map { it.name }?.toSet() ?: emptySet()

    // ---- table rows ----

    @Test
    fun `pending with a valid full becomes committed with the sha256 of the file`() {
        val p = spool.insertPending("c1", "r1", "h", "p1", 0)
        write(fileOf(p.frameId, FrameVariant.FULL).name)
        reopen()
        val report = spool.recover()
        assertEquals(1, report.committed)
        val done = spool.getOperation("c1", "r1") as OperationState.Done
        assertEquals(p.frameId, done.result.frameId)
        assertEquals(DurableFiles.sha256(jpeg), done.result.full.sha256)
        assertEquals(jpeg.size.toLong(), done.result.full.bytes)
        assertEquals(640, done.result.full.w)
        assertEquals(480, done.result.full.h)
        assertEquals(listOf(done.result), spool.listUnacked("c1", null, 10).frames)
        assertTrue(fileOf(p.frameId, FrameVariant.FULL).isFile)
    }

    @Test
    fun `crash between the rename and the commit keeps the photo`() {
        // exactly the state after step 4 and before step 5
        val p = spool.insertPending("c1", "r1", "h", "p1", 180)
        DurableFiles(DirSync.NONE).writeAtomic(dir, fileOf(p.frameId, FrameVariant.FULL).name, jpeg)
        reopen()
        spool.recover()
        assertTrue(spool.getOperation("c1", "r1") is OperationState.Done)
        assertEquals(180, spool.frame(p.frameId)!!.rotation)
    }

    @Test
    fun `pending with a decodable check that fails is interrupted, its full is quarantined`() {
        val p = spool.insertPending("c1", "r1", "h", "p1", 0)
        write(fileOf(p.frameId, FrameVariant.FULL).name)
        val report = spool.recover(isDecodable = { false })
        assertEquals(1, report.interrupted)
        assertEquals(
            OperationState.Failed(OperationError(ErrorCodes.INTERRUPTED, "interrupted by an app restart")),
            spool.getOperation("c1", "r1"),
        )
        assertFalse(fileOf(p.frameId, FrameVariant.FULL).exists())
        assertEquals(setOf(fileOf(p.frameId, FrameVariant.FULL).name), quarantined())
    }

    @Test
    fun `pending without a file, or with a truncated one, fails INTERRUPTED and tmp leftovers go`() {
        val a = spool.insertPending("c1", "ra", "h", "p1", 0)
        val b = spool.insertPending("c1", "rb", "h", "p1", 0)
        val c = spool.insertPending("c1", "rc", "h", "p1", 0)
        val tmpA = write(fileOf(a.frameId, FrameVariant.FULL).name + ".6f1c2a9e-0b1d-4c5e-8f3a-123456789abc.tmp")
        write(fileOf(b.frameId, FrameVariant.FULL).name, jpeg.copyOf(jpeg.size - 2)) // no EOI
        write(fileOf(c.frameId, FrameVariant.FULL).name, byteArrayOf(1, 2, 3))
        val report = spool.recover()
        assertEquals(3, report.interrupted)
        for (r in listOf("ra", "rb", "rc")) {
            val s = spool.getOperation("c1", r) as OperationState.Failed
            assertEquals(ErrorCodes.INTERRUPTED, s.error.code)
        }
        assertFalse(tmpA.exists())
        // the bad fulls (and the empty full tmp) are kept, in quarantine
        assertEquals(3, quarantined().size)
        assertTrue(names().none { it.endsWith(".tmp") || it.contains(".full.") })
    }

    @Test
    fun `a failed recovered operation replays its error and is never re-executed`() {
        spool.insertPending("c1", "r1", "h", "p1", 0)
        spool.recover()
        val l = spool.lookup("c1", "r1", "h") as SpoolLookup.Failed
        assertEquals(ErrorCodes.INTERRUPTED, l.code)
    }

    @Test
    fun `committed unacked with a missing full is lost, kept in the row, answered as failed INTERNAL`() {
        val id = committed(req = "r1")
        fileOf(id, FrameVariant.FULL).delete()
        val report = spool.recover()
        assertEquals(1, report.lost)
        val s = spool.getOperation("c1", "r1") as OperationState.Failed
        assertEquals(ErrorCodes.INTERNAL, s.error.code)
        assertNull(spool.frame(id))
        assertTrue(spool.listUnacked("c1", null, 10).frames.isEmpty())
        assertEquals(SpoolStats(0, 0), spool.stats())
        assertEquals(1, spool.integrityErrors())
    }

    @Test
    fun `committed acked with a missing full is left alone`() {
        val id = committed(req = "r1", acked = true)
        fileOf(id, FrameVariant.FULL).delete()
        val report = spool.recover()
        assertEquals(0, report.lost)
        assertTrue(spool.getOperation("c1", "r1") is OperationState.Done)
        assertEquals(0, spool.integrityErrors())
    }

    @Test
    fun `reclaimedAt set but files exist deletes the files, the row stays`() {
        val id = committed(req = "r1", acked = true)
        assertTrue(spool.markReclaimed(id))
        val report = spool.recover()
        assertEquals(1, report.reclaimFinished)
        for (v in FrameVariant.entries) assertFalse(fileOf(id, v).exists())
        assertTrue(spool.getOperation("c1", "r1") is OperationState.Done)
    }

    @Test
    fun `reclaimedAt on an unacked frame is an anomaly and its files are not deleted`() {
        val id = committed(req = "r1")
        forceReclaimed(id)
        spool.recover()
        assertTrue(fileOf(id, FrameVariant.FULL).isFile)
    }

    private fun forceReclaimed(id: String) {
        spool.close()
        val conn = BundledSQLiteDriver().open(File(dir, Spool.DB_NAME).absolutePath)
        conn.prepare("UPDATE frames SET reclaimedAt = 5 WHERE frameId = '$id'").use { it.step() }
        conn.close()
        spool = open()
    }

    @Test
    fun `play and thumb tmps are deleted, full tmps are quarantined, with and without a row`() {
        val id = committed(req = "r1")
        val other = ids.next()
        val tmps = listOf(
            write("$id.full.jpg.tmp"),
            write("$id.play.jpg.0a1b2c3d-0000-4000-8000-0123456789ab.tmp"),
            write("$other.thumb.jpg.tmp"),
            write("$other.full.jpg.tmp"),
        )
        spool.recover()
        assertTrue(tmps.none { it.exists() })
        assertTrue(fileOf(id, FrameVariant.FULL).isFile)
        assertEquals(setOf("$id.full.jpg.tmp", "$other.full.jpg.tmp"), quarantined())
    }

    private val uuidTmp = ".6f1c2a9e-0b1d-4c5e-8f3a-123456789abc.tmp"

    @Test
    fun `pending with a complete full tmp is renamed and committed, not deleted`() {
        val p = spool.insertPending("c1", "r1", "h", "p1", 0)
        val tmpFile = write(fileOf(p.frameId, FrameVariant.FULL).name + uuidTmp)
        val report = spool.recover()
        assertEquals(1, report.committed)
        assertEquals(0, report.interrupted)
        assertFalse(tmpFile.exists())
        assertArrayEquals(jpeg, fileOf(p.frameId, FrameVariant.FULL).readBytes())
        val done = spool.getOperation("c1", "r1") as OperationState.Done
        assertEquals(DurableFiles.sha256(jpeg), done.result.full.sha256)
        assertEquals(emptySet<String>(), quarantined())
    }

    @Test
    fun `pending with a truncated full tmp quarantines it and fails`() {
        val p = spool.insertPending("c1", "r1", "h", "p1", 0)
        val name = fileOf(p.frameId, FrameVariant.FULL).name + uuidTmp
        write(name, jpeg.copyOf(jpeg.size - 2))
        spool.recover()
        assertTrue(spool.getOperation("c1", "r1") is OperationState.Failed)
        assertEquals(setOf(name), quarantined())
        assertFalse(File(dir, name).exists())
    }

    @Test
    fun `an undecodable full tmp of a pending row is quarantined`() {
        val p = spool.insertPending("c1", "r1", "h", "p1", 0)
        val name = fileOf(p.frameId, FrameVariant.FULL).name + uuidTmp
        write(name)
        spool.recover(isDecodable = { false })
        assertTrue(spool.getOperation("c1", "r1") is OperationState.Failed)
        assertEquals(setOf(name), quarantined())
    }

    @Test
    fun `play and thumb without a row are deleted, a full without a row is quarantined not deleted`() {
        val id = ids.next()
        write("$id.play.jpg")
        write("$id.thumb.jpg")
        val full = write("$id.full.jpg")
        val report = spool.recover()
        assertEquals(1, report.quarantined)
        assertFalse(File(dir, "$id.play.jpg").exists())
        assertFalse(File(dir, "$id.thumb.jpg").exists())
        assertFalse(full.exists())
        val q = File(dir, "quarantine/$id.full.jpg")
        assertTrue(q.isFile)
        assertArrayEquals(jpeg, q.readBytes())
        assertEquals(1, spool.integrityErrors())
    }

    @Test
    fun `committed frame missing play or thumb is left for lazy regeneration`() {
        val id = committed(req = "r1")
        fileOf(id, FrameVariant.PLAY).delete()
        spool.recover()
        assertTrue(spool.getOperation("c1", "r1") is OperationState.Done)
        assertTrue(fileOf(id, FrameVariant.THUMB).isFile)
    }

    // ---- file rule ----

    @Test
    fun `spool db files, quarantine dir and unknown names are never touched`() {
        val id = ids.next()
        val keep = listOf(
            "notes.txt", "$id.full.jpeg", "$id.full.jpg.bak", "${id.lowercase()}.full.jpg", "${id}X.full.jpg",
            "$id.orig.jpg", "$id.full.png", "spool.db-wal-copy", "x.tmp", "$id.tmp",
        ).map { write(it, byteArrayOf(9)) }
        File(dir, "sub").mkdirs()
        write("sub/../keep-me") // plain file
        val db = File(dir, Spool.DB_NAME)
        spool.recover()
        assertTrue(keep.all { it.isFile })
        assertTrue(File(dir, "keep-me").isFile)
        assertTrue(db.isFile)
        assertTrue(File(dir, "sub").isDirectory)
        assertEquals(0, spool.integrityErrors())
    }

    @Test
    fun `committed frames of any client keep all their files`() {
        val mine = committed("native", "r1")
        val lite = committed("remote-lite", "r2")
        val acked = committed("native", "r3", acked = true)
        val report = spool.recover()
        assertEquals(RecoveryReport(), report)
        for (id in listOf(mine, lite, acked)) for (v in FrameVariant.entries) assertTrue(fileOf(id, v).isFile)
        assertEquals(1, spool.listUnacked("remote-lite", null, 10).frames.size)
    }

    @Test
    fun `a second run changes nothing`() {
        val committedId = committed(req = "r1")
        val p = spool.insertPending("c1", "r2", "h", "p1", 0)
        write(fileOf(p.frameId, FrameVariant.FULL).name)
        val stray = ids.next()
        write("$stray.full.jpg")
        write("$stray.play.jpg")
        write("${ids.next()}.thumb.jpg.tmp")
        val first = spool.recover()
        assertEquals(1, first.committed)
        assertEquals(1, first.quarantined)
        val snapshot = names() to quarantined()
        val second = spool.recover()
        assertEquals(RecoveryReport(), second)
        assertEquals(snapshot, names() to quarantined())
        assertTrue(fileOf(committedId, FrameVariant.FULL).isFile)
    }

    @Test
    fun `quarantine does not overwrite an earlier quarantined file`() {
        val id = ids.next()
        File(dir, "quarantine").mkdirs()
        File(dir, "quarantine/$id.full.jpg").writeBytes(byteArrayOf(7))
        write("$id.full.jpg")
        spool.recover()
        assertEquals(2, quarantined().size)
        assertArrayEquals(byteArrayOf(7), File(dir, "quarantine/$id.full.jpg").readBytes())
    }

    // ---- status numbers ----

    @Test
    fun `orphanCount is the unacked frames of other clients`() {
        committed("native", "r1")
        committed("remote-lite", "r2")
        committed("remote-lite", "r3")
        committed("remote-lite", "r4", acked = true)
        assertEquals(2, spool.orphanCount("native"))
        assertEquals(1, spool.orphanCount("remote-lite"))
        assertEquals(3, spool.orphanCount("someone-else"))
    }

    @Test
    fun `integrityErrors counts lost frames and quarantined files`() {
        val a = committed(req = "r1")
        fileOf(a, FrameVariant.FULL).delete()
        write("${ids.next()}.full.jpg")
        spool.recover()
        assertEquals(2, spool.integrityErrors())
    }

    @Test
    fun `recovery survives a reopen of the spool`() {
        val a = committed(req = "r1")
        fileOf(a, FrameVariant.FULL).delete()
        spool.recover()
        reopen()
        assertEquals(1, spool.integrityErrors())
        assertEquals(RecoveryReport(), spool.recover())
    }

    @Test
    fun `recovered rows go on the wire as the existing failed shapes, no new codes`() {
        spool.insertPending("c1", "r1", "h", "p1", 0)
        val lostId = committed(req = "r2")
        fileOf(lostId, FrameVariant.FULL).delete()
        spool.recover()
        val json = kotlinx.serialization.json.Json
        val interrupted = json.parseToJsonElement(json.encodeToString(OperationState.serializer(), spool.getOperation("c1", "r1")))
        val lost = json.parseToJsonElement(json.encodeToString(OperationState.serializer(), spool.getOperation("c1", "r2")))
        assertEquals("""{"state":"failed","error":{"code":"INTERRUPTED","message":"interrupted by an app restart"}}""", interrupted.toString())
        assertEquals("""{"state":"failed","error":{"code":"INTERNAL","message":"the frame's file is lost"}}""", lost.toString())
    }

    @Test
    fun `JpegCheck reads the dimensions and rejects broken files`() {
        assertEquals(640 to 480, JpegCheck.dimensions(jpeg))
        assertNull(JpegCheck.dimensions(ByteArray(0)))
        assertNull(JpegCheck.dimensions(jpeg.copyOf(jpeg.size - 2)))
        assertNull(JpegCheck.dimensions(jpeg.copyOfRange(2, jpeg.size)))
        assertNull(JpegCheck.dimensions(jpeg.copyOf(100)))
        assertEquals(640 to 480, JpegCheck.dimensions(jpeg + ByteArray(3)))
    }
}
