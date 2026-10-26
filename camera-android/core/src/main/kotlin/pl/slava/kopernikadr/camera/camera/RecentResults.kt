package pl.slava.kopernikadr.camera.camera

import kotlin.math.abs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import pl.slava.kopernikadr.camera.controls.ResultSummary

/**
 * Pairs a still with its capture result (plan "Per-still metadata").
 *
 * **Rule:** the still's `ImageProxy.imageInfo.timestamp` must equal the result's
 * `SENSOR_TIMESTAMP` exactly. Both come from the same sensor frame and the same clock, so no
 * tolerance is used: a near miss is a different frame (frames are ≥ 33 ms apart).
 *
 * **Failure mode:** no result with that timestamp arrives within the wait (the HAL reported a
 * different timestamp for the JPEG, the result was dropped, or the callback was not attached to
 * the request) → the still has no result ([Outcome.NONE]) and its exposure is unknown; nothing is
 * guessed from neighbouring frames. [nearest] tells how far off the closest candidate was, for
 * the log.
 */
object StillPairing {
    @Serializable
    enum class Outcome {
        /** Matched a result seen by the ImageCapture builder's session callback. */
        STILL_CALLBACK,

        /** Matched a result seen only by the repeating-stream callback. */
        STREAM_CALLBACK,

        /** No result with the still's timestamp. */
        NONE,
    }

    /** The newest candidate whose `timestampNs` equals [timestampNs], or null. */
    fun match(timestampNs: Long, candidates: List<ResultSummary>): ResultSummary? =
        candidates.lastOrNull { it.timestampNs == timestampNs }

    /** The candidate closest in time to [timestampNs] and its signed delta (candidate − still), or null. */
    fun nearest(timestampNs: Long, candidates: List<ResultSummary>): Pair<ResultSummary, Long>? =
        candidates.asSequence()
            .filter { it.timestampNs != null }
            .map { it to (it.timestampNs!! - timestampNs) }
            .minByOrNull { abs(it.second) }
}

/** Thread-safe ring of the last [capacity] results, with a wait for a given sensor timestamp. */
class RecentResults(private val capacity: Int) {
    init {
        require(capacity > 0) { "capacity must be > 0" }
    }

    private val lock = Any()
    private val ring = ArrayDeque<ResultSummary>(capacity)
    private var total = 0L
    private val version = MutableStateFlow(0L)

    /** Results added since the last [clear]. */
    val count: Long get() = synchronized(lock) { total }

    fun add(result: ResultSummary) {
        synchronized(lock) {
            if (ring.size == capacity) ring.removeFirst()
            ring.addLast(result)
            total++
        }
        version.update { it + 1 } // change signal for awaitTimestamp
    }

    fun clear() {
        synchronized(lock) {
            ring.clear()
            total = 0
        }
    }

    fun latest(): ResultSummary? = synchronized(lock) { ring.lastOrNull() }

    /** Oldest first. */
    fun snapshot(): List<ResultSummary> = synchronized(lock) { ring.toList() }

    fun find(timestampNs: Long): ResultSummary? = StillPairing.match(timestampNs, snapshot())

    /** The result with [timestampNs], waiting up to [timeoutMs] for it to arrive; null on timeout. */
    suspend fun awaitTimestamp(timestampNs: Long, timeoutMs: Long): ResultSummary? =
        find(timestampNs) ?: withTimeoutOrNull(timeoutMs) {
            var found: ResultSummary? = null
            version.first {
                found = find(timestampNs)
                found != null
            }
            found
        }
}

/**
 * Frame rate from the last [capacity] timestamps (ns, monotonic): `(n − 1) / (last − first)`.
 * Thread-safe.
 */
class FrameRateMeter(private val capacity: Int = 64) {
    init {
        require(capacity >= 2) { "capacity must be >= 2" }
    }

    private val lock = Any()
    private val stamps = LongArray(capacity)
    private var next = 0
    private var size = 0
    private var total = 0L

    /** Timestamps recorded since the last [reset]. */
    val count: Long get() = synchronized(lock) { total }

    fun record(timestampNs: Long) = synchronized(lock) {
        stamps[next] = timestampNs
        next = (next + 1) % capacity
        if (size < capacity) size++
        total++
    }

    fun reset() = synchronized(lock) {
        next = 0
        size = 0
        total = 0
    }

    /** Frames per second over the window, or null with fewer than 2 timestamps or a zero span. */
    fun fps(): Double? = synchronized(lock) {
        if (size < 2) return null
        val newest = stamps[(next - 1 + capacity) % capacity]
        val oldest = stamps[(next - size + capacity) % capacity]
        val span = newest - oldest
        if (span <= 0) null else (size - 1) * 1e9 / span
    }
}
