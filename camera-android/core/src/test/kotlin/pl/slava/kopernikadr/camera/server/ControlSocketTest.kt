package pl.slava.kopernikadr.camera.server

import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.protocol.PreviewQuality

class ControlSocketTest {

    private class FakeClock(var now: Long = 1_000_000_000L) : MonotonicClock {
        override fun nanos(): Long = now
    }

    private fun captureArgs(rotation: Int = 0) = args("projectId" to "p1", "rotation" to rotation)

    @Test
    fun `hello grants a session with full data`() {
        val cam = FakeCamera()
        cameraTest(cam) { ws ->
            ws.webSocket("/ws/control") {
                val data = hello("A")
                assertEquals(cam.identity.cameraId, data.str("cameraId"))
                assertEquals(cam.identity.bootId, data.str("bootId"))
                assertEquals(1L, data.long("protocolVersion"))
                assertEquals(10_000L, data.long("sessionTtlMs"))
                assertTrue(data.str("sessionId").isNotBlank())
                assertEquals("4:3", data.getValue("capabilities").str("aspect"))
                assertEquals(3L, data.getValue("controls").long("generation"))
                assertEquals(81L, data.getValue("status").long("batteryPct"))
                val pong = call("ping")
                assertTrue(pong.bool("ok"))
                assertTrue(pong.getValue("data").long("serverTimeMs") > 0)
            }
        }
    }

    @Test
    fun `first message other than hello gets hello expected and 4000`() = cameraTest { ws ->
        ws.webSocket("/ws/control") {
            val id = sendReq("ping")
            val res = receiveRes(id)
            assertFalse(res.bool("ok"))
            assertEquals("INVALID_ARGS", res.getValue("error").str("code"))
            assertEquals("hello expected", res.getValue("error").str("message"))
            assertEquals(4000.toShort(), awaitCloseCode())
        }
    }

    @Test
    fun `malformed first message closes with 4000`() = cameraTest { ws ->
        ws.webSocket("/ws/control") {
            send(Frame.Text("not json"))
            val res = receiveJson()
            assertEquals("INVALID_ARGS", res.getValue("error").str("code"))
            assertEquals(4000.toShort(), awaitCloseCode())
        }
    }

    @Test
    fun `no common version gives UNSUPPORTED_VERSION`() = cameraTest { ws ->
        ws.webSocket("/ws/control") {
            val res = call("hello", helloArgs("A", 2, 3))
            assertFalse(res.bool("ok"))
            assertEquals("UNSUPPORTED_VERSION", res.getValue("error").str("code"))
            assertTrue(awaitCloseCode() != null)
        }
    }

    @Test
    fun `another client gets BUSY with retryAfterMs and 4003`() = cameraTest { ws ->
        val a = ws.webSocketSession("/ws/control")
        a.hello("A")
        ws.webSocket("/ws/control") {
            val res = call("hello", helloArgs("B"))
            assertFalse(res.bool("ok"))
            val err = res.getValue("error")
            assertEquals("BUSY", err.str("code"))
            assertTrue(err.long("retryAfterMs") in 1..10_000)
            assertEquals(4003.toShort(), awaitCloseCode())
        }
        assertTrue(a.call("ping").bool("ok"))
        a.close()
    }

    @Test
    fun `same client replaces the session and old control and preview sockets get 4001`() = cameraTest { ws ->
        val old = ws.webSocketSession("/ws/control")
        val oldSession = old.hello("A").str("sessionId")
        val oldPreview = ws.webSocketSession("/ws/preview?session=$oldSession")
        val fresh = ws.webSocketSession("/ws/control")
        val newSession = fresh.hello("A").str("sessionId")
        assertNotEquals(oldSession, newSession)
        assertEquals(4001.toShort(), old.awaitCloseCode())
        assertEquals(4001.toShort(), oldPreview.awaitCloseCode())
        assertTrue(fresh.call("ping").bool("ok"))
        fresh.close()
    }

    @Test
    fun `request on a lapsed session gets LEASE_LOST and 4002, preview too`() {
        val clock = FakeClock()
        val config = ServerConfig(sessions = SessionManager(clock), staticRoot = TEST_STATIC_ROOT)
        cameraTest(config = config) { ws ->
            ws.webSocket("/ws/control") {
                val sid = hello("A").str("sessionId")
                val preview = ws.webSocketSession("/ws/preview?session=$sid")
                clock.now += 10_000_000_000L
                val res = call("ping")
                assertFalse(res.bool("ok"))
                assertEquals("LEASE_LOST", res.getValue("error").str("code"))
                assertEquals(4002.toShort(), awaitCloseCode())
                assertEquals(4002.toShort(), preview.awaitCloseCode())
            }
        }
    }

