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
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class VideoWriterTest {
    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var guard: PathGuard
    private val log = mutableListOf<String>()
    private val recordingSync = DirSync { log += "dirSync:${it.name}" }

    private inner class RecordingOps(val failWrite: IOException? = null, val failSync: IOException? = null) : VideoFileOps {
        override fun open(file: File): RandomAccessFile {
            val fail = failWrite ?: return RandomAccessFile(file, "rw")
            return object : RandomAccessFile(file, "rw") {
                override fun write(b: ByteArray, off: Int, len: Int) = throw fail
            }
        }

        override fun sync(file: RandomAccessFile) {
            log += "sync"
            failSync?.let { throw it }
            VideoFileOps.DEFAULT.sync(file)
        }
    }

    @Before
    fun setUp() {
        guard = PathGuard.forFilesDir(temp.newFolder("files"))
    }

    private fun counter(): () -> String {
        var n = 0
        return { (++n).toString() }
    }

    private fun writer(
        ops: VideoFileOps = RecordingOps(),
        ids: () -> String = counter(),
        disk: DiskSpace = DiskSpace { Long.MAX_VALUE },
        reserve: Long = 0,
    ) = VideoWriter(guard, recordingSync, ids, disk, reserve, ops)

    private fun fileOf(h: VideoWriter.Handle) = File(guard.root, h.relPath)

    // --- open ---

    @Test
    fun openCreatesAnEmptyExportFile() {
        val h = writer().open()
        assertEquals("1", h.id)
        assertEquals("exports/export-1.mp4", h.relPath)
        assertTrue(fileOf(h).isFile)
        assertEquals(0L, fileOf(h).length())
    }

    @Test
    fun openGivesDistinctHandles() {
        val w = writer()
        val a = w.open()
        val b = w.open()
        assertEquals("exports/export-2.mp4", b.relPath)
        assertTrue(fileOf(a).isFile && fileOf(b).isFile)
    }

    @Test
    fun openTruncatesAStaleFileWithTheSameName() {
        File(guard.root, "exports").mkdirs()
        File(guard.root, "exports/export-1.mp4").writeBytes(ByteArray(100) { 7 })
        val h = writer().open()
        assertEquals(0L, fileOf(h).length())
    }

    @Test
    fun openRejectsUnsafeIds() {
        expectCode(NativeErrorCode.BAD_ARGUMENT) { writer(ids = { "../x" }).open() }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { writer(ids = { "" }).open() }
    }

    @Test
    fun openRejectsADuplicateLiveId() {
        val w = writer(ids = { "same" })
        w.open()
        expectCode(NativeErrorCode.BAD_ARGUMENT) { w.open() }
    }

    @Test
    fun uuidIdsByDefault() {
        val h = VideoWriter(guard, DirSync.NONE).open()
        assertTrue(h.relPath.matches(Regex("exports/export-[0-9a-f-]{36}\\.mp4")))
    }

    // --- writeAt ---

    @Test
    fun sequentialWrites() {
        val w = writer()
        val h = w.open()
        w.writeAt(h.id, 0, "abc".toByteArray())
        w.writeAt(h.id, 3, "def".toByteArray())
        w.close(h.id)
        assertEquals("abcdef", fileOf(h).readText())
    }

    @Test
    fun outOfOrderWrites() {
        val w = writer()
        val h = w.open()
        w.writeAt(h.id, 4, "EFGH".toByteArray())
        w.writeAt(h.id, 0, "ABCD".toByteArray())
        w.close(h.id)
        assertEquals("ABCDEFGH", fileOf(h).readText())
    }

    @Test
    fun overlappingWritesLastOneWins() {
        val w = writer()
        val h = w.open()
        w.writeAt(h.id, 0, "aaaaaaaa".toByteArray())
        w.writeAt(h.id, 2, "BBB".toByteArray())
        w.writeAt(h.id, 6, "CCCC".toByteArray()) // overlaps and extends
        w.close(h.id)
        assertEquals("aaBBBaCCCC", fileOf(h).readText())
    }

    @Test
    fun gapsAreZeroFilled() {
        val w = writer()
        val h = w.open()
        w.writeAt(h.id, 3, byteArrayOf(9))
        w.close(h.id)
        assertArrayEquals(byteArrayOf(0, 0, 0, 9), fileOf(h).readBytes())
    }

    @Test
    fun emptyWriteIsANoOp() {
        val w = writer()
        val h = w.open()
        w.writeAt(h.id, 10, ByteArray(0))
        assertEquals(0L, fileOf(h).length())
    }

    @Test
    fun negativePositionIsRejected() {
        val w = writer()
        val h = w.open()
        expectCode(NativeErrorCode.BAD_ARGUMENT) { w.writeAt(h.id, -1, byteArrayOf(1)) }
    }

    @Test
    fun unknownHandleIsRejected() {
        val w = writer()
        expectCode(NativeErrorCode.BAD_HANDLE) { w.writeAt("nope", 0, byteArrayOf(1)) }
        expectCode(NativeErrorCode.BAD_HANDLE) { w.close("nope") }
        expectCode(NativeErrorCode.BAD_HANDLE) { w.abort("nope") }
        expectCode(NativeErrorCode.BAD_HANDLE) { w.closedFile("nope") }
    }

    @Test
    fun noSpaceDuringWriteIsMappedAndAbortCleansUp() {
        val w = writer(RecordingOps(failWrite = IOException("write failed: ENOSPC (No space left on device)")))
        val h = w.open()
        expectCode(NativeErrorCode.NO_SPACE) { w.writeAt(h.id, 0, ByteArray(10)) }
        w.abort(h.id)
        assertFalse(fileOf(h).exists())
    }

    @Test
    fun otherWriteErrorsAreIo() {
        val w = writer(RecordingOps(failWrite = IOException("EIO")))
        val h = w.open()
        expectCode(NativeErrorCode.IO) { w.writeAt(h.id, 0, ByteArray(10)) }
    }

    @Test
    fun writeBelowTheReserveFailsBeforeTouchingTheFile() {
        val w = writer(disk = DiskSpace { 1_000L }, reserve = 900)
        val h = w.open()
        w.writeAt(h.id, 0, ByteArray(100)) // 100 + 900 <= 1000
        expectCode(NativeErrorCode.NO_SPACE) { w.writeAt(h.id, 100, ByteArray(101)) }
        assertEquals(100L, fileOf(h).length())
    }

    // --- close ---

    @Test
    fun closeSyncsTheFileThenTheDir() {
        val w = writer()
        val h = w.open()
        w.writeAt(h.id, 0, byteArrayOf(1))
        log.clear()
        w.close(h.id)
        assertEquals(listOf("sync", "dirSync:exports"), log)
    }

    @Test
    fun closeIsIdempotent() {
        val w = writer()
        val h = w.open()
        w.close(h.id)
        log.clear()
        w.close(h.id)
        assertEquals(emptyList<String>(), log)
        assertTrue(fileOf(h).exists())
    }

    @Test
    fun writeAfterCloseIsClosed() {
        val w = writer()
        val h = w.open()
        w.close(h.id)
        expectCode(NativeErrorCode.CLOSED) { w.writeAt(h.id, 0, byteArrayOf(1)) }
    }

    @Test
    fun failedCloseLeavesTheHandleUnusableButAbortable() {
        val w = writer(RecordingOps(failSync = IOException("No space left on device")))
        val h = w.open()
        expectCode(NativeErrorCode.NO_SPACE) { w.close(h.id) }
        expectCode(NativeErrorCode.CLOSED) { w.writeAt(h.id, 0, byteArrayOf(1)) }
        expectCode(NativeErrorCode.CLOSED) { w.close(h.id) }
        expectCode(NativeErrorCode.CLOSED) { w.closedFile(h.id) }
        w.abort(h.id)
        assertFalse(fileOf(h).exists())
    }

    @Test
    fun closedFileIsAvailableOnlyAfterClose() {
        val w = writer()
        val h = w.open()
        expectCode(NativeErrorCode.BAD_HANDLE) { w.closedFile(h.id) }
        w.close(h.id)
        assertEquals(fileOf(h), w.closedFile(h.id))
    }

    // --- abort ---

    @Test
    fun abortDeletesTheFileAndIsIdempotent() {
        val w = writer()
        val h = w.open()
        w.writeAt(h.id, 0, byteArrayOf(1, 2, 3))
        w.abort(h.id)
        assertFalse(fileOf(h).exists())
        w.abort(h.id)
        assertFalse(fileOf(h).exists())
    }

    @Test
    fun abortAfterCloseDeletesTheFile() {
        val w = writer()
        val h = w.open()
        w.close(h.id)
        w.abort(h.id)
        assertFalse(fileOf(h).exists())
    }

    @Test
    fun writeOrCloseAfterAbortIsClosed() {
        val w = writer()
        val h = w.open()
        w.abort(h.id)
        expectCode(NativeErrorCode.CLOSED) { w.writeAt(h.id, 0, byteArrayOf(1)) }
        expectCode(NativeErrorCode.CLOSED) { w.close(h.id) }
        expectCode(NativeErrorCode.CLOSED) { w.closedFile(h.id) }
    }

    @Test
    fun abortSurvivesAFileAlreadyDeletedBehindItsBack() {
        val w = writer()
        val h = w.open()
        w.close(h.id)
        fileOf(h).delete()
        w.abort(h.id)
    }

    @Test
    fun anAbortedIdCanBeReused() {
        val w = writer(ids = { "same" })
        val h = w.open()
        w.abort(h.id)
        val h2 = w.open()
        w.writeAt(h2.id, 0, "x".toByteArray())
        w.close(h2.id)
        assertEquals("x", fileOf(h2).readText())
    }

    // --- cleanupAbandoned ---

    @Test
    fun cleanupWithoutExportsDirIsZero() {
        assertEquals(0, writer().cleanupAbandoned())
    }

    @Test
    fun cleanupDeletesEverythingWhenNoHandles() {
        val exports = File(guard.root, "exports").apply { mkdirs() }
        File(exports, "export-old.mp4").writeBytes(ByteArray(10))
        File(exports, "junk.tmp").writeText("x")
        File(exports, "sub/deeper").mkdirs()
        File(exports, "sub/deeper/f").writeText("x")
        val other = File(guard.root, "projects/p1/project.json").apply { parentFile!!.mkdirs(); writeText("{}") }
        assertEquals(3, writer().cleanupAbandoned())
        assertEquals(0, exports.list()!!.size)
        assertTrue(other.exists())
    }

    @Test
    fun cleanupKeepsLiveHandles() {
        val w = writer()
        val open = w.open()
        val closed = w.open().also { w.close(it.id) }
        val aborted = w.open().also { w.abort(it.id) }
        File(guard.root, "exports/export-stale.mp4").writeText("x")
        assertEquals(1, w.cleanupAbandoned())
        assertTrue(fileOf(open).exists())
        assertTrue(fileOf(closed).exists())
        assertFalse(fileOf(aborted).exists())
        w.writeAt(open.id, 0, byteArrayOf(1)) // still usable
    }

    @Test
    fun cleanupDoesNotFollowSymlinksOutOfExports() {
        val outside = temp.newFolder("outside").apply { File(this, "keep").writeText("x") }
        val exports = File(guard.root, "exports").apply { mkdirs() }
        Files.createSymbolicLink(File(exports, "link").toPath(), outside.toPath())
        assertEquals(1, writer().cleanupAbandoned())
        assertTrue(File(outside, "keep").exists())
        assertFalse(Files.exists(File(exports, "link").toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
    }

    // --- concurrency ---

    @Test
    fun concurrentWritesToOneHandleAllLand() {
        val w = writer(ops = VideoFileOps.DEFAULT)
        val h = w.open()
        val threads = 8
        val perThread = 50
        val chunk = 256
        val pool = Executors.newFixedThreadPool(threads)
        val start = CountDownLatch(1)
        repeat(threads) { t ->
            pool.execute {
                start.await()
                for (i in 0 until perThread) {
                    val slot = i * threads + t
                    w.writeAt(h.id, slot.toLong() * chunk, ByteArray(chunk) { slot.toByte() })
                }
            }
        }
        start.countDown()
        pool.shutdown()
        assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS))
        w.close(h.id)
        val bytes = fileOf(h).readBytes()
        assertEquals(threads * perThread * chunk, bytes.size)
        for (slot in 0 until threads * perThread) {
            for (j in 0 until chunk) assertEquals(slot.toByte(), bytes[slot * chunk + j])
        }
    }

    @Test
    fun concurrentHandlesAreIndependent() {
        val w = writer(ops = VideoFileOps.DEFAULT, ids = { java.util.UUID.randomUUID().toString() })
        val pool = Executors.newFixedThreadPool(4)
        val handles = (0 until 4).map { w.open() }
        handles.forEachIndexed { n, h ->
            pool.execute { repeat(100) { i -> w.writeAt(h.id, i.toLong(), byteArrayOf(n.toByte())) }; w.close(h.id) }
        }
        pool.shutdown()
        assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS))
        handles.forEachIndexed { n, h -> assertArrayEquals(ByteArray(100) { n.toByte() }, fileOf(h).readBytes()) }
    }
}
