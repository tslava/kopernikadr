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
    const val GET_CONTROLS = "getControls"
    const val SET_CONTROL = "setControl"

    fun argsSerializer(op: String): DeserializationStrategy<RequestArgs>? = when (op) {
        HELLO -> HelloArgs.serializer()
        PING -> PingArgs.serializer()
        CAPTURE -> CaptureArgs.serializer()
        GET_OPERATION -> GetOperationArgs.serializer()
        GET_CONTROLS -> GetControlsArgs.serializer()
        SET_CONTROL -> SetControlArgs.serializer()
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
    is GetControlsArgs -> ProtocolJson.encodeToJsonElement(GetControlsArgs.serializer(), this)
    is SetControlArgs -> ProtocolJson.encodeToJsonElement(SetControlArgs.serializer(), this)
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

@Serializable
data object GetControlsArgs : RequestArgs {
    override val op: String get() = Ops.GET_CONTROLS
}

/**
 * `setControl` args (§6), one control per call. Flat on purpose: an unknown [control] or a bad
 * value decodes fine and is answered by the controls logic with `UNSUPPORTED_CONTROL` /
 * `INVALID_VALUE`, not with `INVALID_ARGS`.
 * - `exposure` / `whiteBalance` / `focus`: [mode] `"auto"|"locked"`;
 * - `exposureCompensation`: [steps];
 * - `rotation`: [degrees] `0|180`;
 * - `previewQuality`: [value] `"low"|"normal"|"high"`.
 */
@Serializable
data class SetControlArgs(
    val control: String,
    val mode: String? = null,
    val steps: Int? = null,
    val degrees: Int? = null,
    val value: String? = null,
) : RequestArgs {
    init {
        require(control.isNotBlank()) { "control must not be empty" }
    }

    override val op: String get() = Ops.SET_CONTROL

    companion object {
        const val EXPOSURE = "exposure"
        const val EXPOSURE_COMPENSATION = "exposureCompensation"
        const val WHITE_BALANCE = "whiteBalance"
        const val FOCUS = "focus"
        const val ROTATION = "rotation"
        const val PREVIEW_QUALITY = "previewQuality"
    }
}
