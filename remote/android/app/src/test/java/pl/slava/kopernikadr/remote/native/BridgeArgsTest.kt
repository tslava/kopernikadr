package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BridgeArgsTest {
    private fun args(vararg pairs: Pair<String, Any>) = BridgeArgs(mapOf(*pairs)::get)

    @Test
    fun strings() {
        assertEquals("a", args("p" to "a").string("p"))
        assertEquals("", args("p" to "").string("p"))
        assertEquals("a", args("p" to "a").optString("p"))
        assertNull(args().optString("p"))
    }

    @Test
    fun missingOrWrongTypeStringIsBadArgument() {
        val e = expectCode(NativeErrorCode.BAD_ARGUMENT) { args().string("path") }
        assertEquals("'path' is required", e.message)
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args("path" to 5).string("path") }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args("path" to true).optString("path") }
    }

    @Test
    fun longsFromAnyJsonNumber() {
        assertEquals(5L, args("n" to 5).long("n"))
        assertEquals(5_000_000_000L, args("n" to 5_000_000_000L).long("n"))
        assertEquals(7L, args("n" to 7.0).long("n"))
        assertEquals(-1L, args("n" to -1).long("n"))
        assertEquals(9007199254740991L, args("n" to 9007199254740991.0).long("n"))
    }

    @Test
    fun badLongsAreBadArgument() {
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args().long("n") }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args("n" to "5").long("n") }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args("n" to 1.5).long("n") }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args("n" to Double.NaN).long("n") }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args("n" to Double.POSITIVE_INFINITY).long("n") }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args("n" to 1e17).long("n") }
    }

    @Test
    fun base64() {
        assertArrayEquals(byteArrayOf(0, 1, 2, -1), args("d" to "AAEC/w==").base64("d"))
        assertArrayEquals(byteArrayOf(0, 1, 2, -1), args("d" to "AAEC/w").base64("d"))
        assertArrayEquals(ByteArray(0), args("d" to "").base64("d"))
    }

    @Test
    fun badBase64IsBadArgument() {
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args().base64("d") }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args("d" to "not base64!").base64("d") }
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args("d" to "AAEC_w==").base64("d") } // url-safe alphabet
        expectCode(NativeErrorCode.BAD_ARGUMENT) { args("d" to 12).base64("d") }
    }
}
