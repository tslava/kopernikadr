package pl.slava.kopernikadr.camera.server

import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.io.OutputStream
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import pl.slava.kopernikadr.camera.protocol.encodeRequest

/**
 * Incoming WebSocket size limit against the real CIO engine, with hand-made frames (the Ktor
 * client cannot send continuation frames or lie about lengths).
 */
class WsLimitsTest {
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

    private class Frame(val opcode: Int, val payload: ByteArray) {
        val text get() = payload.decodeToString()
        val closeCode get() = if (payload.size >= 2) ((payload[0].toInt() and 0xFF) shl 8) or (payload[1].toInt() and 0xFF) else -1
    }

    private inner class RawWs(path: String) : AutoCloseable {
        private val socket = Socket("127.0.0.1", port).apply { soTimeout = 5_000 }
        private val out: OutputStream = socket.getOutputStream()
        private val inp = DataInputStream(socket.getInputStream())

        init {
            out.write(
                ("GET $path HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").toByteArray(),
            )
            val head = StringBuilder()
            while (!head.endsWith("\r\n\r\n")) head.append(inp.readUnsignedByte().toChar())
            check(head.startsWith("HTTP/1.1 101")) { "no upgrade: $head" }
        }

        /** One client frame (masked with a zero key, which leaves the payload as is). */
        fun send(opcode: Int, payload: ByteArray, fin: Boolean = true) {
            val b = java.io.ByteArrayOutputStream()
            b.write((if (fin) 0x80 else 0) or opcode)
            when {
                payload.size < 126 -> b.write(0x80 or payload.size)
                payload.size < 65_536 -> {
                    b.write(0x80 or 126)
                    b.write(ByteBuffer.allocate(2).putShort(payload.size.toShort()).array())
                }
                else -> {
                    b.write(0x80 or 127)
                    b.write(ByteBuffer.allocate(8).putLong(payload.size.toLong()).array())
                }
            }
            b.write(ByteArray(4))
            b.write(payload)
            try {
                out.write(b.toByteArray())
                out.flush()
            } catch (e: IOException) {
                // the server may already have closed after reading the header
            }
        }

        fun sendText(text: String) = send(0x1, text.toByteArray())

        /** Next server frame, or null on EOF / reset / timeout. */
        fun receive(): Frame? = try {
            val b0 = inp.readUnsignedByte()
            val b1 = inp.readUnsignedByte()
            val len = when (val l = b1 and 0x7F) {
                126 -> inp.readUnsignedShort().toLong()
                127 -> inp.readLong()
                else -> l.toLong()
            }
            val payload = ByteArray(len.toInt()).also { inp.readFully(it) }
            Frame(b0 and 0x0F, payload)
        } catch (e: EOFException) {
            null
        } catch (e: SocketTimeoutException) {
            null
        } catch (e: IOException) {
            null
        }

        /** Frames until the server's close frame; returns (data frames, close code or null). */
        fun untilClose(): Pair<List<Frame>, Int?> {
            val data = mutableListOf<Frame>()
            while (true) {
                val f = receive() ?: return data to null
                if (f.opcode == 0x8) return data to f.closeCode
                data += f
            }
        }

        override fun close() = socket.close()
    }

    private fun junkJson(bytes: Int) = "{\"x\":\"" + "a".repeat(bytes - 8) + "\"}"

    private fun helloText(clientId: String) = encodeRequest(reqId(), "hello", helloArgs(clientId))

    private fun assertServerStillServes() {
        val info = Socket("127.0.0.1", port).use { s ->
            s.soTimeout = 5_000
            s.getOutputStream().write("GET /info HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".toByteArray())
            s.getInputStream().readBytes().decodeToString()
        }
        assertTrue(info, info.startsWith("HTTP/1.1 200"))
        RawWs("/ws/control").use { ws ->
            ws.sendText(helloText("A"))
            val res = ws.receive()!!
            assertTrue(res.text, res.text.contains("\"ok\":true"))
        }
    }

    @Test
    fun `oversized first control message is closed 1009 before it is parsed`() {
        RawWs("/ws/control").use { ws ->
            ws.send(0x1, junkJson(100_000).toByteArray())
            val (data, code) = ws.untilClose()
            assertEquals(1009, code)
            // parsed, it would have been answered "hello expected" and closed 4000
            assertTrue(data.joinToString { it.text }, data.isEmpty())
        }
        assertServerStillServes()
    }

    @Test
    fun `fragmented control message over the limit in total is closed 1009`() {
        RawWs("/ws/control").use { ws ->
            val part = ByteArray(30_000) { 'a'.code.toByte() }
            ws.send(0x1, part, fin = false)
            ws.send(0x0, part, fin = false)
            ws.send(0x0, part, fin = true)
            val (data, code) = ws.untilClose()
            assertEquals(1009, code)
            assertTrue(data.isEmpty())
        }
        assertServerStillServes()
    }

    @Test
    fun `a message under the limit still reaches the protocol`() {
        RawWs("/ws/control").use { ws ->
            ws.send(0x1, junkJson(60_000).toByteArray())
            val (data, code) = ws.untilClose()
            assertEquals(4000, code) // "hello expected"
            assertTrue(data.single().text.contains("INVALID_ARGS"))
        }
    }

    @Test
    fun `oversized first preview message is closed 1009, large outgoing frames are not limited`() {
        val granted = config.sessions.hello("A") as SessionManager.HelloResult.Granted
        val sid = granted.session.sessionId
        RawWs("/ws/preview?session=$sid").use { ws ->
            ws.send(0x1, junkJson(100_000).toByteArray())
            val (data, code) = ws.untilClose()
            assertEquals(1009, code)
            assertTrue(data.isEmpty())
        }
        config.sessions.touch(sid)
        RawWs("/ws/preview?session=$sid").use { ws ->
            ws.sendText("""{"t":"next"}""")
            Thread.sleep(200)
            cam.preview.produce(jpegBytes = 300_000)
            val f = ws.receive()!!
            assertEquals(0x2, f.opcode)
            assertTrue(f.payload.size > 300_000)
        }
        assertServerStillServes()
    }
}
