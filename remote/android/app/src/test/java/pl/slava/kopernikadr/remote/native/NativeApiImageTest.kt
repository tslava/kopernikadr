package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** `importPicked` and the debug `testImportImage` hook of [NativeApi]. */
class NativeApiImageTest {
    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var guard: PathGuard
    private lateinit var downloads: File
    private lateinit var api: NativeApi
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)

    @Before
    fun setUp() {
        guard = PathGuard.forFilesDir(temp.newFolder("files"))
        downloads = temp.newFolder("sdcard", "Download")
        val disk = DiskSpace { Long.MAX_VALUE }
        api = NativeApi(
            files = AtomicFiles(guard, DirSync.NONE, disk),
            writer = VideoWriter(guard, DirSync.NONE, disk = disk),
            gallery = GalleryPublisher(FakeMediaStore(), "pkg", temp.newFolder("vol"), disk, 0),
            images = ImageImport(guard, ids = { "i1" }),
            testImportRoots = listOf(downloads),
        )
    }

    private fun args(vararg pairs: Pair<String, Any>) = BridgeArgs(mapOf(*pairs)::get)

    @Test
    fun importPickedReturnsPathAndMime() {
        val r = api.importPicked("image/png", png.inputStream())
        assertEquals(mapOf("path" to "tmp/pick-i1.png", "mime" to "image/png"), r)
        assertArrayEquals(png, File(guard.root, "tmp/pick-i1.png").readBytes())
    }

    @Test
    fun importPickedRejectsUnsupportedTypes() {
        expectCode(NativeErrorCode.UNSUPPORTED) { api.importPicked("image/gif", png.inputStream()) }
    }

    @Test
    fun testImportCopiesFromTheTestFolder() {
        val f = File(downloads, "toy.png").also { it.writeBytes(png) }
        val r = api.testImportImage(args("path" to f.path))
        assertEquals(mapOf("path" to "tmp/pick-i1.png", "mime" to "image/png"), r)
        assertEquals("source is kept", true, f.isFile)
    }

    @Test
    fun testImportRefusesOtherFolders() {
        val outside = temp.newFile("secret.png").also { it.writeBytes(png) }
        expectCode(NativeErrorCode.PATH_INVALID) { api.testImportImage(args("path" to outside.path)) }
        val sneaky = File(downloads, "../secret.png")
        expectCode(NativeErrorCode.PATH_INVALID) { api.testImportImage(args("path" to sneaky.path)) }
    }

    @Test
    fun testImportNeedsAPathAndAnExistingFile() {
        expectCode(NativeErrorCode.BAD_ARGUMENT) { api.testImportImage(args()) }
        expectCode(NativeErrorCode.NOT_FOUND) { api.testImportImage(args("path" to File(downloads, "nope.png").path)) }
    }
}
