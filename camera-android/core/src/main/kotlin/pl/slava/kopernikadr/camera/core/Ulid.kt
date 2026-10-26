package pl.slava.kopernikadr.camera.core

import java.security.SecureRandom
import kotlin.random.Random
import kotlin.random.asKotlinRandom

/**
 * ULID helpers (https://github.com/ulid/spec): 26 chars of Crockford base32, upper case.
 * The first 10 chars hold a 48-bit Unix-ms timestamp, the last 16 hold 80 bits of randomness,
 * so the string order equals the (timestamp, randomness) order.
 */
object Ulid {
    const val LENGTH = 26
    const val MAX_TIMESTAMP_MS = (1L shl 48) - 1
    internal const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /** True for a canonical (upper-case, 26-char, ≤ 128-bit) ULID string. */
    fun isValid(s: String): Boolean =
        s.length == LENGTH && s[0] in '0'..'7' && s.all { ALPHABET.indexOf(it) >= 0 }

    /** The timestamp encoded in [ulid]. */
    fun timestampMs(ulid: String): Long {
        require(isValid(ulid)) { "not a ULID: '$ulid'" }
        var ts = 0L
        for (i in 0 until 10) ts = (ts shl 5) or ALPHABET.indexOf(ulid[i]).toLong()
        return ts
    }
}

/**
 * Monotonic ULID generator. Within one millisecond (or when the clock goes backwards) it keeps
 * the last timestamp and increments the 80-bit randomness by one; if that overflows it moves to
 * the next millisecond with fresh randomness. Thread-safe.
 */
class UlidGenerator(
    private val clock: () -> Long = System::currentTimeMillis,
    private val random: Random = SecureRandom().asKotlinRandom(),
) {
    private var lastMs = -1L
    private var hi = 0 // top 16 bits of randomness
    private var lo = 0L // low 64 bits of randomness

    @Synchronized
    fun next(): String {
        val now = clock()
        check(now in 0..Ulid.MAX_TIMESTAMP_MS) { "clock out of ULID range: $now" }
        if (now > lastMs) {
            lastMs = now
            fresh()
        } else if (!increment()) {
            check(lastMs < Ulid.MAX_TIMESTAMP_MS) { "ULID space exhausted" }
            lastMs += 1
            fresh()
        }
        return encode(lastMs, hi, lo)
    }

    private fun fresh() {
        val b = random.nextBytes(10)
        hi = ((b[0].toInt() and 0xFF) shl 8) or (b[1].toInt() and 0xFF)
        lo = 0L
        for (i in 2 until 10) lo = (lo shl 8) or (b[i].toLong() and 0xFF)
    }

    /** Adds one to the 80-bit randomness; false on overflow (state unchanged). */
    private fun increment(): Boolean {
        if (lo != -1L) {
            lo += 1
            return true
        }
        if (hi == 0xFFFF) return false
        hi += 1
        lo = 0L
        return true
    }

    private companion object {
        fun encode(ms: Long, hi: Int, lo: Long): String {
            val out = CharArray(Ulid.LENGTH)
            var t = ms
            for (i in 9 downTo 0) {
                out[i] = Ulid.ALPHABET[(t and 31).toInt()]
                t = t ushr 5
            }
            // 80 bits = top 20 bits (hi:16 + lo's top 4) + low 60 bits
            var low60 = lo and 0x0FFF_FFFF_FFFF_FFFFL
            for (i in 25 downTo 14) {
                out[i] = Ulid.ALPHABET[(low60 and 31).toInt()]
                low60 = low60 ushr 5
            }
            var top20 = (hi shl 4) or (lo ushr 60).toInt()
            for (i in 13 downTo 10) {
                out[i] = Ulid.ALPHABET[top20 and 31]
                top20 = top20 ushr 5
            }
            return String(out)
        }
    }
}
