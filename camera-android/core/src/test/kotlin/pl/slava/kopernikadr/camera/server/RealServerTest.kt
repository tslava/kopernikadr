package pl.slava.kopernikadr.camera.server

import java.net.ServerSocket
import java.net.Socket
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Against the real CIO engine over raw sockets (the test host is always same-origin and hides handshakes). */
class RealServerTest {
    private val cam = FakeCamera()
    private val config = ServerConfig(staticRoot = TEST_STATIC_ROOT)
    private lateinit var server: CameraServer
    private var port = 0

    @Before
    fun setUp() {
        server = CameraServer(cam.ports, config, port = 0)
        port = server.start()
    }

    @After
    fun tearDown() = server.stop()

    /** Sends [head] (request line + headers, no blank line) and returns the response head. */
    private fun raw(head: String, p: Int = port): String = Socket("127.0.0.1", p).use { s ->
        s.soTimeout = 5_000
        s.getOutputStream().write("$head\r\nHost: 127.0.0.1:$p\r\n\r\n".toByteArray())
        val inp = s.getInputStream()
        val sb = StringBuilder()
        while (!sb.endsWith("\r\n\r\n")) {
            val b = inp.read()
            if (b < 0) break
            sb.append(b.toChar())
        }
        sb.toString()
    }

    private fun upgrade(path: String) = raw(
        "GET $path HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13",
    )

    private fun String.statusLine() = lineSequence().first()

    @Test
    fun `info and frames answer CORS for http localhost`() {
        val f = cam.frames.add("A", "p", 0, fakeJpeg(100))
        for (path in listOf("/info", "/frames/${f.frameId}/full.jpg")) {
            val res = raw("GET $path HTTP/1.1\r\nOrigin: http://localhost\r\nConnection: close")
            assertTrue(res, res.statusLine().contains(" 200 "))
            assertTrue(res, res.contains("Access-Control-Allow-Origin: http://localhost", ignoreCase = true))
        }
        val plain = raw("GET /info HTTP/1.1\r\nConnection: close")
        assertTrue(plain, plain.statusLine().contains(" 200 "))
    }

    @Test
    fun `HEAD answers with the GET status and headers and no body`() {
        val f = cam.frames.add("A", "p", 0, fakeJpeg(1000))
        for ((path, length) in listOf("/frames/${f.frameId}/full.jpg" to "1000", "/info" to null, "/" to null)) {
            val whole = Socket("127.0.0.1", port).use { s ->
                s.soTimeout = 5_000
                s.getOutputStream().write("HEAD $path HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nConnection: close\r\n\r\n".toByteArray())
                s.getInputStream().readBytes().decodeToString()
            }
            assertTrue(whole, whole.statusLine().contains(" 200 "))
            assertTrue(whole, whole.endsWith("\r\n\r\n")) // no body
            val get = raw("GET $path HTTP/1.1\r\nConnection: close")
            val len = Regex("(?im)^Content-Length: (\\d+)").find(whole)?.groupValues?.get(1)
            assertEquals(whole, Regex("(?im)^Content-Length: (\\d+)").find(get)?.groupValues?.get(1), len)
            if (length != null) assertEquals(length, len)
        }
        assertTrue(raw("HEAD /frames/${f.frameId}/huge.jpg HTTP/1.1\r\nConnection: close").statusLine().contains(" 404 "))
    }

    @Test
    fun `preview upgrade is refused with 409 before the upgrade unless the session is current`() {
        assertTrue(upgrade("/ws/preview?session=bogus").statusLine().contains(" 409 "))
        assertTrue(upgrade("/ws/preview").statusLine().contains(" 409 "))
        val granted = config.sessions.hello("A") as SessionManager.HelloResult.Granted
        val ok = upgrade("/ws/preview?session=${granted.session.sessionId}")
        assertTrue(ok, ok.statusLine().contains(" 101 "))
    }

    @Test
    fun `control upgrade without Origin is accepted`() {
        assertTrue(upgrade("/ws/control").statusLine().contains(" 101 "))
    }

    @Test
    fun `static root is served`() {
        val res = raw("GET / HTTP/1.1\r\nConnection: close")
        assertTrue(res, res.statusLine().contains(" 200 "))
        assertTrue(res, res.contains("Content-Type: text/html", ignoreCase = true))
    }

    @Test
    fun `falls back to an ephemeral port when the requested one is busy`() {
        ServerSocket(0).use { busy ->
            val other = CameraServer(cam.ports, config, port = busy.localPort)
            try {
                val p = other.start()
                assertNotEquals(busy.localPort, p)
                assertEquals(p, other.boundPort)
                assertTrue(raw("GET /info HTTP/1.1\r\nConnection: close", p).statusLine().contains(" 200 "))
            } finally {
                other.stop()
            }
            assertEquals(-1, other.boundPort)
        }
    }

    @Test
    fun `uses the requested port when free and can restart`() {
        val free = ServerSocket(0).use { it.localPort }
        val other = CameraServer(cam.ports, config, port = free)
        try {
            assertEquals(free, other.start())
            other.stop()
            assertEquals(free, other.start())
        } finally {
            other.stop()
        }
    }
}
