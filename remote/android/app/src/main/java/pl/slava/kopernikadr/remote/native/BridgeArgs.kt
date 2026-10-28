package pl.slava.kopernikadr.remote.native

import java.util.Base64

/**
 * Typed access to a plugin call's arguments, failing with [NativeErrorCode.BAD_ARGUMENT].
 * [get] returns the raw JSON value of an argument, or null if it is missing or JSON null
 * (the plugin maps `JSONObject.NULL` to null), so this stays testable on the JVM.
 */
class BridgeArgs(private val get: (String) -> Any?) {
    fun string(name: String): String = optString(name) ?: bad("'$name' is required")

    fun optString(name: String): String? = when (val v = get(name)) {
        null -> null
        is String -> v
        else -> bad("'$name' must be a string")
    }

    /** A whole JS number in the safe-integer range (JSON gives Integer, Long or Double). */
    fun long(name: String): Long = when (val v = get(name)) {
        null -> bad("'$name' is required")
        is Int -> v.toLong()
        is Long -> v
        is Double, is Float -> {
            val d = (v as Number).toDouble()
            if (d.isNaN() || d.isInfinite() || d != Math.floor(d) || Math.abs(d) > MAX_SAFE) bad("'$name' must be an integer")
            d.toLong()
        }
        else -> bad("'$name' must be a number")
    }

    /** The value as given (plain lists and maps for JSON arrays and objects), or null if missing. */
    fun raw(name: String): Any? = get(name)

    /** Like [long], null if the argument is missing. */
    fun optLong(name: String): Long? = if (get(name) == null) null else long(name)

    /** Standard (RFC 4648, padded or not) base64; an empty string is an empty array. */
    fun base64(name: String): ByteArray {
        val s = string(name)
        return try {
            Base64.getDecoder().decode(s)
        } catch (e: IllegalArgumentException) {
            bad("'$name' is not valid base64: ${e.message}")
        }
    }

    private fun bad(message: String): Nothing = raise(NativeErrorCode.BAD_ARGUMENT, message)

    private companion object {
        const val MAX_SAFE = 9007199254740991.0 // Number.MAX_SAFE_INTEGER
    }
}
