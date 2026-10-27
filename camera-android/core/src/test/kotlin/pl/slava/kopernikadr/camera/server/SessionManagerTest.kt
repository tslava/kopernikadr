package pl.slava.kopernikadr.camera.server

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionManagerTest {

    private class FakeClock(var now: Long = 5_000_000_000L) : MonotonicClock {
        override fun nanos(): Long = now
        fun advanceMs(ms: Long) { now += ms * 1_000_000L }
        fun advanceNs(ns: Long) { now += ns }
    }

    private val clock = FakeClock()
    private var nextId = 0
    private val sm = SessionManager(clock, ttlMs = 10_000L, newSessionId = { "s${++nextId}" })

    private fun granted(clientId: String): SessionManager.HelloResult.Granted =
        sm.hello(clientId) as? SessionManager.HelloResult.Granted
            ?: throw AssertionError("expected Granted for $clientId")

    @Test
    fun `first hello is granted`() {
        val g = granted("A")
        assertEquals(Session("s1", "A"), g.session)
        assertNull(g.replaced)
        assertNull(g.expired)
        assertEquals(g.session, sm.current())
        assertEquals(SessionManager.Validation.Ok, sm.validate("s1"))
        assertEquals(10_000L, sm.ttlMs)
    }

    @Test
    fun `same clientId replaces and the old session is returned`() {
        granted("A")
        clock.advanceMs(3_000)
        val g = granted("A")
        assertEquals(Session("s2", "A"), g.session)
        assertEquals(Session("s1", "A"), g.replaced)
        assertNull(g.expired)
        assertEquals(SessionManager.Validation.LeaseLost, sm.validate("s1"))
        assertEquals(SessionManager.Validation.Ok, sm.validate("s2"))
    }

    @Test
    fun `a replaced session cannot renew`() {
        granted("A")
        granted("A")
        assertEquals(SessionManager.Validation.LeaseLost, sm.touch("s1"))
        // Touching the old id does not keep the new one alive.
        clock.advanceMs(10_000)
        assertEquals(SessionManager.Validation.LeaseLost, sm.validate("s2"))
        assertEquals(SessionManager.Validation.LeaseLost, sm.touch("s1"))
    }

    @Test
    fun `different clientId gets Busy with the remaining TTL`() {
        granted("A")
        clock.advanceMs(2_650)
        assertEquals(SessionManager.HelloResult.Busy(7_350), sm.hello("B"))
        assertEquals(Session("s1", "A"), sm.current())
        assertEquals(SessionManager.Validation.Ok, sm.validate("s1"))
    }

    @Test
    fun `Busy retryAfterMs rounds up and is at least 1`() {
        granted("A")
        clock.advanceMs(9_999)
        clock.advanceNs(1)
        assertEquals(SessionManager.HelloResult.Busy(1), sm.hello("B"))
        clock.advanceNs(999_998) // TTL minus 1 ns
        assertEquals(SessionManager.HelloResult.Busy(1), sm.hello("B"))
    }

    @Test
    fun `Busy is measured from the last touch`() {
        granted("A")
        clock.advanceMs(8_000)
        assertEquals(SessionManager.Validation.Ok, sm.touch("s1"))
        clock.advanceMs(1_000)
        assertEquals(SessionManager.HelloResult.Busy(9_000), sm.hello("B"))
    }

    @Test
    fun `session is alive just before TTL and expired exactly at TTL`() {
        granted("A")
        clock.advanceMs(10_000)
        clock.advanceNs(-1)
        assertEquals(SessionManager.Validation.Ok, sm.validate("s1"))
        clock.advanceNs(1)
        assertEquals(SessionManager.Validation.LeaseLost, sm.validate("s1"))
        assertNull(sm.current())
    }

    @Test
    fun `another client is granted exactly at TTL and gets the expired session`() {
        granted("A")
        clock.advanceMs(10_000)
        val g = granted("B")
        assertEquals(Session("s2", "B"), g.session)
        assertNull(g.replaced)
        assertEquals(Session("s1", "A"), g.expired)
        assertEquals(SessionManager.Validation.LeaseLost, sm.validate("s1"))
    }

    @Test
    fun `same client after expiry is a fresh grant, not a replace`() {
        granted("A")
        clock.advanceMs(12_000)
        val g = granted("A")
        assertNull(g.replaced)
        assertEquals(Session("s1", "A"), g.expired)
    }

    @Test
    fun `touch extends the lease`() {
        granted("A")
        clock.advanceMs(9_000)
        assertEquals(SessionManager.Validation.Ok, sm.touch("s1"))
        clock.advanceMs(9_000)
        assertEquals(SessionManager.Validation.Ok, sm.validate("s1"))
        clock.advanceMs(1_000) // exactly TTL after the touch
        assertEquals(SessionManager.Validation.LeaseLost, sm.validate("s1"))
    }

    @Test
    fun `touch does not revive an expired session`() {
        granted("A")
        clock.advanceMs(10_000)
        assertEquals(SessionManager.Validation.LeaseLost, sm.touch("s1"))
        clock.advanceMs(-5_000) // even if time were to go back, the session stays gone
        assertEquals(SessionManager.Validation.LeaseLost, sm.validate("s1"))
        assertNull(sm.current())
    }

    @Test
    fun `validate does not renew`() {
        granted("A")
        clock.advanceMs(9_000)
        assertEquals(SessionManager.Validation.Ok, sm.validate("s1"))
        clock.advanceMs(1_000)
        assertEquals(SessionManager.Validation.LeaseLost, sm.validate("s1"))
    }

    @Test
    fun `unknown session id is LeaseLost`() {
        assertEquals(SessionManager.Validation.LeaseLost, sm.validate("nope"))
        assertEquals(SessionManager.Validation.LeaseLost, sm.touch("nope"))
        granted("A")
        assertEquals(SessionManager.Validation.LeaseLost, sm.validate("nope"))
    }

    @Test
    fun `default ttl is 10 s and session ids are UUIDs`() {
        val m = SessionManager(clock)
        assertEquals(10_000L, m.ttlMs)
        val g = m.hello("A") as SessionManager.HelloResult.Granted
        java.util.UUID.fromString(g.session.sessionId)
    }

    @Test
    fun `concurrent hellos from different clients grant exactly one`() {
        val m = SessionManager(clock)
        val threads = 32
        val pool = Executors.newFixedThreadPool(threads)
        val start = CountDownLatch(1)
        val grants = AtomicInteger()
        val busy = AtomicInteger()
        repeat(threads) { i ->
            pool.execute {
                start.await()
                when (m.hello("client-$i")) {
                    is SessionManager.HelloResult.Granted -> grants.incrementAndGet()
                    is SessionManager.HelloResult.Busy -> busy.incrementAndGet()
                }
            }
        }
        start.countDown()
        pool.shutdown()
        assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
        assertEquals(1, grants.get())
        assertEquals(threads - 1, busy.get())
    }

    @Test
    fun `concurrent same-client hellos form one replacement chain`() {
        val m = SessionManager(clock)
        val threads = 32
        val pool = Executors.newFixedThreadPool(threads)
        val start = CountDownLatch(1)
        val results = java.util.concurrent.ConcurrentLinkedQueue<SessionManager.HelloResult.Granted>()
        repeat(threads) {
            pool.execute {
                start.await()
                results += m.hello("A") as SessionManager.HelloResult.Granted
            }
        }
        start.countDown()
        pool.shutdown()
        assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
        // Every session but the current one was replaced exactly once.
        val replaced = results.mapNotNull { it.replaced?.sessionId }
        assertEquals(threads - 1, replaced.size)
        assertEquals(threads - 1, replaced.toSet().size)
        val current = m.current()!!.sessionId
        assertTrue(current !in replaced)
        assertEquals(results.map { it.session.sessionId }.toSet() - current, replaced.toSet())
    }

    @Test
    fun `connected only while the control socket is open, the lease outlives it`() {
        val g = granted("A")
        assertNull(sm.connected())
        sm.socketOpened("s1")
        assertEquals(g.session, sm.connected())
        // a reconnect: the new socket opens before the old close is seen
        sm.socketOpened("s1")
        sm.socketClosed("s1")
        assertEquals(g.session, sm.connected())
        sm.socketClosed("s1")
        assertNull(sm.connected())
        assertEquals(g.session, sm.current()) // still leased to A for the TTL
        clock.advanceMs(10_000L)
        assertNull(sm.current())
        sm.socketClosed("s1") // a stray close is harmless
        assertNull(sm.connected())
    }
}
