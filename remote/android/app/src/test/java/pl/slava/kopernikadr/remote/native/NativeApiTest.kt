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
import java.util.Base64

/** The bridge contract of `KopernikadrNative` (arguments in, result maps out), with a fake MediaStore. */
class NativeApiTest {
    @get:Rule
    val temp = TemporaryFolder()

    private val store = FakeMediaStore()
    private val logs = mutableListOf<String>()
    private lateinit var guard: PathGuard
    private lateinit var api: NativeApi

    @Before
    fun setUp() {
        guard = PathGuard.forFilesDir(temp.newFolder("files"))
        var n = 0
        val disk = DiskSpace { Long.MAX_VALUE }
        api = NativeApi(
            files = AtomicFiles(guard, DirSync.NONE, disk),
            writer = VideoWriter(guard, DirSync.NONE, ids = { "h${++n}" }, disk = disk),
            gallery = GalleryPublisher(store, "pkg", temp.newFolder("sdcard"), disk, 0),
            log = { logs += it },
        )
    }

    private fun args(vararg pairs: Pair<String, Any>) = BridgeArgs(mapOf(*pairs)::get)

    private fun b64(s: String) = Base64.getEncoder().encodeToString(s.toByteArray())

    @Test
    fun writeTextAtomicWritesAndReturnsNothing() {
        assertEquals(emptyMap<String, Any>(), api.writeTextAtomic(args("path" to "probe/r.json", "text" to "{}")))
        assertEquals("{}", File(guard.root, "probe/r.json").readText())
    }

    @Test
    fun installFileReturnsTheResultName() {
        val tmp = File(guard.root, "tmp/a.jpg").also { it.parentFile!!.mkdirs(); it.writeText("jpeg") }
        val a = args("tmp" to "tmp/a.jpg", "dest" to "projects/p/a.jpg", "bytes" to 4, "sha256" to sha256Hex("jpeg".toByteArray()))
        assertEquals(mapOf("result" to "INSTALLED"), api.installFile(a))
        assertFalse(tmp.exists())
        assertEquals(mapOf("result" to "ALREADY_INSTALLED"), api.installFile(a))
    }

    @Test
    fun freeBytesWithAndWithoutPath() {
        assertEquals(mapOf("bytes" to Long.MAX_VALUE), api.freeBytes(args()))
        assertEquals(mapOf("bytes" to Long.MAX_VALUE), api.freeBytes(args("path" to "tmp/x")))
    }

    @Test
    fun fullVideoFlowOutOfOrderChunksThenPublish() {
        val open = api.videoOpen(args())
        assertEquals(mapOf("handle" to "h1", "path" to "exports/export-h1.mp4"), open)
        api.videoWriteAt(args("handle" to "h1", "position" to 5, "data" to b64("world")))
        api.videoWriteAt(args("handle" to "h1", "position" to 0, "data" to b64("hello")))
        api.videoClose(args("handle" to "h1"))
        val res = api.videoPublish(args("handle" to "h1", "displayName" to "clip"))
        val uri = res.getValue("uri") as String
        assertEquals("helloworld", String(store.rows.getValue(uri).content.toByteArray()))
        assertEquals("kopernikadr-clip.mp4", store.rows.getValue(uri).values["_display_name"])
        assertFalse("temp deleted after publish", File(guard.root, "exports/export-h1.mp4").exists())
        // The handle is spent.
        expectCode(NativeErrorCode.CLOSED) { api.videoPublish(args("handle" to "h1", "displayName" to "clip")) }
        api.videoAbort(args("handle" to "h1")) // still idempotent
    }

    @Test
    fun publishNeedsAClosedHandle() {
        api.videoOpen(args())
        expectCode(NativeErrorCode.BAD_HANDLE) { api.videoPublish(args("handle" to "h1", "displayName" to "c")) }
        expectCode(NativeErrorCode.BAD_HANDLE) { api.videoPublish(args("handle" to "nope", "displayName" to "c")) }
        assertEquals(emptyList<String>(), store.log)
    }

    @Test
    fun failedPublishKeepsTheTempFileForARetry() {
        api.videoOpen(args())
        api.videoWriteAt(args("handle" to "h1", "position" to 0, "data" to b64("abc")))
        api.videoClose(args("handle" to "h1"))
        store.failWriteAfterBytes = 0
        expectCode(NativeErrorCode.IO) { api.videoPublish(args("handle" to "h1", "displayName" to "c")) }
        assertTrue(File(guard.root, "exports/export-h1.mp4").isFile)
        assertTrue(store.rows.isEmpty())
        store.failWriteAfterBytes = null
        val uri = api.videoPublish(args("handle" to "h1", "displayName" to "c")).getValue("uri")
        assertEquals("abc", String(store.rows.getValue(uri as String).content.toByteArray()))
    }

    @Test
    fun cleanupReportsFilesAndRows() {
        api.videoOpen(args()) // live: kept
        File(guard.root, "exports/export-old.mp4").writeText("stale")
        store.insert(mapOf("_display_name" to "kopernikadr-x.mp4", "is_pending" to 1))
        assertEquals(mapOf("deletedFiles" to 1, "deletedRows" to 1), api.videoCleanupAbandoned(args()))
        assertTrue(File(guard.root, "exports/export-h1.mp4").isFile)
    }

    @Test
    fun testInsertPendingDefaultsItsName() {
        val uri = api.testInsertPending(args()).getValue("uri") as String
        assertEquals("kopernikadr-test-pending.mp4", store.rows.getValue(uri).values["_display_name"])
        assertEquals(1, store.rows.getValue(uri).values["is_pending"])
    }

    @Test
    fun missingArgumentsAreBadArgument() {
        val cases: List<Pair<String, () -> Unit>> = listOf(
            "writeTextAtomic/path" to { api.writeTextAtomic(args("text" to "x")) },
            "writeTextAtomic/text" to { api.writeTextAtomic(args("path" to "a")) },
            "installFile/sha256" to { api.installFile(args("tmp" to "a", "dest" to "b", "bytes" to 1)) },
            "installFile/bytes" to { api.installFile(args("tmp" to "a", "dest" to "b", "sha256" to "0".repeat(64))) },
            "videoWriteAt/handle" to { api.videoWriteAt(args("position" to 0, "data" to "")) },
            "videoWriteAt/position" to { api.videoWriteAt(args("handle" to "h1", "data" to "")) },
            "videoWriteAt/data" to { api.videoWriteAt(args("handle" to "h1", "position" to 0)) },
            "videoWriteAt/badBase64" to { api.videoWriteAt(args("handle" to "h1", "position" to 0, "data" to "%%")) },
            "videoClose/handle" to { api.videoClose(args()) },
            "videoPublish/displayName" to { api.videoPublish(args("handle" to "h1")) },
            "videoAbort/handle" to { api.videoAbort(args()) },
        )
        api.videoOpen(args())
        for ((name, call) in cases) {
            try {
                call()
                throw AssertionError("$name: no error")
            } catch (e: NativeException) {
                assertEquals(name, NativeErrorCode.BAD_ARGUMENT, e.code)
            }
        }
    }

    @Test
    fun writeAtDecodesBinarySafely() {
        api.videoOpen(args())
        val bytes = ByteArray(256) { it.toByte() }
        api.videoWriteAt(args("handle" to "h1", "position" to 0, "data" to Base64.getEncoder().encodeToString(bytes)))
        api.videoClose(args("handle" to "h1"))
        assertArrayEquals(bytes, File(guard.root, "exports/export-h1.mp4").readBytes())
    }
}
