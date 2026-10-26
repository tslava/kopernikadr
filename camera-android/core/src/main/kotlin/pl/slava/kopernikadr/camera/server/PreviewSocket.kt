package pl.slava.kopernikadr.camera.server

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.createRouteScopedPlugin
import io.ktor.server.response.respond
import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import pl.slava.kopernikadr.camera.protocol.CloseCode
import pl.slava.kopernikadr.camera.protocol.PreviewHeader
import pl.slava.kopernikadr.camera.protocol.PreviewNext
import pl.slava.kopernikadr.camera.protocol.ProtocolJson
import pl.slava.kopernikadr.camera.protocol.encodePreviewFrame

internal class PreviewGateConfig {
    lateinit var sessions: SessionManager
}

/** §3: `/ws/preview` answers HTTP 409 **before** the upgrade unless `?session=` is the live session. */
internal val PreviewGate = createRouteScopedPlugin("PreviewGate", ::PreviewGateConfig) {
    val sessions = pluginConfig.sessions
    onCall { call ->
        val sid = call.request.queryParameters["session"]
        if (sid == null || sessions.validate(sid) != SessionManager.Validation.Ok) {
            call.respond(HttpStatusCode.Conflict, "no such session")
        }
    }
}

/**
 * The §7 pull loop. Each `{"t":"next"}` gets exactly one binary frame: the newest produced after
 * the `next` arrived. A `next` that arrives while one is pending is dropped (coalesced). A pending
 * `next` simply waits through a [PreviewSource] stall. A `next` on a lapsed session closes 4002.
 */
internal suspend fun DefaultWebSocketServerSession.previewSocket(hub: Hub, sid: String) {
    hub.registerPreview(sid, this)
    val pending = AtomicBoolean(false)
    val requests = Channel<Long>(Channel.CONFLATED) // afterSeq of the pending next
    val pump = launch {
        for (afterSeq in requests) {
            val f = hub.ports.preview.nextFrame(hub.ports.controls.get().previewQuality, afterSeq)
            val header = PreviewHeader(f.seq, hub.ports.identity.bootId, f.generation, f.w, f.h, f.ts, f.locks)
            val bytes = encodePreviewFrame(header, f.jpeg)
            pending.set(false)
            runCatching { outgoing.send(Frame.Binary(true, bytes)) }
        }
    }
    try {
        for (frame in incoming) {
            if (frame !is Frame.Text || !isNext(frame.readText())) continue
            if (hub.sessions.validate(sid) != SessionManager.Validation.Ok) {
                closeWith(CloseCode.LEASE_LOST)
                return
            }
            if (pending.compareAndSet(false, true)) requests.trySend(hub.ports.preview.currentSeq())
        }
    } finally {
        pump.cancel()
        hub.unregisterPreview(sid, this)
    }
}

private fun isNext(text: String): Boolean = runCatching {
    val t = (ProtocolJson.parseToJsonElement(text) as? JsonObject)?.get("t") as? JsonPrimitive
    t?.isString == true && t.content == PreviewNext.NEXT
}.getOrDefault(false)
