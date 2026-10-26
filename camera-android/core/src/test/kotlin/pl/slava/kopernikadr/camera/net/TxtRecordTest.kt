package pl.slava.kopernikadr.camera.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.protocol.VersionRange

class TxtRecordTest {
    private val cameraId = "292efcc0-ff61-46da-9efd-78dfb1d2c5d1"

    @Test
    fun `camera record carries id, pv and name in order`() {
        val txt = TxtRecord.forCamera(cameraId, "Kopernikadr Kamera")
        assertEquals(listOf("id", "pv", "name"), txt.entries.keys.toList())
        assertEquals(cameraId, txt.entries["id"])
        assertEquals("1-1", txt.entries["pv"])
        assertEquals("Kopernikadr Kamera", txt.entries["name"])
    }

    @Test
    fun `pv is min-max of the version range`() {
        assertEquals("1-3", TxtRecord.forCamera(cameraId, "k", VersionRange(1, 3)).entries["pv"])
        assertEquals("2-2", TxtRecord.forCamera(cameraId, "k", VersionRange(2, 2)).entries["pv"])
    }

    @Test
    fun `blank camera id is rejected`() {
        assertThrows(IllegalArgumentException::class.java) { TxtRecord.forCamera("", "k") }
        assertThrows(IllegalArgumentException::class.java) { TxtRecord.forCamera("  ", "k") }
    }

    @Test
    fun `an entry is key=value within 255 bytes`() {
        // "id=" + 252 bytes = 255: fits; one more byte does not.
        val fits = "a".repeat(252)
        assertEquals(fits, TxtRecord.forCamera(fits, "k").entries["id"])
        assertThrows(IllegalArgumentException::class.java) { TxtRecord.forCamera(fits + "a", "k") }
    }

    @Test
    fun `value size counts UTF-8 bytes, not chars`() {
        // 'ł' is 2 bytes: 126 of them make 252 bytes (fits), 127 make 254 (+3 = 257, too long).
        TxtRecord(mapOf("id" to "ł".repeat(126)))
        assertThrows(IllegalArgumentException::class.java) { TxtRecord(mapOf("id" to "ł".repeat(127))) }
    }

    @Test
    fun `a long name is truncated to fit, on a code point boundary`() {
        val long = "Kamera " + "ł".repeat(200)
        val name = TxtRecord.forCamera(cameraId, long).entries.getValue("name")
        assertTrue(long.startsWith(name))
        val entryBytes = "name=".length + name.toByteArray(Charsets.UTF_8).size
        assertTrue("entry is $entryBytes bytes", entryBytes in 254..255)

        // A surrogate pair (4 bytes in UTF-8) is never split.
        val emoji = "📷".repeat(100) // 400 bytes
        val cut = TxtRecord.forCamera(cameraId, emoji).entries.getValue("name")
        assertEquals(0, cut.length % 2)
        assertTrue(emoji.startsWith(cut))
        assertTrue("name=".length + cut.toByteArray(Charsets.UTF_8).size <= 255)
    }

    @Test
    fun `empty name is kept as an empty value`() {
        assertEquals("", TxtRecord.forCamera(cameraId, "").entries["name"])
    }

    @Test
    fun `keys are 1-9 printable ASCII chars without '='`() {
        for (bad in listOf("", "a=b", "zażółć", "tab\tkey", "toolongkey", "\u007f")) {
            assertThrows("key '$bad'", IllegalArgumentException::class.java) { TxtRecord(mapOf(bad to "v")) }
        }
        TxtRecord(mapOf("ninechars" to "v", "a b" to "v", "~!" to "v"))
    }

    @Test
    fun `keys are case-insensitive, so ID and id clash`() {
        assertThrows(IllegalArgumentException::class.java) { TxtRecord(mapOf("id" to "a", "ID" to "b")) }
    }

    @Test
    fun `the whole record stays within 1300 bytes`() {
        // Each entry: 1 length byte + "kN=" + 248 bytes = 252; 5 of them = 1260 fits, 6 = 1512 not.
        fun record(n: Int) = (1..n).associate { "k$it" to "v".repeat(248) }
        assertEquals(1260, TxtRecord(record(5)).wireBytes)
        assertThrows(IllegalArgumentException::class.java) { TxtRecord(record(6)) }
    }

    @Test
    fun `records with the same entries are equal`() {
        assertEquals(TxtRecord.forCamera(cameraId, "k"), TxtRecord.forCamera(cameraId, "k"))
        assertNotEquals(TxtRecord.forCamera(cameraId, "k"), TxtRecord.forCamera(cameraId, "other"))
    }

    @Test
    fun `instance name ends with the last 4 chars of the camera id`() {
        assertEquals("Kopernikadr Kamera (c5d1)", instanceName("Kopernikadr Kamera", cameraId))
        assertEquals("K (ab)", instanceName("K", "ab"))
    }

    @Test
    fun `instance name fits the 63-byte DNS label, keeping the suffix`() {
        val name = instanceName("ł".repeat(60), cameraId)
        assertTrue(name.endsWith(" (c5d1)"))
        assertTrue(name.toByteArray(Charsets.UTF_8).size <= 63)
        assertTrue(name.startsWith("ł"))
    }

    @Test
    fun `camera advertisement uses the service type, port and record`() {
        val ad = Advertisement.forCamera(cameraId, "Kopernikadr Kamera", 8765)
        assertEquals("_kopernikadr._tcp", ad.serviceType)
        assertEquals("Kopernikadr Kamera (c5d1)", ad.instanceName)
        assertEquals(8765, ad.port)
        assertEquals(TxtRecord.forCamera(cameraId, "Kopernikadr Kamera"), ad.txt)
    }

    @Test
    fun `advertisement rejects an unbound port`() {
        for (port in listOf(-1, 0, 65536)) {
            assertThrows("port $port", IllegalArgumentException::class.java) { Advertisement.forCamera(cameraId, "k", port) }
        }
    }
}
