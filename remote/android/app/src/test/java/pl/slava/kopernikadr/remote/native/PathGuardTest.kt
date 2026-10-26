package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class PathGuardTest {
    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var filesDir: File
    private lateinit var guard: PathGuard

    @Before
    fun setUp() {
        filesDir = temp.newFolder("files")
        guard = PathGuard.forFilesDir(filesDir)
    }

    @Test
    fun rootIsFilesDirKopernikadr() {
        assertEquals(File(filesDir, AppDirs.ROOT).canonicalFile, guard.root)
    }

    @Test
    fun resolvesRelativePathUnderRootEvenIfMissing() {
        val f = guard.resolve("tmp/abc.jpg")
        assertEquals(File(guard.root, "tmp/abc.jpg"), f)
        assertFalse(f.exists())
    }

    @Test
    fun resolvesNestedPaths() {
        assertEquals(File(guard.root, "projects/p1/frames/f1.full.jpg"), guard.resolve("projects/p1/frames/f1.full.jpg"))
        assertEquals(File(guard.root, "index.json"), guard.resolve("index.json"))
    }

    @Test
    fun rootIsCanonicalEvenWhenInjectedThroughASymlink() {
        val real = temp.newFolder("real")
        val link = File(temp.root, "link")
        Files.createSymbolicLink(link.toPath(), real.toPath())
        val g = PathGuard(link)
        assertEquals(real.canonicalFile, g.root)
        assertEquals(File(real.canonicalFile, "a.json"), g.resolve("a.json"))
    }

    @Test
    fun rejectsInvalidPaths() {
        val bad = listOf(
            "", "/etc/passwd", "/", "..", "../x", "a/../b", "a/..", "./a", "a/./b", ".",
            "a//b", "a/", "a\u0000b", "a\\b", "\\x",
        )
        for (p in bad) {
            expectCode(NativeErrorCode.PATH_INVALID) { guard.resolve(p) }
        }
    }

    @Test
    fun allowsDotsInsideNames() {
        assertEquals(File(guard.root, "a..b/.hidden/x.y.z"), guard.resolve("a..b/.hidden/x.y.z"))
    }

    @Test
    fun rejectsSymlinkedDirEscapingRoot() {
        val outside = temp.newFolder("outside")
        guard.root.mkdirs()
        Files.createSymbolicLink(File(guard.root, "tmp").toPath(), outside.toPath())
        expectCode(NativeErrorCode.PATH_INVALID) { guard.resolve("tmp/x.jpg") }
        expectCode(NativeErrorCode.PATH_INVALID) { guard.resolve("tmp") }
    }

    @Test
    fun rejectsSymlinkedFileEscapingRoot() {
        val outside = temp.newFile("secret.txt")
        guard.root.mkdirs()
        Files.createSymbolicLink(File(guard.root, "index.json").toPath(), outside.toPath())
        expectCode(NativeErrorCode.PATH_INVALID) { guard.resolve("index.json") }
    }

    @Test
    fun rejectsSymlinkToRootItself() {
        guard.root.mkdirs()
        Files.createSymbolicLink(File(guard.root, "self").toPath(), guard.root.toPath())
        expectCode(NativeErrorCode.PATH_INVALID) { guard.resolve("self") }
    }

    @Test
    fun allowsSymlinkStayingInsideRoot() {
        val exports = File(guard.root, "exports").apply { mkdirs() }
        Files.createSymbolicLink(File(guard.root, "alias").toPath(), exports.toPath())
        val f = guard.resolve("alias/x.mp4")
        assertTrue(f.path.startsWith(guard.root.path + File.separator))
        assertEquals(File(exports.canonicalFile, "x.mp4"), f)
    }
}
