package pl.slava.kopernikadr.remote.native

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureFilesTest {
    private fun dir() = File(System.getProperty("java.io.tmpdir"), "capture-test-${System.nanoTime()}")

    @Test
    fun `each request gets its own file and takes exactly that one`() {
        val c = CaptureFiles(dir())
        val a = c.newFor("A")
        val b = c.newFor("B")
        assertNotEquals(a, b)
        assertEquals(a.parentFile, b.parentFile)
        assertTrue(a.parentFile!!.isDirectory)
        assertEquals(b, c.take("B"))
        assertEquals(a, c.take("A"))
        assertNull(c.take("A"))
        assertNull(c.take(null))
    }

    @Test
    fun `a stale request cleanup leaves the newer photo alone`() {
        val c = CaptureFiles(dir())
        val a = c.newFor("A").also { it.writeText("a") }
        val b = c.newFor("B").also { it.writeText("b") }
        c.discard("A")
        assertFalse(a.exists())
        assertTrue(b.exists())
        assertEquals(1, c.pending())
        c.discard("B")
        assertFalse(b.exists())
        assertEquals(0, c.pending())
    }

    @Test
    fun `a reused call id drops the older file`() {
        val c = CaptureFiles(dir())
        val a = c.newFor("X").also { it.writeText("a") }
        val b = c.newFor("X")
        assertFalse(a.exists())
        assertEquals(b, c.take("X"))
    }
}
