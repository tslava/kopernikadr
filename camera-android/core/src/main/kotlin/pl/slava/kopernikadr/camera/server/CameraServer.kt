package pl.slava.kopernikadr.camera.server

import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.server.http.content.LocalFileContent
import io.ktor.server.application.Application
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.hooks.ResponseBodyReadyForSend
import io.ktor.server.application.install
import io.ktor.server.application.log
import io.ktor.server.plugins.mutableOriginConnectionPoint
import io.ktor.server.response.header
import io.ktor.util.AttributeKey
import io.ktor.server.cio.CIO
import io.ktor.server.cio.CIOApplicationEngine
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import java.io.IOException
import java.net.BindException
import java.net.InetSocketAddress
import java.net.ServerSocket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import pl.slava.kopernikadr.camera.core.Ulid
import pl.slava.kopernikadr.camera.protocol.Info
import pl.slava.kopernikadr.camera.protocol.ProtocolJson
import pl.slava.kopernikadr.camera.protocol.SUPPORTED_VERSIONS

class ServerConfig(
    val sessions: SessionManager = SessionManager(),
    /** Period of the `status` event to the current session's control socket. */
    val statusIntervalMs: Long = 10_000,
    /** Classpath directory of the web remote served at `/`. */
    val staticRoot: String = "remote-lite",
    /**
     * Development only (debug/probe builds): the CORS routes also allow `http://localhost:<port>`
     * and `http://127.0.0.1[:<port>]`, for the remote's web build under `next dev` in desktop
     * Chrome. Off, they allow exactly `http://localhost` (see [isLocalhostAnyPortOrigin]).
     */
    val allowLocalhostAnyPort: Boolean = false,
)

/**
 * Installs the whole camera server (PROTOCOL.md §3) into an [Application]:
 * `GET /info`, `GET /frames/{frameId}/{variant}.jpg` (both with CORS for `http://localhost`, and
 * any localhost port with [ServerConfig.allowLocalhostAnyPort]),
 * `/ws/control`, `/ws/preview?session=`, and the web remote (`/`, `/{path...}`).
 * Captures run in the application scope, so they outlive their socket. Every `GET` route also
 * answers `HEAD`. A display cache that cannot be generated is `503` with `Retry-After: 1`.
 * Incoming WebSocket messages are limited to [MAX_WS_MESSAGE_BYTES] (larger → close 1009).
 */
fun Application.cameraModule(ports: CameraPorts, config: ServerConfig = ServerConfig()) {
    install(HeadAsGet)
    install(WebSockets) {
        // Incoming only (outgoing preview frames are not limited). Ktor checks each frame's
        // declared length before reading it and the running total of a fragmented message, and
        // closes with 1009 (TOO_BIG) before anything reaches the JSON parser.
        maxFrameSize = MAX_WS_MESSAGE_BYTES
    }
    val hub = Hub(ports, config, scope = this)
    routing {
        route("/info") {
            installCors(config.allowLocalhostAnyPort)
            get {
                val id = ports.identity
                val info = Info(id.cameraId, id.name, id.bootId, SUPPORTED_VERSIONS)
                call.respondText(ProtocolJson.encodeToString(Info.serializer(), info), ContentType.Application.Json)
            }
        }
        route("/frames/{frameId}/{file}") {
            installCors(config.allowLocalhostAnyPort)
            get {
                val frameId = call.parameters["frameId"].orEmpty()
                val file = call.parameters["file"].orEmpty()
                val variant = if (file.endsWith(".jpg")) FrameVariant.fromWire(file.removeSuffix(".jpg")) else null
                val found = try {
                    if (variant != null && Ulid.isValid(frameId)) {
                        withContext(Dispatchers.IO) { ports.frames.open(frameId, variant) }
                    } else {
                        null
                    }
                } catch (e: FrameUnavailableException) {
                    call.application.log.warn("GET /frames/$frameId/$file: ${e.message}")
                    call.response.header(HttpHeaders.RetryAfter, "1")
                    call.respond(HttpStatusCode.ServiceUnavailable)
                    return@get
                }
                when (found) {
                    is FrameFile.OnDisk ->
                        if (found.file.isFile) call.respond(LocalFileContent(found.file, ContentType.Image.JPEG))
                        else call.respond(HttpStatusCode.NotFound)
                    is FrameFile.InMemory -> call.respondBytes(found.bytes, ContentType.Image.JPEG)
                    null -> call.respond(HttpStatusCode.NotFound)
                }
            }
        }
        webSocket("/ws/control") { controlSocket(hub) }
        route("/ws/preview") {
            install(PreviewGate) { sessions = config.sessions }
            webSocket { previewSocket(hub, call.request.queryParameters["session"].orEmpty()) }
        }
        staticRemote(config.staticRoot)
    }
}

