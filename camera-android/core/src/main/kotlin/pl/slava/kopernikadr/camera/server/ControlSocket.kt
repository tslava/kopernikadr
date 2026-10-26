package pl.slava.kopernikadr.camera.server

import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.close
import io.ktor.websocket.readText
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import pl.slava.kopernikadr.camera.protocol.CaptureArgs
import pl.slava.kopernikadr.camera.protocol.CloseCode
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.Events
import pl.slava.kopernikadr.camera.protocol.FrameInfo
import pl.slava.kopernikadr.camera.protocol.GetOperationArgs
import pl.slava.kopernikadr.camera.protocol.HelloArgs
import pl.slava.kopernikadr.camera.protocol.HelloData
import pl.slava.kopernikadr.camera.protocol.OperationState
import pl.slava.kopernikadr.camera.protocol.Ops
import pl.slava.kopernikadr.camera.protocol.PingData
import pl.slava.kopernikadr.camera.protocol.ProtocolError
import pl.slava.kopernikadr.camera.protocol.ProtocolResult
import pl.slava.kopernikadr.camera.protocol.Request
import pl.slava.kopernikadr.camera.protocol.SUPPORTED_VERSIONS
import pl.slava.kopernikadr.camera.protocol.Status
import pl.slava.kopernikadr.camera.protocol.decodeArgs
import pl.slava.kopernikadr.camera.protocol.decodeRequest
import pl.slava.kopernikadr.camera.protocol.encodeError
import pl.slava.kopernikadr.camera.protocol.encodeEvent
import pl.slava.kopernikadr.camera.protocol.encodeOk

private const val LIST_FRAMES = "listFrames"
private const val ACK = "ack"
private const val GET_STATUS = "getStatus"
private const val GET_CONTROLS = "getControls"
private const val SET_CONTROL = "setControl"

/** `/ws/control` (§4–§6): `hello` first, then requests checked against the session. */
internal suspend fun DefaultWebSocketServerSession.controlSocket(hub: Hub) {
    val session = handshake(hub) ?: return
    val sid = session.sessionId
    hub.registerControl(sid, this)
    val pushers = listOf(launch { pushControls(hub, sid) }, launch { pushStatus(hub, sid) })
    val inFlight: MutableSet<String> = ConcurrentHashMap.newKeySet()
    try {
        for (frame in incoming) {
            if (frame !is Frame.Text) continue
            val text = frame.readText()
            val decoded = decodeRequest(text)
            if (hub.sessions.touch(sid) == SessionManager.Validation.LeaseLost) {
                val reqId = when (decoded) {
                    is ProtocolResult.Ok -> decoded.value.reqId
                    is ProtocolResult.Err -> decoded.reqId.orEmpty()
                }
                sendText(encodeError(reqId, ProtocolError.leaseLost()))
                hub.closeSession(sid, CloseCode.LEASE_LOST)
                closeWith(CloseCode.LEASE_LOST) // if this socket was no longer registered
                return
            }
            when (decoded) {
                is ProtocolResult.Err -> sendText(encodeError(decoded.reqId.orEmpty(), decoded.error))
                is ProtocolResult.Ok -> handle(hub, session, decoded.value, inFlight)
            }
        }
    } finally {
        pushers.forEach(Job::cancel)
        hub.unregisterControl(sid, this)
    }
}

/** Reads and answers the first message. Returns the granted session, or null after closing. */
private suspend fun DefaultWebSocketServerSession.handshake(hub: Hub): Session? {
    val first = incoming.receiveCatching().getOrNull() ?: return null
    val decoded = (first as? Frame.Text)?.let { decodeRequest(it.readText()) }
    val request = (decoded as? ProtocolResult.Ok)?.value
    if (request == null || request.op != Ops.HELLO) {
        val reqId = request?.reqId ?: (decoded as? ProtocolResult.Err)?.reqId.orEmpty()
        sendText(encodeError(reqId, ProtocolError.helloExpected()))
        closeWith(CloseCode.PROTOCOL_ERROR)
        return null
    }
    val args = when (val a = request.decodeArgs()) {
        is ProtocolResult.Ok -> a.value as HelloArgs
        is ProtocolResult.Err -> {
            sendText(encodeError(request.reqId, a.error))
            closeWith(CloseCode.PROTOCOL_ERROR)
            return null
        }
    }
    val version = SUPPORTED_VERSIONS.highestCommon(args.protocolVersions)
    if (version == null) {
        sendText(encodeError(request.reqId, ProtocolError.unsupportedVersion(SUPPORTED_VERSIONS, args.protocolVersions)))
        close(CloseReason(CloseReason.Codes.NORMAL, "unsupported version"))
        return null
    }
    return when (val r = hub.sessions.hello(args.clientId)) {
        is SessionManager.HelloResult.Busy -> {
            sendText(encodeError(request.reqId, ProtocolError.busy(r.retryAfterMs)))
            closeWith(CloseCode.BUSY)
            null
        }
        is SessionManager.HelloResult.Granted -> {
            r.replaced?.let { hub.closeSession(it.sessionId, CloseCode.REPLACED) }
            r.expired?.let { hub.closeSession(it.sessionId, CloseCode.LEASE_LOST) }
            val p = hub.ports
            val data = HelloData(
                cameraId = p.identity.cameraId,
                bootId = p.identity.bootId,
                sessionId = r.session.sessionId,
                name = p.identity.name,
                protocolVersion = version,
                capabilities = p.identity.capabilities(),
                controls = p.controls.get(),
                status = p.status.status(),
                sessionTtlMs = hub.sessions.ttlMs,
            )
            sendText(encodeOk(request.reqId, HelloData.serializer(), data))
            r.session
        }
    }
}

