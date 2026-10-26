package pl.slava.kopernikadr.camera.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** Error codes, PROTOCOL.md §10. */
object ErrorCodes {
    const val BUSY = "BUSY"
    const val LEASE_LOST = "LEASE_LOST"
    const val UNSUPPORTED_VERSION = "UNSUPPORTED_VERSION"
    const val UNKNOWN_OP = "UNKNOWN_OP"
    const val INVALID_ARGS = "INVALID_ARGS"
    const val CAMERA_NOT_READY = "CAMERA_NOT_READY"
    const val CAPTURE_IN_PROGRESS = "CAPTURE_IN_PROGRESS"
    const val CAPTURE_FAILED = "CAPTURE_FAILED"
    const val INTERRUPTED = "INTERRUPTED"
    const val GEOMETRY_MISMATCH = "GEOMETRY_MISMATCH"
    const val STORAGE_LOW = "STORAGE_LOW"
    const val REQ_ID_REUSED = "REQ_ID_REUSED"
    const val UNSUPPORTED_CONTROL = "UNSUPPORTED_CONTROL"
    const val INVALID_VALUE = "INVALID_VALUE"
    const val INTERNAL = "INTERNAL"

    private val RETRYABLE = setOf(BUSY, CAMERA_NOT_READY, CAPTURE_IN_PROGRESS, INTERNAL)

    /** The `retryable` flag from the §10 table (`BUSY`: after `retryAfterMs`). */
    fun isRetryable(code: String): Boolean = code in RETRYABLE
}

/**
 * The `error` object of a `res` with `ok:false`. `retryAfterMs` is a top-level field (set with
 * `BUSY`); `data` carries optional code-specific details.
 */
@Serializable
data class ProtocolError(
    val code: String,
    val message: String,
    val retryable: Boolean = ErrorCodes.isRetryable(code),
    val retryAfterMs: Long? = null,
    val data: JsonObject? = null,
) {
    companion object {
        fun busy(retryAfterMs: Long) =
            ProtocolError(ErrorCodes.BUSY, "another client holds the session", retryAfterMs = retryAfterMs)

        fun leaseLost() = ProtocolError(ErrorCodes.LEASE_LOST, "this socket's session is no longer current")

        fun unknownOp(op: String) = ProtocolError(ErrorCodes.UNKNOWN_OP, "unknown op: $op")

        fun invalidArgs(message: String) = ProtocolError(ErrorCodes.INVALID_ARGS, message)

        /** The answer to a first message other than `hello`; the socket is then closed with 4000. */
        fun helloExpected() = invalidArgs("hello expected")

        fun unsupportedVersion(camera: VersionRange, client: VersionRange) = ProtocolError(
            ErrorCodes.UNSUPPORTED_VERSION,
            "no common protocol version: camera ${camera.min}-${camera.max}, client ${client.min}-${client.max}",
            data = buildJsonObject {
                putJsonObject("protocolVersions") {
                    put("min", camera.min)
                    put("max", camera.max)
                }
            },
        )
    }
}

/** WebSocket close codes used by the camera (PROTOCOL.md §4, §7). */
enum class CloseCode(val code: Short, val reason: String) {
    /** The first control message was not `hello`. */
    PROTOCOL_ERROR(4000, "protocol error"),

    /** The same client opened a new session. */
    REPLACED(4001, "replaced"),

    /** The socket's session is no longer current. */
    LEASE_LOST(4002, "lease lost"),

    /** `hello` was answered with `BUSY`. */
    BUSY(4003, "busy"),
}
