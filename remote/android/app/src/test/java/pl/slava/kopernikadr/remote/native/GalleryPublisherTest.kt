package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

class GalleryPublisherTest {
    @get:Rule
    val temp = TemporaryFolder()

    private val store = FakeMediaStore()
    private lateinit var volume: File
    private lateinit var video: File
    private val content = ByteArray(3 * (1 shl 20) + 17) { (it % 251).toByte() }
    private val diskCalls = mutableListOf<File>()

    @Before
    fun setUp() {
        volume = temp.newFolder("sdcard")
        video = temp.newFile("export-1.mp4").also { it.writeBytes(content) }
    }

    private fun publisher(free: Long = Long.MAX_VALUE, reserve: Long = 300) =
        GalleryPublisher(store, PKG, volume, DiskSpace { diskCalls += it; free }, reserve)

    // --- publish: happy path ---

    @Test
    fun publishInsertsPendingCopiesThenClearsPending() {
        val uri = publisher().publish(video, "clip")
        assertEquals(listOf("insert", "openOutput", "flush", "close", "update:{is_pending=0}"), store.log)
        val row = store.rows.getValue(uri)
        assertEquals("kopernikadr-clip.mp4", row.values["_display_name"])
        assertEquals("video/mp4", row.values["mime_type"])
        assertEquals("Movies/Kopernikadr/", row.values["relative_path"])
        assertEquals(0, row.values["is_pending"])
        assertArrayEquals(content, row.content.toByteArray())
        assertEquals(listOf(volume), diskCalls)
    }

    @Test
    fun insertedRowIsPendingWithAllColumns() {
        publisher().publish(video, "clip")
        assertEquals(
            mapOf(
                "_display_name" to "kopernikadr-clip.mp4",
                "mime_type" to "video/mp4",
                "relative_path" to "Movies/Kopernikadr/",
                "is_pending" to 1,
            ),
            store.inserted.single(),
        )
    }

    @Test
    fun publishDoesNotTouchTheSourceFile() {
        publisher().publish(video, "clip")
        assertArrayEquals(content, video.readBytes())
    }

    // --- free space ---

    @Test
    fun noSpaceBeforeInsert() {
        expectCode(NativeErrorCode.NO_SPACE) { publisher(free = content.size + 299L).publish(video, "clip") }
        assertEquals(emptyList<String>(), store.log)
    }

    @Test
    fun exactlyEnoughSpacePublishes() {
        publisher(free = content.size + 300L).publish(video, "clip")
        assertEquals("insert", store.log.first())
    }

    @Test
    fun defaultReserveIs300MiB() {
        assertEquals(300L * 1024 * 1024, GalleryPublisher.RESERVE_BYTES)
        val p = GalleryPublisher(store, PKG, volume, DiskSpace { content.size + GalleryPublisher.RESERVE_BYTES - 1 })
        expectCode(NativeErrorCode.NO_SPACE) { p.publish(video, "clip") }
    }

    @Test
    fun diskSpaceIoErrorIsIo() {
        val p = GalleryPublisher(store, PKG, volume, DiskSpace { throw IOException("statfs failed") }, 0)
        expectCode(NativeErrorCode.IO) { p.publish(video, "clip") }
        assertEquals(emptyList<String>(), store.log)
    }

    @Test
    fun missingSourceIsNotFoundBeforeInsert() {
        expectCode(NativeErrorCode.NOT_FOUND) { publisher().publish(File(temp.root, "nope.mp4"), "clip") }
        assertEquals(emptyList<String>(), store.log)
    }

    // --- failures after insert delete the row ---

    @Test
    fun copyFailureDeletesTheRow() {
        store.failWriteAfterBytes = 1 shl 20
        expectCode(NativeErrorCode.IO) { publisher().publish(video, "clip") }
        assertEquals(listOf("insert", "openOutput", "close", "delete"), store.log)
        assertTrue(store.rows.isEmpty())
    }

    @Test
    fun enospcDuringCopyIsNoSpaceAndDeletesTheRow() {
        store.failWriteAfterBytes = 0
        store.failWrite = IOException("write failed: ENOSPC (No space left on device)")
        expectCode(NativeErrorCode.NO_SPACE) { publisher().publish(video, "clip") }
        assertEquals("delete", store.log.last())
        assertTrue(store.rows.isEmpty())
    }

    @Test
    fun closeFailureDeletesTheRow() {
        store.failClose = IOException("fuse close failed")
        expectCode(NativeErrorCode.IO) { publisher().publish(video, "clip") }
        assertEquals("delete", store.log.last())
        assertTrue(store.rows.isEmpty())
    }

    @Test
    fun nullOutputStreamDeletesTheRow() {
        store.outputIsNull = true
        expectCode(NativeErrorCode.IO) { publisher().publish(video, "clip") }
        assertEquals(listOf("insert", "openOutput", "delete"), store.log)
    }

    @Test
    fun updateFailureDeletesTheRow() {
        store.failUpdate = SecurityException("denied")
        expectCode(NativeErrorCode.IO) { publisher().publish(video, "clip") }
        assertEquals("delete", store.log.last())
        assertTrue(store.rows.isEmpty())
    }

    @Test
    fun updateOfZeroRowsDeletesTheRow() {
        store.updateCount = 0
        expectCode(NativeErrorCode.IO) { publisher().publish(video, "clip") }
        assertEquals("delete", store.log.last())
    }