private suspend fun DefaultWebSocketServerSession.handle(hub: Hub, session: Session, req: Request, inFlight: MutableSet<String>) {
    val p = hub.ports
    val id = req.reqId
    try {
        when (req.op) {
            Ops.PING -> sendText(encodeOk(id, PingData.serializer(), PingData(System.currentTimeMillis())))
            Ops.CAPTURE -> {
                val args = typedArgs<CaptureArgs>(req) ?: return
                if (!inFlight.add(id)) {
                    sendText(encodeError(id, ProtocolError(ErrorCodes.CAPTURE_IN_PROGRESS, "this reqId is in flight on this socket")))
                    return
                }
                val socket: WebSocketSession = this
                // Server scope: the capture completes even if this socket goes away (§4.4).
                hub.scope.launch {
                    try {
                        val out = try {
                            p.capture.capture(session.clientId, id, args)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            PortResult.Err(internal(e))
                        }
                        socket.sendText(out.encode(id, FrameInfo.serializer()))
                    } finally {
                        inFlight.remove(id)
                    }
                }
            }
            Ops.GET_OPERATION -> {
                val args = typedArgs<GetOperationArgs>(req) ?: return
                val state = withContext(Dispatchers.IO) { p.capture.getOperation(session.clientId, args.reqId) }
                sendText(encodeOk(id, OperationState.serializer(), state))
            }
            LIST_FRAMES -> {
                val a = parseListFrames(req.args)
                val page = withContext(Dispatchers.IO) { p.frames.listUnacked(session.clientId, a.afterSeq, a.limit) }
                sendText(encodeOk(id, FramePage.serializer(), page))
            }
            ACK -> {
                val ids = parseAck(req.args)
                val result = withContext(Dispatchers.IO) { p.frames.ack(session.clientId, ids) }
                sendText(encodeOk(id, AckResult.serializer(), result))
            }
            GET_STATUS -> sendText(encodeOk(id, Status.serializer(), p.status.status()))
            GET_CONTROLS -> sendText(encodeOk(id, Controls.serializer(), p.controls.get()))
            SET_CONTROL -> {
                val change = parseSetControl(req.args)
                launch { // off the receive loop: a slow rebind must not delay pings
                    val out = try {
                        p.controls.set(change)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        PortResult.Err(internal(e))
                    }
                    sendText(out.encode(id, Controls.serializer()))
                }
            }
            Ops.HELLO -> sendText(encodeError(id, ProtocolError.invalidArgs("session already established")))
            else -> sendText(encodeError(id, ProtocolError.unknownOp(req.op)))
        }
    } catch (e: ArgsException) {
        sendText(encodeError(id, e.error))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        sendText(encodeError(id, internal(e)))
    }
}

private suspend inline fun <reified T> WebSocketSession.typedArgs(req: Request): T? =
    when (val a = req.decodeArgs()) {
        is ProtocolResult.Ok -> a.value as T
        is ProtocolResult.Err -> {
            sendText(encodeError(req.reqId, a.error))
            null
        }
    }

private fun <T> PortResult<T>.encode(reqId: String, serializer: kotlinx.serialization.KSerializer<T>): String = when (this) {
    is PortResult.Ok -> encodeOk(reqId, serializer, value)
    is PortResult.Err -> encodeError(reqId, error)
}

private fun internal(e: Exception) = ProtocolError(ErrorCodes.INTERNAL, e.message ?: e.javaClass.simpleName)

/** `controls` events while [sid] is current; values equal to the last one sent are skipped. */
private suspend fun WebSocketSession.pushControls(hub: Hub, sid: String) {
    var last: Controls? = hub.ports.controls.get()
    hub.ports.controls.updates.collect { c ->
        if (c != last && hub.sessions.validate(sid) == SessionManager.Validation.Ok) {
            last = c
            sendText(encodeEvent(Events.CONTROLS, Controls.serializer(), c))
        }
    }
}

private suspend fun WebSocketSession.pushStatus(hub: Hub, sid: String) {
    while (true) {
        delay(hub.config.statusIntervalMs)
        if (hub.sessions.validate(sid) == SessionManager.Validation.Ok) {
            sendText(encodeEvent(Events.STATUS, Status.serializer(), hub.ports.status.status()))
        }
    }
}

/** Sends a text frame; a closed socket is ignored (late answers to a gone client). */
internal suspend fun WebSocketSession.sendText(text: String) {
    runCatching { outgoing.send(Frame.Text(text)) }
}
