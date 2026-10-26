package pl.slava.kopernikadr.camera.server

import io.ktor.websocket.CloseReason
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.close
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import pl.slava.kopernikadr.camera.protocol.CloseCode

/** Shared server state: ports, sessions, and the sockets of each session (to close them together). */
internal class Hub(val ports: CameraPorts, val config: ServerConfig, val scope: CoroutineScope) {
    val sessions: SessionManager get() = config.sessions

    private val control = ConcurrentHashMap<String, WebSocketSession>()
    private val previews = ConcurrentHashMap<String, MutableSet<WebSocketSession>>()

    fun registerControl(sessionId: String, socket: WebSocketSession) {
        control[sessionId] = socket
    }

    fun unregisterControl(sessionId: String, socket: WebSocketSession) {
        control.remove(sessionId, socket)
    }

    fun registerPreview(sessionId: String, socket: WebSocketSession) {
        previews.computeIfAbsent(sessionId) { ConcurrentHashMap.newKeySet() }.add(socket)
    }

    fun unregisterPreview(sessionId: String, socket: WebSocketSession) {
        previews[sessionId]?.remove(socket)
        previews.computeIfPresent(sessionId) { _, set -> set.takeIf { it.isNotEmpty() } }
    }

    /** Closes the control and preview sockets of [sessionId] with [code]. */
    suspend fun closeSession(sessionId: String, code: CloseCode) {
        control.remove(sessionId)?.closeWith(code)
        previews.remove(sessionId)?.forEach { it.closeWith(code) }
    }
}

internal suspend fun WebSocketSession.closeWith(code: CloseCode) {
    runCatching { close(CloseReason(code.code, code.reason)) }
}
