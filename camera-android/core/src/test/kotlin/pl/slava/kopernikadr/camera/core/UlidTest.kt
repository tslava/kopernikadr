package pl.slava.kopernikadr.camera.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import kotlin.random.Random

class UlidTest {
    private val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toSet()

    /** A clock the test moves by hand. */
    private class FakeClock(var now: Long) : () -> Long {
        override fun invoke(): Long = now
    }

    /** Random that always yields the given bytes (repeated), so randomness is predictable. */
    private class FixedRandom(private val byte: Int) : Random() {
        override fun nextBits(bitCount: Int): Int = if (bitCount == 0) 0 else (-1 ushr (32 - bitCount)) and
            (byte or (byte shl 8) or (byte shl 16) or (byte shl 24))
    }

    @Test
    fun `string is 26 chars of Crockford base32`() {
        val gen = UlidGenerator(clock = { 1_761_436_800_000L }, random = Random(1))
        repeat(1000) {
            val id = gen.next()
            assertEquals(26, id.length)
            assertTrue(id, id.all { it in alphabet })
            assertTrue(Ulid.isValid(id))
        }
    }

    @Test
    fun `timestamp is encoded in the first 10 chars and decodable`() {
        val ms = 1_761_436_800_123L
        val id = UlidGenerator(clock = { ms }, random = Random(7)).next()
        assertEquals(ms, Ulid.timestampMs(id))
    }

    @Test
    fun `known vectors - zero and max`() {
        val zero = UlidGenerator(clock = { 0L }, random = FixedRandom(0)).next()
        assertEquals("00000000000000000000000000", zero)

        val max = UlidGenerator(clock = { Ulid.MAX_TIMESTAMP_MS }, random = FixedRandom(0xFF)).next()
        assertEquals("7ZZZZZZZZZZZZZZZZZZZZZZZZZ", max)
        assertEquals(Ulid.MAX_TIMESTAMP_MS, Ulid.timestampMs(max))
    }

    @Test
    fun `known vector - spec example timestamp`() {
        // 1469918176385 ms encodes to 01ARYZ6S41 (ulid spec README).
        val id = UlidGenerator(clock = { 1_469_918_176_385L }, random = FixedRandom(0)).next()
        assertEquals("01ARYZ6S41", id.substring(0, 10))
        assertEquals("0000000000000000", id.substring(10))
    }

    @Test
    fun `monotonic within the same millisecond - randomness is incremented by one`() {
        val gen = UlidGenerator(clock = { 1_000L }, random = FixedRandom(0))
        val a = gen.next()
        val b = gen.next()
        val c = gen.next()
        assertEquals("0000000000000000", a.substring(10))
        assertEquals("0000000000000001", b.substring(10))
        assertEquals("0000000000000002", c.substring(10))
        assertEquals(a.substring(0, 10), c.substring(0, 10))
        assertTrue(a < b && b < c)
    }

    @Test
    fun `increment carries across base32 digits`() {
        // 0x1F in every byte: the low 5 bits are all ones, so +1 must carry into the next digit
        val gen = UlidGenerator(clock = { 5L }, random = FixedRandom(0x1F))
        val a = gen.next()
        val b = gen.next()
        assertEquals(randomness(a) + BigInteger.ONE, randomness(b))
        assertTrue(a < b)
    }

    @Test
    fun `randomness overflow within a millisecond moves to the next millisecond`() {
        // randomness = 2^80 - 1: the next id in the same ms cannot increment, so it borrows ms + 1
        val gen = UlidGenerator(clock = { 5L }, random = FixedRandom(0xFF))
        val a = gen.next()
        val b = gen.next()
        assertTrue(a < b)
        assertEquals(6L, Ulid.timestampMs(b))
        // and the following real-clock id at ms 5 or 6 still sorts after b
        assertTrue(b < gen.next())
    }

