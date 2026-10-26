package pl.slava.kopernikadr.camera.server

import java.util.UUID

/** Monotonic time source for session expiry (`System.nanoTime()` in production). */
fun interface MonotonicClock {
    fun nanos(): Long

    companion object {
        val SYSTEM = MonotonicClock { System.nanoTime() }
    }
}

data class Session(val sessionId: String, val clientId: String)

/**
 * The one controlling session (PROTOCOL.md §4). A session is alive while
 * `now - lastSeen < ttl`; it expires **exactly at** TTL. Once replaced or expired, a session is
 * gone for good: [touch] does not revive it. Thread-safe.
 */
class SessionManager(
    private val clock: MonotonicClock = MonotonicClock.SYSTEM,
    val ttlMs: Long = DEFAULT_TTL_MS,
    private val newSessionId: () -> String = { UUID.randomUUID().toString() },
) {
    sealed interface HelloResult {
        /**
         * A new session. The caller closes the sockets of [replaced] (same client) with 4001 and
         * those of [expired] (lapsed, not yet superseded) with 4002. At most one is non-null.
         */
        data class Granted(val session: Session, val replaced: Session?, val expired: Session?) : HelloResult

        /** Another client holds a live session; it lapses in [retryAfterMs] (≥ 1) unless renewed. */
        data class Busy(val retryAfterMs: Long) : HelloResult
    }

    sealed interface Validation {
        data object Ok : Validation
        data object LeaseLost : Validation
    }

    private class Current(val session: Session, var lastSeen: Long)

    private val lock = Any()
    private val ttlNanos = ttlMs * 1_000_000L
    private var current: Current? = null

    /** The current session after it lapsed, until a new grant reports it. */
    private var lapsed: Session? = null

    fun hello(clientId: String): HelloResult = synchronized(lock) {
        val now = clock.nanos()
        expireIfDue(now)
        val cur = current
        if (cur != null && cur.session.clientId != clientId) {
            val remaining = ttlNanos - (now - cur.lastSeen)
            return HelloResult.Busy(ceilDiv(remaining, 1_000_000L).coerceAtLeast(1))
        }
        val session = Session(newSessionId(), clientId)
        val expired = lapsed
        lapsed = null
        current = Current(session, now)
        HelloResult.Granted(session, replaced = cur?.session, expired = expired)
    }

    /** Renews the lease if [sessionId] is the live current session. */
    fun touch(sessionId: String): Validation = synchronized(lock) {
        val now = clock.nanos()
        val cur = live(sessionId, now) ?: return Validation.LeaseLost
        cur.lastSeen = now
        Validation.Ok
    }

    /** Checks [sessionId] without renewing it. */
    fun validate(sessionId: String): Validation = synchronized(lock) {
        if (live(sessionId, clock.nanos()) != null) Validation.Ok else Validation.LeaseLost
    }

    /** The live current session, if any. */
    fun current(): Session? = synchronized(lock) {
        expireIfDue(clock.nanos())
        current?.session
    }

    private fun live(sessionId: String, now: Long): Current? {
        expireIfDue(now)
        return current?.takeIf { it.session.sessionId == sessionId }
    }

    private fun expireIfDue(now: Long) {
        val cur = current ?: return
        if (now - cur.lastSeen >= ttlNanos) {
            lapsed = cur.session
            current = null
        }
    }

    private fun ceilDiv(a: Long, b: Long): Long = -Math.floorDiv(-a, b)

    companion object {
        const val DEFAULT_TTL_MS = 10_000L
    }
}