    @Test
    fun `ping is answered while a slow capture runs`() {
        val cam = FakeCamera()
        val gate = CompletableDeferred<Unit>()
        cam.capture.gate = gate
        cameraTest(cam) { ws ->
            ws.webSocket("/ws/control") {
                hello("A")
                val capId = sendReq("capture", captureArgs())
                withTimeout(5_000) { cam.capture.started.receive() }
                assertTrue(call("ping").bool("ok"))
                gate.complete(Unit)
                val res = receiveRes(capId)
                assertTrue(res.bool("ok"))
                assertEquals("p1", res.getValue("data").str("projectId"))
                assertEquals("A", res.getValue("data").str("clientId"))
            }
        }
    }

    @Test
    fun `duplicate in-flight reqId on the same socket gets CAPTURE_IN_PROGRESS, one res for the original`() {
        val cam = FakeCamera()
        val gate = CompletableDeferred<Unit>()
        cam.capture.gate = gate
        cameraTest(cam) { ws ->
            ws.webSocket("/ws/control") {
                hello("A")
                val id = sendReq("capture", captureArgs())
                withTimeout(5_000) { cam.capture.started.receive() }
                sendReq("capture", captureArgs(), id)
                val dup = receiveRes(id)
                assertFalse(dup.bool("ok"))
                assertEquals("CAPTURE_IN_PROGRESS", dup.getValue("error").str("code"))
                gate.complete(Unit)
                val res = receiveRes(id)
                assertTrue(res.bool("ok"))
                // replay after commit returns the stored result
                val replay = receiveRes(sendReq("capture", captureArgs(), id))
                assertEquals(res.getValue("data"), replay.getValue("data"))
                // getOperation
                val op = call("getOperation", args("reqId" to id))
                assertEquals("done", op.getValue("data").str("state"))
                assertEquals("unknown", call("getOperation", args("reqId" to reqId())).getValue("data").str("state"))
            }
        }
    }

    @Test
    fun `capture with bad args gets INVALID_ARGS`() = cameraTest { ws ->
        ws.webSocket("/ws/control") {
            hello("A")
            val res = call("capture", args("projectId" to "p"))
            assertEquals("INVALID_ARGS", res.getValue("error").str("code"))
        }
    }

    @Test
    fun `listFrames pages the caller's unacked frames`() {
        val cam = FakeCamera()
        repeat(5) { cam.frames.add("A", "p", 0) }
        cam.frames.add("B", "p", 0)
        cameraTest(cam) { ws ->
            ws.webSocket("/ws/control") {
                hello("A")
                val p1 = call("listFrames", args("limit" to 2)).getValue("data")
                val f1 = p1.obj.getValue("frames").jsonArray
                assertEquals(2, f1.size)
                assertTrue(p1.bool("hasMore"))
                val last = f1.last().long("seq")
                val p2 = call("listFrames", args("afterSeq" to last, "limit" to 10)).getValue("data")
                assertEquals(3, p2.obj.getValue("frames").jsonArray.size)
                assertFalse(p2.bool("hasMore"))
                assertTrue(p2.obj.getValue("frames").jsonArray.all { it.str("clientId") == "A" })
                val all = call("listFrames").getValue("data").obj.getValue("frames").jsonArray
                assertEquals(5, all.size)
                assertEquals(all.map { it.long("seq") }.sorted(), all.map { it.long("seq") })
                assertEquals("INVALID_ARGS", call("listFrames", args("limit" to 501)).getValue("error").str("code"))
                assertEquals("INVALID_ARGS", call("listFrames", args("limit" to "x")).getValue("error").str("code"))
            }
        }
    }

