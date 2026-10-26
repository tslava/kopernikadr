package pl.slava.kopernikadr.camera.spool

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DurableFilesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val synced = mutableListOf<File>()
    private val files = DurableFiles { synced += it }

    @Test
    fun `writes, replaces atomically and syncs the dir`() {
        val dir = tmp.newFolder("spool")
        val f = files.writeAtomic(dir, "a.full.jpg", byteArrayOf(1, 2, 3))
        assertArrayEquals(byteArrayOf(1, 2, 3), f.readBytes())
        files.writeAtomic(dir, "a.full.jpg", byteArrayOf(9))
        assertArrayEquals(byteArrayOf(9), f.readBytes())
        assertEquals(listOf(dir, dir), synced)
        assertEquals(listOf("a.full.jpg"), dir.list()!!.toList())
    }

    @Test
    fun `non-durable write skips dir sync`() {
        val dir = tmp.newFolder("spool")
        files.writeAtomic(dir, "a.thumb.jpg", byteArrayOf(1), durable = false)
        assertTrue(synced.isEmpty())
    }

    @Test
    fun `failure leaves no target and no tmp`() {
        val dir = tmp.newFolder("spool")
        // The target name is a non-empty directory: the rename fails.
        File(dir, "x.full.jpg").mkdir()
        File(dir, "x.full.jpg/inner").writeText("keep")
        try {
            files.writeAtomic(dir, "x.full.jpg", byteArrayOf(1))
            fail("expected an exception")
        } catch (_: Exception) {
        }
        assertEquals(listOf("x.full.jpg"), dir.list()!!.toList())
        assertTrue(File(dir, "x.full.jpg").isDirectory)

        val missing = File(dir, "missing")
        try {
            files.writeAtomic(missing, "y.full.jpg", byteArrayOf(1))
            fail("expected an exception")
        } catch (_: Exception) {
        }
        assertFalse(File(missing, "y.full.jpg").exists())
        assertTrue(synced.isEmpty())
    }

    @Test
    fun sha256() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            DurableFiles.sha256("abc".toByteArray()),
        )
    }
}
