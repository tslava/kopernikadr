package pl.slava.kopernikadr.camera.protocol

import java.nio.ByteBuffer
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.SerialKind
import kotlinx.serialization.descriptors.StructureKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.encodeToJsonElement

/** Protocol major version (`v` in every message). */
const val PROTOCOL_VERSION = 1

/** Versions this camera speaks; `/info` and `hello` negotiation use it. */
val SUPPORTED_VERSIONS = VersionRange(PROTOCOL_VERSION, PROTOCOL_VERSION)

/** The one Json configuration for the wire: unknown keys ignored, defaults written, nulls omitted. */
val ProtocolJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
}

/** Event names (§5). */
object Events {
    const val STATUS = "status"
    const val CONTROLS = "controls"
}

/** `{"v":1, "t":"req", "reqId", "op", "args"}`. `args` stays raw until [decodeArgs]. */
@Serializable
data class Request(
    val v: Int,
    val t: String = T_REQ,
    val reqId: String,
    val op: String,
    val args: JsonElement = JsonObject(emptyMap()),
)

/** `{"v":1, "t":"res", "reqId", "ok", "data"|"error"}`. */
@Serializable
data class Response(
    val v: Int = PROTOCOL_VERSION,
    val t: String = T_RES,
    val reqId: String,
    val ok: Boolean,
    val data: JsonElement? = null,
    val error: ProtocolError? = null,
)

/** `{"v":1, "t":"evt", "name", "data"}`. */
@Serializable
data class Event(
    val v: Int = PROTOCOL_VERSION,
    val t: String = T_EVT,
    val name: String,
    val data: JsonElement,
)

const val T_REQ = "req"
const val T_RES = "res"
const val T_EVT = "evt"

/** A decode outcome. [Err.reqId] is the request's id when it could be read, for the `res`. */
sealed interface ProtocolResult<out T> {
    data class Ok<out T>(val value: T) : ProtocolResult<T>
    data class Err(val error: ProtocolError, val reqId: String? = null) : ProtocolResult<Nothing>
}

/**
 * Parses a control message envelope. Malformed JSON or envelope → `INVALID_ARGS`. The op is
 * not checked here: the server looks at [Request.op] (e.g. "hello expected"), then calls
 * [decodeArgs].
 */
