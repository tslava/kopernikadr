package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.FileSystemException

class AtomicFilesTest {
    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var guard: PathGuard
    private val log = mutableListOf<String>()
    private val synced = mutableListOf<File>()
    private val recordingSync = DirSync { synced += it; log += "dirSync:${it.name}" }

    /** Records every step; optional failure injection. */
    private inner class RecordingOps(
        val failMove: IOException? = null,
        val failWrite: IOException? = null,
    ) : FileOps {
        val targetExistedAtMove = mutableListOf<Boolean>()

        override fun openOutput(file: File): FileOutputStream {
            log += "open"
            val fail = failWrite ?: return FileOutputStream(file)
            return object : FileOutputStream(file) {
                override fun write(b: ByteArray, off: Int, len: Int) {
                    super.write(b, off, minOf(len, 1)) // partial bytes reach the tmp file
                    throw fail
                }
            }
        }

        override fun syncStream(out: FileOutputStream) {
            log += "sync"
            FileOps.DEFAULT.syncStream(out)
        }

        override fun syncFile(file: File) {
            log += "syncFile:${file.name}"
            FileOps.DEFAULT.syncFile(file)
        }

        override fun move(from: File, to: File) {
            log += "move"
            targetExistedAtMove += to.exists()
            failMove?.let { throw it }
            FileOps.DEFAULT.move(from, to)
        }
    }

    @Before
    fun setUp() {
        guard = PathGuard.forFilesDir(temp.newFolder("files"))
    }

    private fun files(ops: FileOps = FileOps.DEFAULT, sync: DirSync = recordingSync, disk: DiskSpace = DiskSpace.USABLE) =
        AtomicFiles(guard, sync, disk, ops)

    private fun put(rel: String, bytes: ByteArray): File =
        File(guard.root, rel).apply { parentFile!!.mkdirs(); writeBytes(bytes) }

    // --- writeTextAtomic ---

    @Test
    fun writeCreatesFileAndParents() {
        files().writeTextAtomic("projects/p1/project.json", "{\"id\":\"p1\"}")
        assertEquals("{\"id\":\"p1\"}", File(guard.root, "projects/p1/project.json").readText())
    }

    @Test
    fun writeReplacesExistingContent() {
        put("index.json", "old".toByteArray())
        files().writeTextAtomic("index.json", "new")
        assertEquals("new", File(guard.root, "index.json").readText())
    }

    @Test
    fun writeIsUtf8() {
        files().writeTextAtomic("index.json", "Żółć — фильм")
        assertEquals("Żółć — фильм", File(guard.root, "index.json").readText(Charsets.UTF_8))
    }

    @Test
    fun writeAllowsEmptyText() {
        files().writeTextAtomic("a.txt", "")
        assertEquals(0L, File(guard.root, "a.txt").length())
    }

    @Test
    fun writeLeavesNoTmpFiles() {
        files().writeTextAtomic("projects/p1/project.json", "x")
        files().writeTextAtomic("projects/p1/project.json", "y")
        assertEquals(listOf("project.json"), File(guard.root, "projects/p1").list()!!.toList())
    }

    @Test
    fun writeStepsAreSyncThenMoveThenDirSync() {
        put("index.json", "old".toByteArray())
        val ops = RecordingOps()
        files(ops).writeTextAtomic("index.json", "new")
        assertEquals(listOf("open", "sync", "move", "dirSync:${AppDirs.ROOT}"), log)
        assertEquals(listOf(true), ops.targetExistedAtMove) // never deleted first
    }

    @Test
    fun writeSyncsNewlyCreatedParentDirs() {
        files().writeTextAtomic("projects/p1/project.json", "x")
        // Each created dir's entry is made durable in its parent, then the target's dir.
        val names = synced.map { it.name }
        assertTrue(names.containsAll(listOf("files", AppDirs.ROOT, "projects", "p1")))
        assertEquals("p1", names.last())
    }

    @Test
    fun failingMoveKeepsOldContentAndRemovesTmp() {
        put("index.json", "old".toByteArray())
        expectCode(NativeErrorCode.IO) {
            files(RecordingOps(failMove = IOException("boom"))).writeTextAtomic("index.json", "new")
        }
        assertEquals("old", File(guard.root, "index.json").readText())
        assertEquals(emptyList<String>(), tmpLeftovers(guard.root))
    }

    @Test
    fun failingDirSyncLeavesCompleteNewTarget() {
        put("index.json", "old".toByteArray())
        val failingSync = DirSync { throw IOException("fsync dir failed") }
        expectCode(NativeErrorCode.IO) { files(sync = failingSync).writeTextAtomic("index.json", "new") }
        // The rename happened: the target is never missing or partial.
        assertEquals("new", File(guard.root, "index.json").readText())
        assertEquals(emptyList<String>(), tmpLeftovers(guard.root))
    }

