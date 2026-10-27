package pl.slava.kopernikadr.camera.server

import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.Frame
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.Fixtures
import pl.slava.kopernikadr.camera.protocol.ProtocolJson
import pl.slava.kopernikadr.camera.protocol.Response
import pl.slava.kopernikadr.camera.protocol.Status
import pl.slava.kopernikadr.camera.protocol.assertJsonEquals

/**
 * The wire answers of the stage-1 ops against the fixtures in `protocol/fixtures`: the fixture
 * request goes through the real server (real envelope parsing, arg checks and encoding) with
 * ports that return the fixture's data, and the whole `res` must equal the fixture. The
 * `setControl.err` fixture is real server output without any port: the arg check rejects it.
 */
class FixtureServerTest {

    private class Recorder {
        var listArgs: Pair<Long?, Int>? = null
        var ackIds: List<String>? = null
        var setCalls = 0
    }

    private fun portsFor(rec: Recorder): CameraPorts {
        val base = FakeCamera()
        val controlsFx = data("setControl.res.json", Controls.serializer())
        val statusFx = data("getStatus.res.json", Status.serializer())
        val pageFx = data("listFrames.res.json", FramePage.serializer())
        val ackFx = data("ack.res.json", AckResult.serializer())
        val controls = object : ControlsPort {
            private val state = MutableStateFlow(controlsFx)
            override val updates: Flow<Controls> get() = state
            override fun get() = state.value
            override suspend fun set(change: ControlChange): PortResult<Controls> {
                rec.setCalls++
                assertEquals(ControlChange.Exposure(pl.slava.kopernikadr.camera.protocol.ControlMode.LOCKED), change)
                return PortResult.Ok(controlsFx)
            }
        }
        val frames = object : FrameStore {
            override fun listUnacked(clientId: String, afterSeq: Long?, limit: Int): FramePage {
                rec.listArgs = afterSeq to limit
                return pageFx
            }

            override fun ack(clientId: String, frameIds: List<String>): AckResult {
                rec.ackIds = frameIds
                return ackFx
            }

            override fun open(frameId: String, variant: FrameVariant): FrameFile? = null
        }
        return CameraPorts(base.identity, StatusPort { statusFx }, controls, base.capture, frames, base.preview)
    }

    private fun <T> data(name: String, ser: kotlinx.serialization.KSerializer<T>): T {
        val res = ProtocolJson.decodeFromString(Response.serializer(), Fixtures.text(name))
        return ProtocolJson.decodeFromJsonElement(ser, res.data!!)
    }

    private fun serverTest(rec: Recorder, block: suspend io.ktor.client.HttpClient.() -> Unit) {
        val ports = portsFor(rec)
        io.ktor.server.testing.testApplication {
            application { cameraModule(ports, ServerConfig(staticRoot = TEST_STATIC_ROOT)) }
            val ws = createClient { install(io.ktor.client.plugins.websocket.WebSockets) }
            ws.block()
        }
    }

    private suspend fun io.ktor.client.plugins.websocket.DefaultClientWebSocketSession.exchange(requestText: String, reqId: String): JsonObject {
        send(Frame.Text(requestText))
        return receiveRes(reqId)
    }

    private fun reqIdOf(name: String): String = Fixtures.json(name).str("reqId")

    @Test
    fun `setControl, listFrames, ack and getStatus answer exactly their fixtures`() {
        val rec = Recorder()
        serverTest(rec) {
            webSocket("/ws/control") {
                hello("c4e7a1d9-2f6b-4a83-b5e0-9d1c7f3a6b25")
                for (op in listOf("setControl", "listFrames", "ack", "getStatus")) {
                    val req = "$op.req.json"
                    val res = exchange(Fixtures.text(req), reqIdOf(req))
                    assertJsonEquals(Fixtures.json("$op.res.json"), res)
                }
            }
        }
        assertEquals(1, rec.setCalls)
        assertEquals(41L to 2, rec.listArgs)
        assertEquals(
            listOf("01K8GZ4V7Q3M9X2B5N6R8T1WCD", "01K8GZ4XC2Q6D8E1G3J5M7P9RS"),
            rec.ackIds,
        )
    }

    @Test
    fun `an unsupported setControl is answered exactly like setControl err`() {
        serverTest(Recorder()) {
            webSocket("/ws/control") {
                hello("c4e7a1d9-2f6b-4a83-b5e0-9d1c7f3a6b25")
                val id = reqIdOf("setControl.err.json")
                val bad = Fixtures.json("setControl.req.json") as JsonObject
                val text = ProtocolJson.encodeToString(
                    JsonObject.serializer(),
                    JsonObject(bad + ("args" to args("control" to "iso", "value" to 100))),
                )
                assertJsonEquals(Fixtures.json("setControl.err.json"), exchange(text, id))
            }
        }
    }
}
