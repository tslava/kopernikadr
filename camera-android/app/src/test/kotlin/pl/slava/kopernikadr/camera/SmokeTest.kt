package pl.slava.kopernikadr.camera

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SmokeTest {
    @Test
    fun `picks the first non-loopback IPv4 address`() {
        val addrs = listOf("fe80::1", "127.0.0.1", "192.168.1.23", "10.0.0.2").map(InetAddress::getByName)
        assertEquals("192.168.1.23", firstIpv4(addrs))
    }

    @Test
    fun `no IPv4 address gives null`() {
        assertNull(firstIpv4(listOf(InetAddress.getByName("fe80::1"))))
        assertNull(firstIpv4(emptyList()))
    }
}