    @Test
    fun `ack acks own frames and reports others as unknown`() {
        val cam = FakeCamera()
        val a1 = cam.frames.add("A", "p", 0)
        val a2 = cam.frames.add("A", "p", 0)
        val a3 = cam.frames.add("A", "p", 0)
        val b1 = cam.frames.add("B", "p", 0)
        cameraTest(cam) { ws ->
            ws.webSocket("/ws/control") {
                hello("A")
                val ids = JsonArray(listOf(a1.frameId, a2.frameId, b1.frameId, "bogus").map { JsonPrimitive(it) })
                val data = call("ack", buildJsonObject { put("frameIds", ids) }).getValue("data")
                assertEquals(2L, data.long("acked"))
                assertEquals(listOf(b1.frameId, "bogus"), data.obj.getValue("unknown").jsonArray.map { it.jsonPrimitive().content })
                val left = call("listFrames").getValue("data").obj.getValue("frames").jsonArray
                assertEquals(listOf(a3.frameId), left.map { it.str("frameId") })
                val empty = call("ack", buildJsonObject { put("frameIds", JsonArray(emptyList())) })
                assertEquals("INVALID_ARGS", empty.getValue("error").str("code"))
                assertEquals("INVALID_ARGS", call("ack").getValue("error").str("code"))
            }
        }
    }

    @Test
    fun `getControls, setControl and the controls event`() {
        val cam = FakeCamera()
        cameraTest(cam) { ws ->
            ws.webSocket("/ws/control") {
                hello("A")
                assertEquals(3L, call("getControls").getValue("data").long("generation"))
                val id = sendReq("setControl", args("control" to "rotation", "degrees" to 180))
                var res: kotlinx.serialization.json.JsonObject? = null
                var evt: kotlinx.serialization.json.JsonObject? = null
                while (res == null || evt == null) {
                    val m = receiveJson()
                    when {
                        m.str("t") == "res" && m.str("reqId") == id -> res = m
                        m.str("t") == "evt" && m.str("name") == "controls" -> evt = m
                    }
                }
                assertEquals(180L, res.getValue("data").long("rotation"))
                assertEquals(4L, res.getValue("data").long("generation"))
                assertEquals(180L, evt.getValue("data").long("rotation"))

                val q = call("setControl", args("control" to "previewQuality", "value" to "high"))
                assertEquals("high", q.getValue("data").str("previewQuality"))
                assertEquals(PreviewQuality.HIGH, cam.controls.get().previewQuality)

                assertEquals("UNSUPPORTED_CONTROL", call("setControl", args("control" to "iso", "value" to 100)).getValue("error").str("code"))
                assertEquals("INVALID_VALUE", call("setControl", args("control" to "exposure", "mode" to "failed")).getValue("error").str("code"))
                assertEquals("INVALID_VALUE", call("setControl", args("control" to "focus", "mode" to "fixed")).getValue("error").str("code"))
                assertEquals("INVALID_ARGS", call("setControl", args("control" to "rotation", "degrees" to "180")).getValue("error").str("code"))
                assertEquals("INVALID_VALUE", call("setControl", args("control" to "rotation", "degrees" to 90)).getValue("error").str("code"))
                assertTrue(call("setControl", args("control" to "exposureCompensation", "steps" to -2)).bool("ok"))
                assertTrue(call("setControl", args("control" to "whiteBalance", "mode" to "locked")).bool("ok"))
                assertTrue(call("setControl", args("control" to "focus", "mode" to "locked")).bool("ok"))
                assertTrue(call("setControl", args("control" to "exposure", "mode" to "locked")).bool("ok"))
            }
        }
    }

    @Test
    fun `getStatus, unknown op and periodic status event`() {
        val config = ServerConfig(statusIntervalMs = 100, staticRoot = TEST_STATIC_ROOT)
        cameraTest(config = config) { ws ->
            ws.webSocket("/ws/control") {
                hello("A")
                assertEquals(81L, call("getStatus").getValue("data").long("batteryPct"))
                assertEquals("UNKNOWN_OP", call("clearAcked").getValue("error").str("code"))
                withTimeout(3_000) {
                    while (true) {
                        val m = receiveJson()
                        if (m.str("t") == "evt" && m.str("name") == "status") break
                    }
                }
            }
        }
    }

    @Test
    fun `request with a missing reqId gets INVALID_ARGS and the socket stays open`() = cameraTest { ws ->
        ws.webSocket("/ws/control") {
            hello("A")
            send(Frame.Text("""{"v":1,"t":"req","op":"ping"}"""))
            val m = receiveJson()
            assertEquals("INVALID_ARGS", m.getValue("error").str("code"))
            assertTrue(call("ping").bool("ok"))
        }
    }

    private fun kotlinx.serialization.json.JsonElement.jsonPrimitive() = this as JsonPrimitive
}
