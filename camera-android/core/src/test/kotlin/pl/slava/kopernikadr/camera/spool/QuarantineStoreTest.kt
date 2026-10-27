package pl.slava.kopernikadr.camera.spool

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class QuarantineStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var spool: File
    private lateinit var q: File
    private lateinit var store: QuarantineStore

    private val id1 = "01JABCDEFGHJKMNPQRSTVWXYZ0"
    private val id2 = "01JABCDEFGHJKMNPQRSTVWXYZ1"
    private val uuid = "0a1b2c3d-0000-4000-8000-1234567890ab"

    @Before
    fun setUp() {
        spool = File(tmp.root, "spool").also { it.mkdirs() }
        q = File(spool, "quarantine").also { it.mkdirs() }
        store = QuarantineStore(spool)
    }

    private fun put(name: String, size: Int = 3, modified: Long = 1_000L): File =
        File(q, name).also { it.writeBytes(ByteArray(size)); it.setLastModified(modified) }

    @Test
    fun `lists every quarantine name form newest first with sizes`() {
        put("$id1.full.jpg", 10, 1_000)
        put("$id1.full.jpg.dup1", 20, 3_000)
        put("$id2.full.jpg.tmp", 30, 2_000)
        put("$id2.full.jpg.$uuid.tmp", 40, 5_000)
        put("$id2.play.jpg.dup12", 50, 4_000)
        val l = store.list()
        assertEquals(
            listOf("$id2.full.jpg.$uuid.tmp", "$id2.play.jpg.dup12", "$id1.full.jpg.dup1", "$id2.full.jpg.tmp", "$id1.full.jpg"),
            l.entries.map { it.name },
        )
        assertEquals(5, l.count)
        assertEquals(150L, l.bytes)
        assertEquals(40L, l.entries.first().size)
    }

    @Test
    fun `missing directory lists empty and clear is a no-op`() {
        q.deleteRecursively()
        assertEquals(0, store.list().count)
        assertEquals(0, store.clear(emptyList()).removed)
    }

    @Test
    fun `does not list names outside the rule, directories or symlinks`() {
        put("$id1.full.jpg")
        put("stray.txt")
        put("$id1.full.jpg.dup")
        put("$id1.full.jpg.dupx")
        put("$id1.full.png")
        File(q, "$id2.full.jpg.dup1").mkdirs()
        val target = File(tmp.root, "outside.jpg").also { it.writeBytes(ByteArray(1)) }
        Files.createSymbolicLink(File(q, "$id2.thumb.jpg").toPath(), target.toPath())
        assertEquals(listOf("$id1.full.jpg"), store.list().entries.map { it.name })
    }

    @Test
    fun `clear deletes only matching regular files and leaves the rest`() {
        put("$id1.full.jpg")
        put("$id2.full.jpg.dup2")
        val stray = put("stray.txt")
        val sub = File(q, "$id2.full.jpg.dup1").also { it.mkdirs() }
        val inner = File(sub, "$id1.full.jpg").also { it.writeBytes(ByteArray(1)) }
        val outside = File(spool, "$id1.full.jpg").also { it.writeBytes(ByteArray(1)) }
        val target = File(tmp.root, "outside.jpg").also { it.writeBytes(ByteArray(1)) }
        Files.createSymbolicLink(File(q, "$id2.thumb.jpg").toPath(), target.toPath())

        val listed = store.list().entries
        val r = store.clear(listed)
        assertEquals(QuarantineClearResult(2, emptyList()), r)
        assertEquals(listed.size, r.removed)
        assertTrue(stray.exists())
        assertTrue(sub.isDirectory && inner.exists())
        assertTrue(outside.exists())
        assertTrue(target.exists())
        assertTrue(Files.isSymbolicLink(File(q, "$id2.thumb.jpg").toPath()))
        assertEquals(0, store.list().count)
    }

    @Test
    fun `clear deletes only what was listed, so the count equals the list`() {
        put("$id1.full.jpg")
        val listed = store.list().entries
        put("$id2.full.jpg") // appeared after the screen listed
        val r = store.clear(listed)
        assertEquals(1, r.removed)
        assertFalse(File(q, "$id1.full.jpg").exists())
        assertTrue(File(q, "$id2.full.jpg").exists())
    }

    @Test
    fun `a listed file that is gone or no longer a regular file is not counted`() {
        put("$id1.full.jpg")
        put("$id2.full.jpg")
        val listed = store.list().entries
        File(q, "$id1.full.jpg").delete()
        File(q, "$id2.full.jpg").delete()
        File(q, "$id2.full.jpg").mkdirs() // now a directory
        val r = store.clear(listed)
        assertEquals(0, r.removed)
        assertTrue(File(q, "$id2.full.jpg").isDirectory)
    }

    @Test
    fun `a quarantine that is a symlink is not followed`() {
        val real = File(tmp.root, "elsewhere").also { it.mkdirs() }
        val f = File(real, "$id1.full.jpg").also { it.writeBytes(ByteArray(1)) }
        q.deleteRecursively()
        Files.createSymbolicLink(q.toPath(), real.toPath())
        assertEquals(0, store.list().count)
        assertEquals(0, store.clear(listOf(QuarantineEntry("$id1.full.jpg", 1, 0))).removed)
        assertTrue(f.exists())
    }

    @Test
    fun `names produced by SpoolFiles quarantine match the rule`() {
        File(spool, "$id1.full.jpg").writeBytes(ByteArray(1))
        assertTrue(SpoolFiles.quarantine(spool, File(spool, "$id1.full.jpg")))
        File(spool, "$id1.full.jpg").writeBytes(ByteArray(2))
        assertTrue(SpoolFiles.quarantine(spool, File(spool, "$id1.full.jpg")))
        assertEquals(setOf("$id1.full.jpg", "$id1.full.jpg.dup1"), store.list().entries.map { it.name }.toSet())
    }
}
