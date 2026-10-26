package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import java.io.File
import java.security.MessageDigest

fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** Runs [block], expects a [NativeException] with [code], returns it. */
fun expectCode(code: NativeErrorCode, block: () -> Unit): NativeException {
    try {
        block()
    } catch (e: NativeException) {
        assertEquals("message: ${e.message}", code, e.code)
        return e
    }
    fail("expected NativeException($code)")
    throw AssertionError()
}

/** Leftover temp files anywhere under [dir]. */
fun tmpLeftovers(dir: File): List<String> =
    dir.walkTopDown().filter { it.isFile && it.name.endsWith(".tmp") }.map { it.name }.toList()