    @Test
    fun failedDeleteIsSuppressedAndTheOriginalErrorSurfaces() {
        store.failWriteAfterBytes = 0
        store.failDelete = IllegalStateException("delete failed")
        val e = expectCode(NativeErrorCode.IO) { publisher().publish(video, "clip") }
        assertTrue(e.message!!.contains("write failed"))
        assertEquals("delete failed", e.suppressed.single().message)
    }

    @Test
    fun insertFailureIsIoWithNothingToDelete() {
        store.failInsert = IllegalArgumentException("bad volume")
        expectCode(NativeErrorCode.IO) { publisher().publish(video, "clip") }
        assertEquals(listOf("insert"), store.log)
    }

    @Test
    fun insertReturningNullIsIo() {
        store.insertReturnsNull = true
        expectCode(NativeErrorCode.IO) { publisher().publish(video, "clip") }
        assertEquals(listOf("insert"), store.log)
    }

    // --- display name ---

    @Test
    fun displayNameGetsPrefixAndExtension() {
        assertEquals("kopernikadr-clip.mp4", GalleryPublisher.normalizeDisplayName("clip"))
        assertEquals("kopernikadr-clip.mp4", GalleryPublisher.normalizeDisplayName("clip.mp4"))
        assertEquals("kopernikadr-clip.mp4", GalleryPublisher.normalizeDisplayName("clip.MP4"))
        assertEquals("kopernikadr-clip.mp4", GalleryPublisher.normalizeDisplayName("kopernikadr-clip.mp4"))
        assertEquals("kopernikadr-clip.mp4", GalleryPublisher.normalizeDisplayName("  kopernikadr-clip  "))
        assertEquals("kopernikadr-Kasia 2026-10-26.mp4", GalleryPublisher.normalizeDisplayName("Kasia 2026-10-26"))
        assertEquals("kopernikadr-clip.webm.mp4", GalleryPublisher.normalizeDisplayName("clip.webm"))
    }

    @Test
    fun displayNameUnsafeCharsAreReplaced() {
        assertEquals("kopernikadr-.._.._x.mp4", GalleryPublisher.normalizeDisplayName("../../x"))
        assertEquals("kopernikadr-a_b_c_d.mp4", GalleryPublisher.normalizeDisplayName("a/b\\c\u0000d"))
        assertEquals("kopernikadr-a_b.mp4", GalleryPublisher.normalizeDisplayName("a:b"))
    }

    @Test
    fun blankOrTooLongDisplayNameIsBadArgument() {
        for (bad in listOf("", "   ", ".mp4", "kopernikadr-", "kopernikadr-.mp4", "..")) {
            expectCode(NativeErrorCode.BAD_ARGUMENT) { GalleryPublisher.normalizeDisplayName(bad) }
        }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { GalleryPublisher.normalizeDisplayName("x".repeat(200)) }
        assertEquals(200, GalleryPublisher.normalizeDisplayName("x".repeat(184)).length)
    }

    @Test
    fun badDisplayNameFailsBeforeAnyCall() {
        expectCode(NativeErrorCode.BAD_ARGUMENT) { publisher().publish(video, " ") }
        assertEquals(emptyList<String>(), store.log)
        assertEquals(emptyList<File>(), diskCalls)
    }

    // --- cleanup ---

    @Test
    fun cleanupQueryMatchesOwnPendingRowsIncludingPending() {
        publisher().cleanupAbandoned()
        val args = store.lastQueryArgs!!
        assertEquals(
            "owner_package_name = ? AND is_pending = 1 AND _display_name LIKE 'kopernikadr-%'",
            args["android:query-arg-sql-selection"],
        )
        assertArrayEquals(arrayOf(PKG), args["android:query-arg-sql-selection-args"] as Array<*>)
        // MediaStore.QUERY_ARG_MATCH_PENDING = MediaStore.MATCH_INCLUDE (1)
        assertEquals(1, args["android:query-arg-match-pending"])
        assertEquals(3, args.size)
    }

    @Test
    fun cleanupDeletesEveryReturnedRowAndCountsThem() {
        val p = publisher()
        p.insertPendingForTest("a")
        p.insertPendingForTest("b")
        p.publish(video, "done")
        assertEquals(2, p.cleanupAbandoned())
        assertEquals(1, store.rows.size)
        assertEquals(0, store.rows.values.single().values["is_pending"])
        assertEquals(listOf("query", "delete", "delete"), store.log.takeLast(3))
    }

    @Test
    fun cleanupCountsOnlyActuallyDeletedRows() {
        store.queryResult = listOf("content://media/external_primary/video/media/404")
        assertEquals(0, publisher().cleanupAbandoned())
    }

    @Test
    fun cleanupWithNothingPendingIsZero() {
        assertEquals(0, publisher().cleanupAbandoned())
        assertEquals(listOf("query"), store.log)
    }

    @Test
    fun cleanupProviderErrorIsIo() {
        store.queryResult = listOf("content://x/1")
        store.failDelete = SecurityException("not owner")
        expectCode(NativeErrorCode.IO) { publisher().cleanupAbandoned() }
    }

    @Test
    fun insertPendingForTestLeavesAPendingNormalizedRow() {
        val uri = publisher().insertPendingForTest("t")
        val row = store.rows.getValue(uri)
        assertEquals("kopernikadr-t.mp4", row.values["_display_name"])
        assertEquals(1, row.values["is_pending"])
        assertEquals("Movies/Kopernikadr/", row.values["relative_path"])
    }

    private companion object {
        const val PKG = "pl.slava.kopernikadr.remote.debug"
    }
}
