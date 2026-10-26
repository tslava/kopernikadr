package pl.slava.kopernikadr.camera.server

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.ProtocolError

// Args of the stage-1 ops the protocol package does not model yet (listFrames, ack, setControl).
// Strict JSON types, like decodeArgs: quoted numbers are INVALID_ARGS.

internal class ArgsException(val error: ProtocolError) : Exception(error.message)

private fun invalidArgs(msg: String): Nothing = throw ArgsException(ProtocolError.invalidArgs(msg))
private fun invalidValue(msg: String): Nothing = throw ArgsException(ProtocolError(ErrorCodes.INVALID_VALUE, msg))

private fun JsonElement.asObject(): JsonObject = this as? JsonObject ?: invalidArgs("args must be an object")

private fun JsonObject.number(name: String): JsonPrimitive? {
    val e = this[name] ?: return null
    if (e is JsonNull) return null
    if (e !is JsonPrimitive || e.isString || e.booleanOrNull != null) invalidArgs("args.$name must be a number")
    return e
}

private fun JsonObject.long(name: String): Long? = number(name)?.let { it.longOrNull ?: invalidArgs("args.$name must be an integer") }
private fun JsonObject.int(name: String): Int? = number(name)?.let { it.intOrNull ?: invalidArgs("args.$name must be an integer") }

private fun JsonObject.string(name: String): String {
    val e = this[name]
    if (e !is JsonPrimitive || !e.isString) invalidArgs("args.$name must be a string")
    return e.content
}

internal data class ListFramesArgs(val afterSeq: Long?, val limit: Int)

internal fun parseListFrames(args: JsonElement): ListFramesArgs {
    val o = args.asObject()
    val limit = o.int("limit") ?: 100
    if (limit !in 1..500) invalidArgs("args.limit must be 1..500")
    return ListFramesArgs(o.long("afterSeq"), limit)
}

internal fun parseAck(args: JsonElement): List<String> {
    val ids = args.asObject()["frameIds"] as? kotlinx.serialization.json.JsonArray ?: invalidArgs("args.frameIds must be an array")
    if (ids.size !in 1..500) invalidArgs("args.frameIds must have 1..500 items")
    return ids.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: invalidArgs("args.frameIds must be strings") }
}

internal fun parseSetControl(args: JsonElement): ControlChange {
    val o = args.asObject()
    fun lockMode(): ControlMode = when (o.string("mode")) {
        "auto" -> ControlMode.AUTO
        "locked" -> ControlMode.LOCKED
        else -> invalidValue("mode must be auto or locked")
    }
    return when (val control = o.string("control")) {
        "exposure" -> ControlChange.Exposure(lockMode())
        "exposureCompensation" -> ControlChange.ExposureCompensation(o.int("steps") ?: invalidArgs("args.steps is required"))
        "whiteBalance" -> ControlChange.WhiteBalance(lockMode())
        "focus" -> ControlChange.Focus(if (lockMode() == ControlMode.AUTO) FocusMode.AUTO else FocusMode.LOCKED)
        "rotation" -> ControlChange.Rotation(o.int("degrees") ?: invalidArgs("args.degrees is required"))
        "previewQuality" -> ControlChange.Preview(
            PreviewQuality.entries.firstOrNull { it.name.lowercase() == o.string("value") }
                ?: invalidValue("value must be low, normal or high"),
        )
        else -> throw ArgsException(ProtocolError(ErrorCodes.UNSUPPORTED_CONTROL, "unsupported control: $control"))
    }
}