    @Test
    fun noSpaceDuringWriteKeepsOldTargetAndRemovesTmp() {
        put("index.json", "old".toByteArray())
        val ops = RecordingOps(failWrite = IOException("write failed: ENOSPC (No space left on device)"))
        expectCode(NativeErrorCode.NO_SPACE) { files(ops).writeTextAtomic("index.json", "new content") }
        assertEquals("old", File(guard.root, "index.json").readText())
        assertEquals(emptyList<String>(), tmpLeftovers(guard.root))
        assertFalse(log.contains("move"))
    }

    @Test
    fun noSpaceWithoutPriorTargetLeavesNothing() {
        val ops = RecordingOps(failWrite = IOException("No space left on device"))
        expectCode(NativeErrorCode.NO_SPACE) { files(ops).writeTextAtomic("probe/report.json", "x") }
        assertFalse(File(guard.root, "probe/report.json").exists())
        assertEquals(emptyList<String>(), tmpLeftovers(guard.root))
    }

    @Test
    fun writeRejectsBadPaths() {
        expectCode(NativeErrorCode.PATH_INVALID) { files().writeTextAtomic("../index.json", "x") }
        expectCode(NativeErrorCode.PATH_INVALID) { files().writeTextAtomic("/index.json", "x") }
    }

    @Test
    fun writeOverDirectoryIsRejected() {
        File(guard.root, "projects").mkdirs()
        expectCode(NativeErrorCode.PATH_INVALID) { files().writeTextAtomic("projects", "x") }
        assertTrue(File(guard.root, "projects").isDirectory)
    }

    // --- installFile ---

    private val content = "jpeg-bytes-0123456789".toByteArray()
    private val sha = sha256Hex(content)

    @Test
    fun installMovesVerifiedTmpIntoPlace() {
        val tmp = put("tmp/f1.jpg", content)
        val ops = RecordingOps()
        val r = files(ops).installFile("tmp/f1.jpg", "projects/p1/frames/f1.full.jpg", content.size.toLong(), sha)
        assertEquals(InstallResult.INSTALLED, r)
        assertFalse(tmp.exists())
        assertTrue(File(guard.root, "projects/p1/frames/f1.full.jpg").readBytes().contentEquals(content))
        // tmp fsynced before the rename, dest dir fsynced after it.
        val i = log.indexOf("syncFile:f1.jpg")
        assertTrue(i >= 0 && i < log.indexOf("move"))
        assertEquals("dirSync:frames", log.last())
    }

    @Test
    fun installIsIdempotentWhenDestAlreadyMatches() {
        val dest = put("projects/p1/frames/f1.full.jpg", content)
        val tmp = put("tmp/f1.jpg", content)
        val r = files().installFile("tmp/f1.jpg", "projects/p1/frames/f1.full.jpg", content.size.toLong(), sha)
        assertEquals(InstallResult.ALREADY_INSTALLED, r)
        assertFalse(tmp.exists())
        assertTrue(dest.readBytes().contentEquals(content))
    }

