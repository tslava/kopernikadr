package pl.slava.kopernikadr.camera.server

import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import java.nio.ByteBuffer
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.ProtocolJson

class PreviewSocketTest {

    // A fresh frame per send: the client masks the payload in place, so a Frame must not be reused.
    private val next get() = Frame.Text("""{"t":"next"}""")

    /** Parses `uint32 BE headerLength + JSON + JPEG`. */
    private fun parse(frame: Frame): Pair<JsonObject, ByteArray> {
        assertTrue("expected binary, got $frame", frame is Frame.Binary)
        val buf = ByteBuffer.wrap(frame.data)
        val len = buf.int
        val header = ByteArray(len).also { buf.get(it) }
        val jpeg = ByteArray(buf.remaining()).also { buf.get(it) }
        return ProtocolJson.parseToJsonElement(header.decodeToString()).jsonObject to jpeg
    }

    private suspend fun DefaultClientWebSocketSession.frame(): Frame = withTimeout(5_000) { incoming.receive() }

    @Test
    fun `preview with a bad session fails, a valid one is accepted`() = cameraTest { ws ->
        // the exact 409-before-upgrade is checked against the real engine in RealServerTest
        assertTrue(runCatching { ws.webSocket("/ws/preview?session=bogus") { error("upgraded") } }.isFailure)
        val control = ws.webSocketSession("/ws/control")
        val sid = control.hello("A").str("sessionId")
        ws.webSocket("/ws/preview?session=$sid") {
            assertNull(frameWithin(100))
        }
        control.close()
    }

    @Test
    fun `one next gives exactly one frame, the newest produced after the next`() {
        val cam = FakeCamera()
        cameraTest(cam) { ws ->
            val control = ws.webSocketSession("/ws/control")
            val hello = control.hello("A")
            ws.webSocket("/ws/preview?session=${hello.str("sessionId")}") {
                cam.preview.produce()
                cam.preview.produce() // seq 2, produced before the next
                send(next)
                cam.preview.awaitWaiter()
                val produced = cam.preview.produce(800, 600)
                val (header, jpeg) = parse(frame())
                assertEquals(produced.seq, header.long("seq"))
                assertEquals(3L, header.long("seq"))
                assertEquals(cam.identity.bootId, header.str("bootId"))
                assertEquals(800L, header.long("w"))
                assertEquals(600L, header.long("h"))
                assertEquals(produced.ts, header.long("ts"))
                assertEquals(3L, header.long("generation"))
                assertEquals("auto", header.getValue("locks").str("exposure"))
                assertTrue(produced.jpeg.contentEquals(jpeg))

                cam.preview.produce()
                assertNull("no frame without a next", frameWithin(300))

                send(next)
                cam.preview.awaitWaiter()
                cam.preview.produce()
                assertEquals(5L, parse(frame()).first.long("seq"))
            }
            control.close()
        }
    }

    @Test
    fun `duplicate nexts are coalesced`() {
        val cam = FakeCamera()
        cameraTest(cam) { ws ->
            val control = ws.webSocketSession("/ws/control")
            val sid = control.hello("A").str("sessionId")
            ws.webSocket("/ws/preview?session=$sid") {
                repeat(3) { send(next) }
                cam.preview.awaitWaiter()
                delay(100) // let the duplicates arrive while the first is pending
                cam.preview.produce()
                parse(frame())
                cam.preview.produce()
                assertNull("duplicates must not queue more frames", frameWithin(300))
                assertEquals(0, cam.preview.waiterCount())
            }
            control.close()
        }
    }

    @Test
    fun `pending next survives a stall and quality follows controls`() {
        val cam = FakeCamera()
        cameraTest(cam) { ws ->
            val control = ws.webSocketSession("/ws/control")
            val sid = control.hello("A").str("sessionId")
            cam.controls.push(cam.controls.get().copy(previewQuality = PreviewQuality.HIGH))
            ws.webSocket("/ws/preview?session=$sid") {
                send(next)
                cam.preview.awaitWaiter()
                delay(700) // camera rebinding: no frames
                assertNull(frameWithin(10))
                cam.preview.produce()
                assertEquals(1L, parse(frame()).first.long("seq"))
                assertEquals(PreviewQuality.HIGH, cam.preview.qualities.last())
            }
            control.close()
        }
    }
}
