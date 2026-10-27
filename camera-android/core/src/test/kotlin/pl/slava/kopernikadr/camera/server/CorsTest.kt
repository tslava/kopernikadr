package pl.slava.kopernikadr.camera.server

import java.net.Socket
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * CORS on `/info` and `/frames`, release default vs [ServerConfig.allowLocalhostAnyPort], against
 * the real CIO engine over raw sockets (the test host treats `http://localhost` as same-origin).
 */
class CorsTest {
    private val cam = FakeCamera()
    private lateinit var release: CameraServer
    private lateinit var dev: CameraServer
    private var releasePort = 0
    private var devPort = 0
    private lateinit var frameId: String

    @Before
    fun setUp() {
        frameId = cam.frames.add("A", "p", 0, fakeJpeg(100)).frameId
        release = CameraServer(cam.ports, ServerConfig(staticRoot = TEST_STATIC_ROOT), port = 0)
        releasePort = release.start()
        dev = CameraServer(cam.ports, ServerConfig(staticRoot = TEST_STATIC_ROOT, allowLocalhostAnyPort = true), port = 0)
        devPort = dev.start()
    }

    @After
    fun tearDown() {
        release.stop()
        dev.stop()
    }

    private val paths get() = listOf("/info", "/frames/$frameId/full.jpg")

    /** Status line and headers (lower-cased names) of `GET [path]` with [origin]. */
    private fun get(port: Int, path: String, origin: String): Pair<String, Map<String, List<String>>> =
        Socket("127.0.0.1", port).use { s ->
            s.soTimeout = 5_000
            s.getOutputStream().write(
                "GET $path HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nOrigin: $origin\r\nConnection: close\r\n\r\n".toByteArray(),
            )
            val inp = s.getInputStream()
            val sb = StringBuilder()
            while (!sb.endsWith("\r\n\r\n")) {
                val b = inp.read()
                if (b < 0) break
                sb.append(b.toChar())
            }
            val lines = sb.toString().trimEnd().lines()
            val headers = lines.drop(1).map { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }
                .groupBy({ it.first }, { it.second })
            lines.first() to headers
        }

    private fun assertAllowed(port: Int, origin: String) {
        for (path in paths) {
            val (status, h) = get(port, path, origin)
            assertTrue("$path $origin: $status", status.contains(" 200 "))
            assertEquals("$path $origin", listOf(origin), h["access-control-allow-origin"])
            assertTrue("$path $origin: ${h["vary"]}", h["vary"].orEmpty().any { it.contains("Origin", ignoreCase = true) })
        }
    }

    private fun assertRejected(port: Int, origin: String) {
        for (path in paths) {
            val (status, h) = get(port, path, origin)
            assertNull("$path $origin: $status $h", h["access-control-allow-origin"])
            assertFalse("$path $origin: $status", status.contains(" 200 "))
        }
    }

    @Test
    fun `exact http localhost is allowed in both modes`() {
        assertAllowed(releasePort, "http://localhost")
        assertAllowed(devPort, "http://localhost")
    }

    @Test
    fun `release default rejects localhost with a port`() {
        assertRejected(releasePort, "http://localhost:3000")
        assertRejected(releasePort, "http://127.0.0.1:5173")
    }

    @Test
    fun `allowLocalhostAnyPort allows localhost and 127_0_0_1 with any port`() {
        assertAllowed(devPort, "http://localhost:3000")
        assertAllowed(devPort, "http://127.0.0.1:5173")
        assertAllowed(devPort, "http://localhost:65535")
    }

    @Test
    fun `allowLocalhostAnyPort still rejects other origins`() {
        for (origin in listOf(
            "http://localhost.evil.com",
            "http://localhost:0",
            "http://localhost:99999",
            "https://localhost:3000",
            "http://evil.com",
        )) {
            assertRejected(devPort, origin)
            assertRejected(releasePort, origin)
        }
    }

    @Test
    fun `isLocalhostAnyPortOrigin parses strictly`() {
        for (ok in listOf("http://localhost", "http://localhost:1", "http://localhost:3000", "http://localhost:65535",
            "http://127.0.0.1", "http://127.0.0.1:5173")) {
            assertTrue(ok, isLocalhostAnyPortOrigin(ok))
        }
        for (bad in listOf(
            "http://localhost.evil.com", "http://localhost.evil.com:3000", "http://evil.com", "http://evillocalhost:3000",
            "http://localhost:0", "http://localhost:03000", "http://localhost:65536", "http://localhost:99999",
            "http://localhost:", "http://localhost:3000/", "http://localhost:3000/path", "http://user@localhost:3000",
            "https://localhost:3000", "HTTP://localhost:3000", "http://LOCALHOST:3000", "ws://localhost:3000",
            "capacitor://localhost", "http://127.0.0.2:3000", "http://[::1]:3000", "null", "",
        )) {
            assertFalse(bad, isLocalhostAnyPortOrigin(bad))
        }
    }
}
