package pl.slava.kopernikadr.camera.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AdvertisedServerTest {
    private val cameraId = "292efcc0-ff61-46da-9efd-78dfb1d2c5d1"
    private val events = mutableListOf<String>()
    private val logs = mutableListOf<String>()

    private class FakeAdvertiser(private val events: MutableList<String>) : ServiceAdvertiser {
        var failRegister = false
        var failUnregister = false
        override fun register(ad: Advertisement) {
            events += "register ${ad.port}"
            if (failRegister) throw IllegalStateException("nsd down")
        }

        override fun unregister() {
            events += "unregister"
            if (failUnregister) throw IllegalStateException("nsd down")
        }
    }

    private val advertiser = FakeAdvertiser(events)

    private fun server(port: Int = 8765, bind: () -> Int = { events += "bind"; port }) = AdvertisedServer(
        bind = bind,
        unbind = { events += "unbind" },
        advertiser = advertiser,
        advertisement = { p -> Advertisement.forCamera(cameraId, "Kopernikadr Kamera", p) },
        log = { logs += it },
    )

    @Test
    fun `registers after the server binds, with the bound port`() {
        val s = server(port = 8766)
        assertEquals(8766, s.start())
        assertEquals(listOf("bind", "register 8766"), events)
        assertEquals(8766, s.port)
    }

    @Test
    fun `unregisters before the server stops`() {
        val s = server()
        s.start()
        events.clear()
        s.stop()
        assertEquals(listOf("unregister", "unbind"), events)
        assertNull(s.port)
    }

    @Test
    fun `start and stop are idempotent`() {
        val s = server()
        s.start()
        s.start()
        s.stop()
        s.stop()
        assertEquals(listOf("bind", "register 8765", "unregister", "unbind"), events)
    }

    @Test
    fun `stop before start does nothing`() {
        server().stop()
        assertTrue(events.isEmpty())
    }

    @Test
    fun `a failed bind advertises nothing`() {
        val s = server(bind = { events += "bind"; throw java.io.IOException("port in use") })
        assertThrows(java.io.IOException::class.java) { s.start() }
        assertEquals(listOf("bind"), events)
        assertNull(s.port)
        s.stop()
        assertEquals(listOf("bind"), events)
    }

    @Test
    fun `a failed registration is logged and the server keeps running`() {
        advertiser.failRegister = true
        val s = server()
        assertEquals(8765, s.start())
        assertEquals(1, logs.size)
        assertTrue(logs.single(), logs.single().contains("nsd down"))
        s.stop()
        assertEquals(listOf("bind", "register 8765", "unregister", "unbind"), events)
    }

    @Test
    fun `a failed unregistration is logged and the server still stops`() {
        advertiser.failUnregister = true
        val s = server()
        s.start()
        s.stop()
        assertEquals(listOf("bind", "register 8765", "unregister", "unbind"), events)
        assertTrue(logs.single().contains("nsd down"))
    }

    @Test
    fun `a restart on another port re-registers with the new port`() {
        var next = 8765
        val s = server(bind = { events += "bind"; next++ })
        s.start()
        s.stop()
        s.start()
        assertEquals(listOf("bind", "register 8765", "unregister", "unbind", "bind", "register 8766"), events)
    }
}
