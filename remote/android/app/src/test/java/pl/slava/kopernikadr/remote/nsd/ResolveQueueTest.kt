package pl.slava.kopernikadr.remote.nsd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import pl.slava.kopernikadr.remote.nsd.ResolveQueue.Outcome

private const val ALREADY_ACTIVE = 3
private const val BAD_PARAMETERS = 4

class ResolveQueueTest {
    /** Started resolves, completed by the test via [complete]. */
    private val started = ArrayList<Pair<String, (Outcome<String>) -> Unit>>()
    private val delayed = ArrayList<Pair<Long, () -> Unit>>()
    private val log = ArrayList<String>()

    private val queue = ResolveQueue<String, String>(
        resolver = { item, done -> started += item to done },
        schedule = { ms, action -> delayed += ms to action },
        onResolved = { key, value -> log += "ok $key=$value" },
        onFailed = { key, code, attempts -> log += "fail $key code=$code attempts=$attempts" },
        isRetryable = { it == ALREADY_ACTIVE },
        maxAttempts = 3,
        retryDelayMs = 500,
    )

    private fun complete(i: Int, outcome: Outcome<String>) = started[i].second(outcome)

    private fun runDelayed() {
        val due = delayed.toList()
        delayed.clear()
        due.forEach { it.second() }
    }

    @Test
    fun `resolves one at a time, in order`() {
        queue.enqueue("a", "A")
        queue.enqueue("b", "B")
        queue.enqueue("c", "C")
        assertEquals(listOf("A"), started.map { it.first })
        assertEquals("a", queue.inProgress)
        assertEquals(listOf("b", "c"), queue.waiting)

        complete(0, Outcome.Ok("a1"))
        assertEquals(listOf("A", "B"), started.map { it.first })
        complete(1, Outcome.Ok("b1"))
        complete(2, Outcome.Ok("c1"))
        assertEquals(listOf("ok a=a1", "ok b=b1", "ok c=c1"), log)
        assertNull(queue.inProgress)
    }

    @Test
    fun `a waiting key enqueued again is replaced, a running one is resolved again`() {
        queue.enqueue("a", "A1")
        queue.enqueue("b", "B1")
        queue.enqueue("b", "B2")
        queue.enqueue("a", "A2")
        assertEquals(listOf("b", "a"), queue.waiting)
        complete(0, Outcome.Ok("x"))
        complete(1, Outcome.Ok("y"))
        complete(2, Outcome.Ok("z"))
        assertEquals(listOf("A1", "B2", "A2"), started.map { it.first })
    }

    @Test
    fun `ALREADY_ACTIVE is retried after the delay, holding the queue, then succeeds`() {
        queue.enqueue("a", "A")
        queue.enqueue("b", "B")
        complete(0, Outcome.Failed(ALREADY_ACTIVE))
        assertEquals(1, started.size)
        assertEquals(listOf(500L), delayed.map { it.first })
        assertEquals("a", queue.inProgress)
        runDelayed()
        assertEquals(listOf("A", "A"), started.map { it.first })
        complete(1, Outcome.Ok("a1"))
        assertEquals(listOf("A", "A", "B"), started.map { it.first })
        assertEquals(listOf("ok a=a1"), log)
    }

    @Test
    fun `gives up after maxAttempts, a non-retryable failure at once`() {
        queue.enqueue("a", "A")
        queue.enqueue("b", "B")
        complete(0, Outcome.Failed(ALREADY_ACTIVE))
        runDelayed()
        complete(1, Outcome.Failed(ALREADY_ACTIVE))
        runDelayed()
        complete(2, Outcome.Failed(ALREADY_ACTIVE))
        assertEquals(listOf("fail a code=3 attempts=3"), log)
        complete(3, Outcome.Failed(BAD_PARAMETERS))
        assertEquals(listOf("fail a code=3 attempts=3", "fail b code=4 attempts=1"), log)
        assertEquals(emptyList<Long>(), delayed.map { it.first })
    }

    @Test
    fun `a removed running key finishes unreported and the next one starts`() {
        queue.enqueue("a", "A")
        queue.enqueue("b", "B")
        queue.remove("a")
        assertEquals(1, started.size)
        complete(0, Outcome.Ok("a1"))
        assertEquals(listOf("A", "B"), started.map { it.first })
        complete(1, Outcome.Ok("b1"))
        assertEquals(listOf("ok b=b1"), log)
    }

    @Test
    fun `remove drops a waiting key, clear drops all and cancels a pending retry`() {
        queue.enqueue("a", "A")
        queue.enqueue("b", "B")
        queue.enqueue("c", "C")
        queue.remove("b")
        assertEquals(listOf("c"), queue.waiting)
        complete(0, Outcome.Failed(ALREADY_ACTIVE))
        queue.clear()
        runDelayed()
        assertEquals(1, started.size)
        assertNull(queue.inProgress)
        assertEquals(emptyList<String>(), log)

        queue.enqueue("d", "D")
        assertEquals(listOf("A", "D"), started.map { it.first })
    }

    @Test
    fun `a resolver completing twice is a bug`() {
        queue.enqueue("a", "A")
        complete(0, Outcome.Ok("1"))
        assertThrows(IllegalStateException::class.java) { complete(0, Outcome.Ok("2")) }
    }
}
