package pl.slava.kopernikadr.camera.net

import pl.slava.kopernikadr.camera.protocol.SUPPORTED_VERSIONS
import pl.slava.kopernikadr.camera.protocol.VersionRange

/** DNS-SD service type of the camera (PROTOCOL §3). */
const val SERVICE_TYPE = "_kopernikadr._tcp"

/**
 * A DNS-SD TXT record (RFC 6763 §6). Every entry `key=value` is at most [MAX_ENTRY_BYTES] bytes
 * (UTF-8); keys are 1..[MAX_KEY_CHARS] printable ASCII chars without `=`, unique ignoring case; the
 * whole record (one length byte per entry) is at most [MAX_TOTAL_BYTES] (Android's NSD limit).
 * Violations throw [IllegalArgumentException]. Entry order is kept.
 */
class TxtRecord(entries: Map<String, String>) {
    val entries: Map<String, String> = LinkedHashMap(entries)

    /** Size on the wire: each entry is a length byte plus `key=value`. */
    val wireBytes: Int

    init {
        val seen = HashSet<String>()
        var total = 0
        for ((key, value) in this.entries) {
            require(key.length in 1..MAX_KEY_CHARS) { "TXT key '$key' must be 1..$MAX_KEY_CHARS chars" }
            require(key.all { it in ' '..'~' && it != '=' }) { "TXT key '$key' must be printable ASCII without '='" }
            require(seen.add(key.lowercase())) { "duplicate TXT key '$key' (keys are case-insensitive)" }
            val bytes = entryBytes(key, value)
            require(bytes <= MAX_ENTRY_BYTES) { "TXT entry '$key' is $bytes bytes, max $MAX_ENTRY_BYTES" }
            total += 1 + bytes
        }
        require(total <= MAX_TOTAL_BYTES) { "TXT record is $total bytes, max $MAX_TOTAL_BYTES" }
        wireBytes = total
    }

    override fun equals(other: Any?): Boolean = other is TxtRecord && entries == other.entries
    override fun hashCode(): Int = entries.hashCode()
    override fun toString(): String = entries.entries.joinToString(prefix = "TxtRecord(", postfix = ")") { "${it.key}=${it.value}" }

    companion object {
        const val MAX_ENTRY_BYTES = 255
        const val MAX_TOTAL_BYTES = 1300
        const val MAX_KEY_CHARS = 9

        /**
         * The camera's record: `id`=[cameraId], `pv`=`min-max` of [versions], `name`. A [name]
         * too long for its entry is cut on a code point boundary; a blank or oversized
         * [cameraId] throws.
         */
        fun forCamera(cameraId: String, name: String, versions: VersionRange = SUPPORTED_VERSIONS): TxtRecord {
            require(cameraId.isNotBlank()) { "blank cameraId" }
            return TxtRecord(
                linkedMapOf(
                    "id" to cameraId,
                    "pv" to "${versions.min}-${versions.max}",
                    "name" to truncateUtf8(name, MAX_ENTRY_BYTES - "name=".length),
                ),
            )
        }

        private fun entryBytes(key: String, value: String): Int = key.length + 1 + utf8Size(value)
    }
}

/** Maximum UTF-8 size of a DNS label, which an instance name is. */
const val MAX_INSTANCE_NAME_BYTES = 63

/**
 * The DNS-SD instance name "`<name>` (`xxxx`)", `xxxx` being the last 4 chars of [cameraId], so
 * several cameras differ. [name] is cut to keep the whole within one DNS label.
 */
fun instanceName(name: String, cameraId: String): String {
    val suffix = " (${cameraId.takeLast(4)})"
    return truncateUtf8(name, MAX_INSTANCE_NAME_BYTES - utf8Size(suffix)) + suffix
}

/** What the camera advertises over DNS-SD. */
data class Advertisement(
    val instanceName: String,
    val port: Int,
    val txt: TxtRecord,
    val serviceType: String = SERVICE_TYPE,
) {
    init {
        require(port in 1..65535) { "port $port out of range" }
    }

    companion object {
        fun forCamera(cameraId: String, name: String, port: Int): Advertisement =
            Advertisement(instanceName(name, cameraId), port, TxtRecord.forCamera(cameraId, name))
    }
}

private fun utf8Size(s: String): Int = s.toByteArray(Charsets.UTF_8).size

/** The longest prefix of [s] within [maxBytes] UTF-8 bytes, never splitting a code point. */
private fun truncateUtf8(s: String, maxBytes: Int): String {
    var bytes = 0
    var i = 0
    while (i < s.length) {
        val cp = s.codePointAt(i)
        val n = when {
            cp < 0x80 -> 1
            cp < 0x800 -> 2
            cp < 0x10000 -> 3
            else -> 4
        }
        if (bytes + n > maxBytes) break
        bytes += n
        i += Character.charCount(cp)
    }
    return s.substring(0, i)
}
