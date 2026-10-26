package pl.slava.kopernikadr.camera.server

import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.Route
import io.ktor.server.routing.get

/**
 * The web remote: classpath resources under [root] (`remote-lite/` in production).
 * `GET /` → `<root>/index.html`, `GET /<path>` → `<root>/<path>` (e.g. `/app.js`, `/sfx/click.mp3`).
 * Constant routes (`/info`, `/frames/…`, `/ws/…`) take precedence. Read with
 * `getResourceAsStream`, which also works for resources packed into an APK.
 */
internal fun Route.staticRemote(root: String) {
    val loader = CameraServer::class.java.classLoader
    suspend fun io.ktor.server.application.ApplicationCall.serve(segments: List<String>) {
        val path = safePath(segments)
        // Only known file types: also keeps directory listings (a "file" without an extension) out.
        val type = path?.let { contentTypeFor(it) }
        val bytes = if (type == null) null else loader.getResourceAsStream("$root/$path")?.use { it.readBytes() }
        if (bytes == null) {
            respond(HttpStatusCode.NotFound)
            return
        }
        response.header(HttpHeaders.CacheControl, "no-cache")
        respondBytes(bytes, type!!)
    }
    get("/") { call.serve(listOf("index.html")) }
    get("/{path...}") { call.serve(call.parameters.getAll("path").orEmpty()) }
}

/** Joined path, or null if any segment could escape the root or is hidden/empty. */
private fun safePath(segments: List<String>): String? {
    if (segments.isEmpty()) return null
    for (s in segments) {
        if (s.isEmpty() || s.startsWith(".") || s.contains('/') || s.contains('\\') || s.contains('\u0000')) return null
    }
    return segments.joinToString("/")
}

private val TYPES = mapOf(
    "html" to ContentType.Text.Html,
    "js" to ContentType("text", "javascript"),
    "mjs" to ContentType("text", "javascript"),
    "css" to ContentType.Text.CSS,
    "json" to ContentType.Application.Json,
    "webmanifest" to ContentType("application", "manifest+json"),
    "svg" to ContentType.Image.SVG,
    "png" to ContentType.Image.PNG,
    "jpg" to ContentType.Image.JPEG,
    "jpeg" to ContentType.Image.JPEG,
    "gif" to ContentType.Image.GIF,
    "webp" to ContentType("image", "webp"),
    "ico" to ContentType("image", "x-icon"),
    "mp3" to ContentType("audio", "mpeg"),
    "wav" to ContentType("audio", "wav"),
    "ogg" to ContentType("audio", "ogg"),
    "woff2" to ContentType("font", "woff2"),
    "txt" to ContentType.Text.Plain,
)

private fun contentTypeFor(path: String): ContentType? {
    val type = TYPES[path.substringAfterLast('/').substringAfterLast('.', "").lowercase()] ?: return null
    return if (type.contentType == "text" || type == ContentType.Application.Json || type == ContentType.Image.SVG) {
        type.withParameter("charset", "utf-8")
    } else {
        type
    }
}
