package pl.slava.kopernikadr.camera.server

import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import java.util.UUID
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import pl.slava.kopernikadr.camera.protocol.ProtocolJson
import pl.slava.kopernikadr.camera.protocol.encodeRequest

const val TEST_STATIC_ROOT = "remote-lite-test"

/** A server on the Ktor test engine over [cam]; `ws` is a client with WebSockets installed. */
fun cameraTest(
    cam: FakeCamera = FakeCamera(),
    config: ServerConfig = ServerConfig(staticRoot = TEST_STATIC_ROOT),
    block: suspend ApplicationTestBuilder.(ws: HttpClient) -> Unit,
) = testApplication {
    application { cameraModule(cam.ports, config) }
    val ws = createClient { install(WebSockets) }
    block(ws)
}

fun reqId(): String = UUID.randomUUID().toString()

val JsonElement.obj: JsonObject get() = jsonObject
fun JsonElement.str(key: String): String = jsonObject.getValue(key).jsonPrimitive.content
fun JsonElement.long(key: String): Long = jsonObject.getValue(key).jsonPrimitive.content.toLong()
fun JsonElement.bool(key: String): Boolean = jsonObject.getValue(key).jsonPrimitive.content.toBooleanStrict()

suspend fun DefaultClientWebSocketSession.receiveJson(timeoutMs: Long = 5_000): JsonObject = withTimeout(timeoutMs) {
    while (true) {
        val f = incoming.receive()
        if (f is Frame.Text) return@withTimeout ProtocolJson.parseToJsonElement(f.readText()).jsonObject
    }
    @Suppress("UNREACHABLE_CODE") error("unreachable")
}

/** Next `res` for [reqId], skipping events. */
suspend fun DefaultClientWebSocketSession.receiveRes(reqId: String): JsonObject {
    while (true) {
        val m = receiveJson()
        if (m.str("t") == "res" && m.str("reqId") == reqId) return m
    }
}

suspend fun DefaultClientWebSocketSession.sendReq(op: String, args: JsonElement = JsonObject(emptyMap()), id: String = reqId()): String {
    send(Frame.Text(encodeRequest(id, op, args)))
    return id
}

suspend fun DefaultClientWebSocketSession.call(op: String, args: JsonElement = JsonObject(emptyMap())): JsonObject =
    receiveRes(sendReq(op, args))

fun helloArgs(clientId: String, min: Int = 1, max: Int = 1) = buildJsonObject {
    put("clientId", clientId)
    putJsonObject("protocolVersions") {
        put("min", min)
        put("max", max)
    }
    put("appVersion", "test")
    put("platform", "test")
}

/** Sends hello, asserts ok, returns `data`. */
suspend fun DefaultClientWebSocketSession.hello(clientId: String): JsonObject {
    val res = call("hello", helloArgs(clientId))
    check(res.bool("ok")) { "hello failed: $res" }
    return res.getValue("data").jsonObject
}

/** Drains the socket until the server closes it; returns the close code. */
suspend fun DefaultClientWebSocketSession.awaitCloseCode(timeoutMs: Long = 5_000): Short? = withTimeout(timeoutMs) {
    for (f in incoming) Unit
    closeReason.await()?.code
}

/** Next frame within [ms], or null. */
suspend fun DefaultClientWebSocketSession.frameWithin(ms: Long): Frame? = withTimeoutOrNull(ms) { incoming.receive() }

fun args(vararg pairs: Pair<String, Any>): JsonObject = buildJsonObject {
    for ((k, v) in pairs) when (v) {
        is String -> put(k, v)
        is Number -> put(k, v)
        is Boolean -> put(k, v)
        is JsonElement -> put(k, v)
        else -> error("unsupported $v")
    }
}

fun jsonString(s: String) = JsonPrimitive(s)
