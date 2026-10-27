package pl.slava.kopernikadr.remote.nsd

import org.junit.Assert.assertEquals
import org.junit.Test

class NsdTextTest {
    @Test
    fun `TXT values are decoded as UTF-8, a key without a value is empty`() {
        val txt = decodeTxt(mapOf("id" to "cam-1".toByteArray(), "name" to "Kamera Łódź".toByteArray(Charsets.UTF_8), "flag" to null))
        assertEquals(mapOf("id" to "cam-1", "name" to "Kamera Łódź", "flag" to ""), txt)
    }

    @Test
    fun `IPv4 addresses come first, order otherwise kept, blanks and duplicates dropped`() {
        assertEquals(
            listOf("192.168.1.20", "10.0.0.1", "fe80::1%wlan0", "2001:db8::1"),
            orderAddresses(listOf("fe80::1%wlan0", "192.168.1.20", "", "2001:db8::1", "10.0.0.1", "192.168.1.20")),
        )
        assertEquals(emptyList<String>(), orderAddresses(emptyList()))
        assertEquals(listOf("::ffff:10.0.0.1"), orderAddresses(listOf("::ffff:10.0.0.1")))
    }

    @Test
    fun `service type matches PROTOCOL 3`() {
        assertEquals("_kopernikadr._tcp", SERVICE_TYPE)
    }
}