fun decodeRequest(text: String): ProtocolResult<Request> {
    val element = try {
        ProtocolJson.parseToJsonElement(text)
    } catch (e: IllegalArgumentException) {
        return ProtocolResult.Err(ProtocolError.invalidArgs("malformed JSON"))
    }
    if (element !is JsonObject) return ProtocolResult.Err(ProtocolError.invalidArgs("message must be a JSON object"))
    val reqId = (element["reqId"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
    val request = try {
        checkWireTypes(Request.serializer().descriptor, element, "message")
        ProtocolJson.decodeFromJsonElement(Request.serializer(), element)
    } catch (e: IllegalArgumentException) {
        return ProtocolResult.Err(ProtocolError.invalidArgs("bad envelope: ${e.message.firstLine()}"), reqId)
    }
    return when {
        request.t != T_REQ -> ProtocolResult.Err(ProtocolError.invalidArgs("expected t=\"$T_REQ\""), reqId)
        request.reqId.isBlank() -> ProtocolResult.Err(ProtocolError.invalidArgs("reqId must not be empty"))
        else -> ProtocolResult.Ok(request)
    }
}

/** Decodes [Request.args] for [Request.op]. Unknown op → `UNKNOWN_OP`, bad args → `INVALID_ARGS`. */
fun Request.decodeArgs(): ProtocolResult<RequestArgs> {
    val serializer = Ops.argsSerializer(op) ?: return ProtocolResult.Err(ProtocolError.unknownOp(op), reqId)
    return try {
        checkWireTypes(serializer.descriptor, args, "args")
        ProtocolResult.Ok(ProtocolJson.decodeFromJsonElement(serializer, args))
    } catch (e: IllegalArgumentException) {
        ProtocolResult.Err(ProtocolError.invalidArgs("bad args for $op: ${e.message.firstLine()}"), reqId)
    }
}

fun encodeRequest(reqId: String, op: String, args: JsonElement): String =
    ProtocolJson.encodeToString(Request.serializer(), Request(PROTOCOL_VERSION, T_REQ, reqId, op, args))

fun encodeRequest(reqId: String, args: RequestArgs): String = encodeRequest(reqId, args.op, args.toJsonElement())

fun <T> encodeOk(reqId: String, serializer: SerializationStrategy<T>, data: T): String =
    encodeResponse(Response(reqId = reqId, ok = true, data = ProtocolJson.encodeToJsonElement(serializer, data)))

/** `T` is the static type: pass `OperationState`, not a subclass, so `state` is written. */
inline fun <reified T> encodeOk(reqId: String, data: T): String =
    encodeResponse(Response(reqId = reqId, ok = true, data = ProtocolJson.encodeToJsonElement(data)))

fun encodeError(reqId: String, error: ProtocolError): String =
    encodeResponse(Response(reqId = reqId, ok = false, error = error))

fun encodeResponse(response: Response): String = ProtocolJson.encodeToString(Response.serializer(), response)

fun <T> encodeEvent(name: String, serializer: SerializationStrategy<T>, data: T): String =
    ProtocolJson.encodeToString(Event.serializer(), Event(name = name, data = ProtocolJson.encodeToJsonElement(serializer, data)))

inline fun <reified T> encodeEvent(name: String, data: T): String =
    ProtocolJson.encodeToString(Event.serializer(), Event(name = name, data = ProtocolJson.encodeToJsonElement(data)))

/** Preview binary message (§7): `uint32 BE headerLength` + UTF-8 JSON header + JPEG bytes. */
fun encodePreviewFrame(header: PreviewHeader, jpeg: ByteArray): ByteArray {
    val json = ProtocolJson.encodeToString(PreviewHeader.serializer(), header).toByteArray(Charsets.UTF_8)
    return ByteBuffer.allocate(4 + json.size + jpeg.size).putInt(json.size).put(json).put(jpeg).array()
}

private fun String?.firstLine(): String = this?.lineSequence()?.firstOrNull().orEmpty()

/**
 * kotlinx decoding from a JsonElement coerces quoted numbers and booleans (`"0"` → 0). The
 * protocol is strict, so check JSON types against the descriptor first. Unknown keys are skipped.
 */
@OptIn(ExperimentalSerializationApi::class)
private fun checkWireTypes(descriptor: SerialDescriptor, element: JsonElement, path: String) {
    val kind = descriptor.kind
    if (kind !is PrimitiveKind && kind !is StructureKind && kind != SerialKind.ENUM) return // JsonElement etc.
    if (element is JsonNull) {
        require(descriptor.isNullable) { "$path must not be null" }
        return
    }
    when (kind) {
        PrimitiveKind.STRING, SerialKind.ENUM ->
            require(element is JsonPrimitive && element.isString) { "$path must be a string" }
        PrimitiveKind.BOOLEAN ->
            require(element is JsonPrimitive && !element.isString && element.booleanOrNull != null) {
                "$path must be a boolean"
            }
        is PrimitiveKind ->
            require(element is JsonPrimitive && !element.isString && element.booleanOrNull == null) {
                "$path must be a number"
            }
        StructureKind.CLASS, StructureKind.OBJECT -> {
            require(element is JsonObject) { "$path must be an object" }
            for (i in 0 until descriptor.elementsCount) {
                val name = descriptor.getElementName(i)
                val child = element[name] ?: continue
                checkWireTypes(descriptor.getElementDescriptor(i), child, "$path.$name")
            }
        }
        StructureKind.LIST -> {
            require(element is JsonArray) { "$path must be an array" }
            val item = descriptor.getElementDescriptor(0)
            element.forEachIndexed { i, child -> checkWireTypes(item, child, "$path[$i]") }
        }
        else -> Unit // maps: not used in requests
    }
}
