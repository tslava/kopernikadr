package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.InputStream

class ImageImportTest {
    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var guard: PathGuard

    @Before
    fun setUp() {
        guard = PathGuard.forFilesDir(temp.newFolder("files"))
    }

    private fun importer(max: Long = ImageImport.MAX_BYTES) = ImageImport(guard, ids = { "u1" }, maxBytes = max)

    private val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte()) + ByteArray(40) { it.toByte() }
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) + ByteArray(30)
    private fun webp() = "RIFF".toByteArray() + ByteArray(4) + "WEBP".toByteArray() + ByteArray(8)
    private fun heic(brand: String) = byteArrayOf(0, 0, 0, 24) + "ftyp".toByteArray() + brand.toByteArray() + ByteArray(8)

    @Test
    fun capturedPhotoIsMovedToTmp() {
        val src = temp.newFile("photo.jpg").also { it.writeBytes(jpeg) }
        val r = importer().importCaptured(src)
        assertEquals("tmp/photo-u1.jpg", r.path)
        assertEquals("image/jpeg", r.mime)
        assertArrayEquals(jpeg, File(guard.root, r.path).readBytes())
        assertEquals("the capture file is gone", false, src.exists())
    }

    @Test
    fun emptyOrMissingCapturedPhotoIsCancelled() {
        val empty = temp.newFile("empty.jpg")
        expectCode(NativeErrorCode.CANCELLED) { importer().importCaptured(empty) }
        assertEquals(false, empty.exists())
        expectCode(NativeErrorCode.CANCELLED) { importer().importCaptured(File(temp.root, "nope.jpg")) }
        assertEquals(false, File(guard.root, "tmp/photo-u1.jpg").exists())
    }

    @Test
    fun copiesBytesToTmpWithTheMimeExtension() {
        val r = importer().importStream("image/jpeg", jpeg.inputStream())
        assertEquals("tmp/pick-u1.jpg", r.path)
        assertEquals("image/jpeg", r.mime)
        assertArrayEquals(jpeg, File(guard.root, r.path).readBytes())
    }

    @Test
    fun acceptsAllFiveTypesByDeclaredMime() {
        for ((mime, ext) in listOf("image/png" to "png", "image/webp" to "webp", "image/heic" to "heic", "image/heif" to "heif")) {
            assertEquals("tmp/pick-u1.$ext", importer().importStream(mime, png.inputStream()).path)
        }
        assertEquals("image/jpeg", importer().importStream("image/jpg", jpeg.inputStream()).mime)
        assertEquals("image/png", importer().importStream("IMAGE/PNG; charset=x", png.inputStream()).mime)
    }

    @Test
    fun rejectsOtherDeclaredTypes() {
        for (mime in listOf("image/gif", "video/mp4", "application/pdf", "text/plain")) {
            expectCode(NativeErrorCode.UNSUPPORTED) { importer().importStream(mime, jpeg.inputStream()) }
        }
        assertEquals(emptyList<String>(), File(guard.root, "tmp").list()?.toList().orEmpty())
    }

    @Test
    fun missingOrGenericMimeFallsBackToTheHeader() {
        assertEquals("image/jpeg", importer().importStream(null, jpeg.inputStream()).mime)
        assertEquals("image/png", importer().importStream("application/octet-stream", png.inputStream()).mime)
        assertEquals("image/webp", importer().importStream("image/*", webp().inputStream()).mime)
        assertEquals("image/heic", importer().importStream(null, heic("heic").inputStream()).mime)
        assertEquals("image/heif", importer().importStream(null, heic("mif1").inputStream()).mime)
        expectCode(NativeErrorCode.UNSUPPORTED) { importer().importStream(null, "GIF89a-not-allowed".toByteArray().inputStream()) }
        expectCode(NativeErrorCode.UNSUPPORTED) { importer().importStream(null, ByteArray(0).inputStream()) }
        expectCode(NativeErrorCode.UNSUPPORTED) { importer().importStream(null, heic("avif").inputStream()) }
    }

    @Test
    fun sniffHandlesShortHeaders() {
        assertNull(ImageImport.sniff(byteArrayOf(0xFF.toByte())))
        assertNull(ImageImport.sniff("RIFF".toByteArray()))
        assertNull(ImageImport.sniff(byteArrayOf(0, 0, 0, 24) + "ftyp".toByteArray()))
    }

    @Test
    fun capIsCountedWhileCopyingAndLeavesNoFile() {
        // 100 bytes under a 64-byte cap, then exactly 100 under 100.
        val data = jpeg + ByteArray(56)
        assertEquals(100, data.size)
        expectCode(NativeErrorCode.TOO_LARGE) { importer(max = 64).importStream("image/jpeg", data.inputStream()) }
        assertEquals(emptyList<String>(), File(guard.root, "tmp").list()!!.toList())
        assertEquals("tmp/pick-u1.jpg", importer(max = 100).importStream("image/jpeg", data.inputStream()).path)
        expectCode(NativeErrorCode.TOO_LARGE) { importer(max = 99).importStream("image/jpeg", data.inputStream()) }
    }

    @Test
    fun capStopsAnEndlessStreamEarly() {
        var served = 0L
        val endless = object : InputStream() {
            override fun read() = throw UnsupportedOperationException()
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                b.fill(0, off, off + len)
                if (served == 0L) jpeg.copyInto(b, off, 0, 3) // jpeg magic, then zeros forever
                served += len
                return len
            }
        }
        expectCode(NativeErrorCode.TOO_LARGE) { importer(max = 1000).importStream("image/jpeg", endless) }
        assertEquals(true, served < 1000 + 128 * 1024)
    }

    @Test
    fun readFailureLeavesNoFileAndIsIo() {
        val broken = object : InputStream() {
            var first = true
            override fun read() = throw java.io.IOException("boom")
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (first) {
                    first = false
                    jpeg.copyInto(b, off, 0, 16)
                    return 16
                }
                throw java.io.IOException("boom")
            }
        }
        expectCode(NativeErrorCode.IO) { importer().importStream("image/jpeg", broken) }
        assertEquals(emptyList<String>(), File(guard.root, "tmp").list()!!.toList())
    }

    @Test
    fun importFileSniffsTheHeaderAndRejectsMissingFiles() {
        val f = temp.newFile("pic.bin").also { it.writeBytes(png) }
        val r = importer().importFile(f)
        assertEquals("image/png", r.mime)
        assertArrayEquals(png, File(guard.root, r.path).readBytes())
        expectCode(NativeErrorCode.NOT_FOUND) { importer().importFile(File(temp.root, "nope.jpg")) }
    }
}