/** Largest incoming WebSocket message (control requests and preview `next` are tiny). */
const val MAX_WS_MESSAGE_BYTES = 64L * 1024

/**
 * `HEAD` for every `GET` route (what Ktor's `AutoHeadResponse` does; that plugin is a separate
 * artifact): routed as `GET`, answered with the same status and headers, `Content-Length`
 * included, and no body.
 */
private val HeadAsGet = createApplicationPlugin("HeadAsGet") {
    onCall { call ->
        if (call.request.local.method == HttpMethod.Head) call.mutableOriginConnectionPoint.method = HttpMethod.Get
    }
    on(ResponseBodyReadyForSend) { call, content ->
        if (call.request.local.method == HttpMethod.Head && content !is OutgoingContent.NoContent) {
            transformBodyTo(HeadResponse(content))
        }
    }
}

private class HeadResponse(private val original: OutgoingContent) : OutgoingContent.NoContent() {
    override val status: HttpStatusCode? get() = original.status
    override val contentType: ContentType? get() = original.contentType
    override val contentLength: Long? get() = original.contentLength
    override fun <T : Any> getProperty(key: AttributeKey<T>): T? = original.getProperty(key)
    override fun <T : Any> setProperty(key: AttributeKey<T>, value: T?) = original.setProperty(key, value)
    override val headers: Headers get() = original.headers
}

private fun Route.installCors(allowLocalhostAnyPort: Boolean) {
    install(CORS) {
        allowHost("localhost", schemes = listOf("http"))
        if (allowLocalhostAnyPort) allowOrigins(::isLocalhostAnyPortOrigin)
        allowMethod(HttpMethod.Get)
    }
}

private val LOCALHOST_ANY_PORT = Regex("""http://(localhost|127\.0\.0\.1)(?::([1-9][0-9]{0,4}))?""")

/**
 * `http://localhost` or `http://127.0.0.1` with an optional port 1–65535 (no leading zero) and
 * nothing else: no other scheme, host suffix, userinfo, path or trailing slash.
 */
internal fun isLocalhostAnyPortOrigin(origin: String): Boolean {
    val m = LOCALHOST_ANY_PORT.matchEntire(origin) ?: return false
    val port = m.groupValues[2]
    return port.isEmpty() || port.toInt() <= 65535
}

/**
 * The camera HTTP/WS server on Ktor CIO.
 *
 * [start] binds [port] (default 8765) on all interfaces, or an ephemeral port if it is busy, and
 * returns the bound port. [stop] closes sockets and cancels running captures; it blocks the
 * caller for at most ~1.2 s, so call it off the main thread. A stopped server can be started again.
 */
class CameraServer(
    private val ports: CameraPorts,
    private val config: ServerConfig = ServerConfig(),
    private val port: Int = DEFAULT_PORT,
    private val host: String = "0.0.0.0",
) {
    private var server: EmbeddedServer<CIOApplicationEngine, CIOApplicationEngine.Configuration>? = null

    /** The bound port while running, else -1. */
    @Volatile
    var boundPort: Int = -1
        private set

    @Synchronized
    fun start(): Int {
        check(server == null) { "already started" }
        // Probe first: CIO also reports a bind failure as an uncaught coroutine exception.
        val s = if (port == 0 || !canBind(port)) {
            launch(0)
        } else {
            try {
                launch(port)
            } catch (e: Exception) {
                if (!e.isBindFailure()) throw e
                launch(0) // lost a race for the port
            }
        }
        server = s
        boundPort = runBlocking { s.engine.resolvedConnectors().first().port }
        return boundPort
    }

    @Synchronized
    fun stop() {
        val s = server ?: return
        server = null
        boundPort = -1
        s.stop(gracePeriodMillis = 200, timeoutMillis = 1_000)
    }

    private fun launch(p: Int) = embeddedServer(CIO, port = p, host = host) { cameraModule(ports, config) }.also {
        try {
            it.start(wait = false)
        } catch (e: Throwable) {
            runCatching { it.stop(0, 0) }
            throw e
        }
    }

    private fun canBind(p: Int): Boolean = try {
        ServerSocket().use {
            it.reuseAddress = true
            it.bind(InetSocketAddress(host, p))
        }
        true
    } catch (e: IOException) {
        false
    }

    private fun Throwable.isBindFailure(): Boolean =
        generateSequence(this) { it.cause }.any { it is BindException || it.message?.contains("Address already in use") == true }

    companion object {
        const val DEFAULT_PORT = 8765
    }
}