    @Test
    fun repeatedInstallAfterSuccessSucceeds() {
        put("tmp/f1.jpg", content)
        val f = files()
        assertEquals(InstallResult.INSTALLED, f.installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha))
        assertEquals(InstallResult.ALREADY_INSTALLED, f.installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha))
        assertEquals("frames", synced.last().name) // the rename is re-synced on the repeat
    }

    @Test
    fun installReplacesDifferingDestWithoutDeletingItFirst() {
        put("frames/f1.jpg", "stale-and-different".toByteArray())
        put("tmp/f1.jpg", content)
        val ops = RecordingOps()
        val r = files(ops).installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha)
        assertEquals(InstallResult.INSTALLED, r)
        assertEquals(listOf(true), ops.targetExistedAtMove)
        assertTrue(File(guard.root, "frames/f1.jpg").readBytes().contentEquals(content))
    }

    @Test
    fun installAcceptsUpperCaseSha() {
        put("tmp/f1.jpg", content)
        files().installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha.uppercase())
        assertTrue(File(guard.root, "frames/f1.jpg").exists())
    }

    @Test
    fun installTmpWithWrongHashKeepsDestAndTmp() {
        val dest = put("frames/f1.jpg", "old".toByteArray())
        val bad = content.copyOf().also { it[0] = 'X'.code.toByte() }
        val tmp = put("tmp/f1.jpg", bad)
        expectCode(NativeErrorCode.CHECKSUM_MISMATCH) {
            files().installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha)
        }
        assertEquals("old", dest.readText())
        assertTrue(tmp.readBytes().contentEquals(bad))
    }

    @Test
    fun installTmpWithWrongSizeIsAMismatch() {
        put("tmp/f1.jpg", content + 1)
        expectCode(NativeErrorCode.CHECKSUM_MISMATCH) {
            files().installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha)
        }
        assertFalse(File(guard.root, "frames/f1.jpg").exists())
    }

    @Test
    fun installWithoutTmpOrDestIsNotFound() {
        expectCode(NativeErrorCode.NOT_FOUND) {
            files().installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha)
        }
    }

    @Test
    fun installWithoutTmpAndInvalidDestIsNotFoundAndKeepsDest() {
        val dest = put("frames/f1.jpg", "different".toByteArray())
        expectCode(NativeErrorCode.NOT_FOUND) {
            files().installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha)
        }
        assertEquals("different", dest.readText())
    }

    @Test
    fun installFailingMoveKeepsBothFilesForARetry() {
        val dest = put("frames/f1.jpg", "old".toByteArray())
        val tmp = put("tmp/f1.jpg", content)
        expectCode(NativeErrorCode.IO) {
            files(RecordingOps(failMove = IOException("boom"))).installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha)
        }
        assertEquals("old", dest.readText())
        assertTrue(tmp.exists())
        assertEquals(InstallResult.INSTALLED, files().installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha))
    }

    @Test
    fun installNoSpaceIsMapped() {
        put("tmp/f1.jpg", content)
        val ops = RecordingOps(failMove = FileSystemException("tmp/f1.jpg", null, "No space left on device"))
        expectCode(NativeErrorCode.NO_SPACE) {
            files(ops).installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha)
        }
    }

    @Test
    fun installRejectsBadArguments() {
        put("tmp/f1.jpg", content)
        val f = files()
        expectCode(NativeErrorCode.BAD_ARGUMENT) { f.installFile("tmp/f1.jpg", "frames/f1.jpg", -1, sha) }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { f.installFile("tmp/f1.jpg", "frames/f1.jpg", 1, "abc") }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { f.installFile("tmp/f1.jpg", "frames/f1.jpg", 1, "g".repeat(64)) }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { f.installFile("tmp/f1.jpg", "tmp/f1.jpg", content.size.toLong(), sha) }
        expectCode(NativeErrorCode.PATH_INVALID) { f.installFile("../f1.jpg", "frames/f1.jpg", content.size.toLong(), sha) }
        expectCode(NativeErrorCode.PATH_INVALID) { f.installFile("tmp/f1.jpg", "/frames/f1.jpg", content.size.toLong(), sha) }
    }

    @Test
    fun installOverDirectoryIsRejected() {
        put("tmp/f1.jpg", content)
        File(guard.root, "frames/f1.jpg").mkdirs()
        expectCode(NativeErrorCode.PATH_INVALID) {
            files().installFile("tmp/f1.jpg", "frames/f1.jpg", content.size.toLong(), sha)
        }
    }

    @Test
    fun installsEmptyFile() {
        put("tmp/e", ByteArray(0))
        assertEquals(InstallResult.INSTALLED, files().installFile("tmp/e", "frames/e", 0, sha256Hex(ByteArray(0))))
        assertEquals(0L, File(guard.root, "frames/e").length())
    }

    // --- freeBytes ---

    @Test
    fun freeBytesAsksTheSeamWithTheNearestExistingDir() {
        val asked = mutableListOf<File>()
        val f = files(disk = DiskSpace { asked += it; 12345L })
        assertEquals(12345L, f.freeBytes("tmp/not/yet/there.jpg"))
        assertEquals(12345L, f.freeBytes())
        assertTrue(asked.all { it.isDirectory })
    }

    @Test
    fun freeBytesUsesTheDirItselfWhenItExists() {
        File(guard.root, "exports").mkdirs()
        val asked = mutableListOf<File>()
        files(disk = DiskSpace { asked += it; 1L }).freeBytes("exports")
        assertEquals(File(guard.root, "exports"), asked.single())
    }

    @Test
    fun defaultDiskSpaceReportsSomething() {
        assertTrue(files().freeBytes() > 0)
    }

    @Test
    fun freeBytesRejectsBadPaths() {
        expectCode(NativeErrorCode.PATH_INVALID) { files().freeBytes("../..") }
    }

    @Test
    fun defaultDirSyncWorksOnADirectory() {
        DirSync.CHANNEL.sync(temp.root)
    }
}
