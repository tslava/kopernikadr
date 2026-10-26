package pl.slava.kopernikadr.camera.protocol

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** Op names (§6) that have typed args here. Any other op decodes to `UNKNOWN_OP`. */
object Ops {
    const val HELLO = "hello"
    const val PING = "ping"
    const val CAPTURE = "capture"

    /** Modelled now; the 0a server may still answer it with `UNKNOWN_OP` (stage 1). */
    const val GET_OPERATION = "getOperation"

    fun argsSerializer(op: String): DeserializationStrategy<RequestArgs>? = when (op) {
        HELLO -> HelloArgs.serializer()
        PING -> PingArgs.serializer()
        CAPTURE -> CaptureArgs.serializer()
        GET_OPERATION -> GetOperationArgs.serializer()
        else -> null
    }
}

/** Typed `args` of a request; [op] is the op it belongs to. */
sealed interface RequestArgs {
    val op: String
}

/** Encodes args with their concrete serializer (for clients and tests). */
fun RequestArgs.toJsonElement(): JsonElement = when (this) {
    is HelloArgs -> ProtocolJson.encodeToJsonElement(HelloArgs.serializer(), this)
    is PingArgs -> ProtocolJson.encodeToJsonElement(PingArgs.serializer(), this)
    is CaptureArgs -> ProtocolJson.encodeToJsonElement(CaptureArgs.serializer(), this)
    is GetOperationArgs -> ProtocolJson.encodeToJsonElement(GetOperationArgs.serializer(), this)
}

@Serializable
data class HelloArgs(
    val clientId: String,
    val protocolVersions: VersionRange,
    val appVersion: String,
    val platform: String,
    /** Ignored in v1. */
    val token: String? = null,
) : RequestArgs {
    init {
        require(clientId.isNotBlank()) { "clientId must not be empty" }
    }

    override val op: String get() = Ops.HELLO
}

@Serializable
data object PingArgs : RequestArgs {
    override val op: String get() = Ops.PING
}

@Serializable
data class CaptureArgs(val projectId: String, val rotation: Int) : RequestArgs {
    init {
        require(projectId.isNotBlank()) { "projectId must not be empty" }
    }

    override val op: String get() = Ops.CAPTURE
}

/** `reqId` of the operation to look up, scoped to the caller's `clientId`. */
@Serializable
data class GetOperationArgs(val reqId: String) : RequestArgs {
    init {
        require(reqId.isNotBlank()) { "reqId must not be empty" }
    }

    override val op: String get() = Ops.GET_OPERATION
}
