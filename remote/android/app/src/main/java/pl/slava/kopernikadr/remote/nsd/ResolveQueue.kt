package pl.slava.kopernikadr.remote.nsd

/**
 * Serial resolve queue for `NsdManager.resolveService` below API 34, which fails with
 * `FAILURE_ALREADY_ACTIVE` when a second resolve starts before the first one finished (two cameras
 * found at once). One resolve runs at a time; retryable failures are retried after a delay.
 *
 * Not thread-safe: every call, and every [Resolver] completion, must happen on one thread (the
 * plugin's handler thread). Keys are service instance names; enqueuing a key again while it waits
 * replaces the item, while it runs queues one more resolve (the service may have changed).
 */
class ResolveQueue<T, R>(
    private val resolver: Resolver<T, R>,
    private val schedule: (delayMs: Long, action: () -> Unit) -> Unit,
    private val onResolved: (key: String, value: R) -> Unit,
    private val onFailed: (key: String, code: Int, attempts: Int) -> Unit,
    private val isRetryable: (code: Int) -> Boolean,
    private val maxAttempts: Int = 3,
    private val retryDelayMs: Long = 500,
) {
    /** Starts one resolve of [item] and calls `done` exactly once (on the queue's thread). */
    fun interface Resolver<T, R> {
        fun resolve(item: T, done: (Outcome<R>) -> Unit)
    }

    sealed interface Outcome<out R> {
        data class Ok<R>(val value: R) : Outcome<R>
        data class Failed(val code: Int) : Outcome<Nothing>
    }

    private val pending = LinkedHashMap<String, T>()
    private var running: String? = null
    private var cancelled = false

    /** Keys waiting, in order (the running one excluded). */
    val waiting: List<String> get() = pending.keys.toList()

    /** Key of the resolve in progress (or waiting for its retry), if any. */
    val inProgress: String? get() = running

    fun enqueue(key: String, item: T) {
        pending[key] = item
        pump()
    }

    /** Drops [key]: a waiting item is removed, a running one finishes but is not reported. */
    fun remove(key: String) {
        pending.remove(key)
        if (running == key) cancelled = true
    }

    /** Drops everything; a running resolve finishes (NsdManager can't cancel it) unreported. */
    fun clear() {
        pending.clear()
        if (running != null) cancelled = true
    }

    private fun pump() {
        if (running != null) return
        val next = pending.entries.iterator()
        if (!next.hasNext()) return
        val (key, item) = next.next()
        next.remove()
        running = key
        cancelled = false
        start(key, item, 1)
    }

    private fun start(key: String, item: T, attempt: Int) {
        var completed = false
        resolver.resolve(item) { outcome ->
            check(!completed) { "resolve of '$key' completed twice" }
            completed = true
            finish(key, item, attempt, outcome)
        }
    }

    private fun finish(key: String, item: T, attempt: Int, outcome: Outcome<R>) {
        when {
            cancelled -> Unit
            outcome is Outcome.Ok -> onResolved(key, outcome.value)
            outcome is Outcome.Failed && isRetryable(outcome.code) && attempt < maxAttempts -> {
                // Stay "running" through the delay so nothing else starts in between.
                schedule(retryDelayMs) {
                    if (cancelled) done() else start(key, item, attempt + 1)
                }
                return
            }
            outcome is Outcome.Failed -> onFailed(key, outcome.code, attempt)
        }
        done()
    }

    private fun done() {
        running = null
        cancelled = false
        pump()
    }
}