    @Test
    fun `within one millisecond every id is the previous randomness plus one`() {
        val gen = UlidGenerator(clock = { 77L }, random = Random(3))
        var prev = gen.next()
        repeat(2_000) {
            val cur = gen.next()
            assertEquals(randomness(prev) + BigInteger.ONE, randomness(cur))
            prev = cur
        }
    }

    private fun randomness(id: String): BigInteger =
        id.substring(10).fold(BigInteger.ZERO) { acc, ch ->
            acc.shiftLeft(5) + BigInteger.valueOf("0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(ch).toLong())
        }

    @Test
    fun `many ids in the same millisecond are strictly increasing`() {
        val gen = UlidGenerator(clock = { 42L }, random = Random(3))
        val ids = List(10_000) { gen.next() }
        assertEquals(ids.size, ids.toSet().size)
        assertEquals(ids, ids.sorted())
    }

    @Test
    fun `new millisecond takes fresh randomness and sorts after`() {
        val clock = FakeClock(1_000L)
        val gen = UlidGenerator(clock = clock, random = Random(11))
        val a = gen.next()
        clock.now = 1_001L
        val b = gen.next()
        assertEquals(1_001L, Ulid.timestampMs(b))
        assertTrue(a < b)
    }

    @Test
    fun `ids sort by time across milliseconds even with smaller randomness`() {
        val clock = FakeClock(2_000L)
        val big = UlidGenerator(clock = clock, random = FixedRandom(0xFF)).next()
        clock.now = 2_001L
        val small = UlidGenerator(clock = clock, random = FixedRandom(0x00)).next()
        assertTrue(big < small)
    }

    @Test
    fun `clock going backwards keeps ids monotonic`() {
        val clock = FakeClock(10_000L)
        val gen = UlidGenerator(clock = clock, random = Random(5))
        val a = gen.next()
        clock.now = 9_000L
        val b = gen.next()
        assertTrue(a < b)
        assertEquals(10_000L, Ulid.timestampMs(b))
    }

    @Test
    fun `random sequence across many ms is sorted in generation order`() {
        val clock = FakeClock(1_700_000_000_000L)
        val gen = UlidGenerator(clock = clock, random = Random(99))
        val ids = List(5_000) { i ->
            if (i % 7 == 0) clock.now += (i % 3)
            gen.next()
        }
        assertEquals(ids, ids.sorted())
        assertEquals(ids.size, ids.toSet().size)
    }

    @Test
    fun `timestamp out of 48-bit range is rejected`() {
        assertThrows(IllegalStateException::class.java) {
            UlidGenerator(clock = { -1L }, random = Random(1)).next()
        }
        assertThrows(IllegalStateException::class.java) {
            UlidGenerator(clock = { Ulid.MAX_TIMESTAMP_MS + 1 }, random = Random(1)).next()
        }
    }

    @Test
    fun `isValid rejects wrong length, bad alphabet and overflowing first char`() {
        assertFalse(Ulid.isValid(""))
        assertFalse(Ulid.isValid("0".repeat(25)))
        assertFalse(Ulid.isValid("0".repeat(27)))
        assertFalse(Ulid.isValid("0".repeat(25) + "I"))
        assertFalse(Ulid.isValid("0".repeat(25) + "U"))
        assertFalse(Ulid.isValid("0".repeat(25) + "a")) // canonical form is upper case
        assertFalse(Ulid.isValid("8" + "0".repeat(25))) // > 128 bits
        assertTrue(Ulid.isValid("7" + "Z".repeat(25)))
    }

    @Test
    fun `timestampMs rejects invalid strings`() {
        assertThrows(IllegalArgumentException::class.java) { Ulid.timestampMs("nope") }
    }

    @Test
    fun `default generator produces valid, distinct, sorted ids`() {
        val gen = UlidGenerator()
        val ids = List(1_000) { gen.next() }
        assertTrue(ids.all(Ulid::isValid))
        assertEquals(ids, ids.sorted())
        assertNotEquals(ids.first(), ids.last())
        val now = System.currentTimeMillis()
        assertTrue(Ulid.timestampMs(ids.last()) in (now - 60_000)..(now + 1_000))
    }
}
