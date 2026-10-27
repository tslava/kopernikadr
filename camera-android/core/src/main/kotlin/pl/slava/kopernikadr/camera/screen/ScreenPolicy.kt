package pl.slava.kopernikadr.camera.screen

import java.util.concurrent.atomic.AtomicLong

/**
 * When the phone's screen dims (ARCHITECTURE ScreenPolicy). Pure: the caller feeds events and asks
 * [shouldDim] on a timer; the window brightness is applied elsewhere.
 *
 * Activity is a touch or a remote command (capture, controls, session open). The preview stream is not
 * activity, so the caller must not report it. The waiting card with the QR never dims (a parent may be
 * about to scan it); showing or hiding it counts as activity, so the idle time starts when it goes away.
 * Thread-safe: activity arrives from server threads, [shouldDim] is read on the main thread.
 */
class ScreenPolicy(
    private val clock: () -> Long,
    private val idleMs: Long = DEFAULT_IDLE_MS,
) {
    private val lastActivity = AtomicLong(clock())

    @Volatile
    private var qrShown = false

    /** A touch or a remote command. Dim is lifted on the next [shouldDim]. */
    fun onActivity() {
        lastActivity.set(clock())
    }

    /** The activity was paused and resumed: start bright with a fresh timer. */
    fun onResume() = onActivity()

    fun setQrShown(shown: Boolean) {
        if (qrShown == shown) return
        qrShown = shown
        onActivity()
    }

    fun shouldDim(): Boolean = !qrShown && clock() - lastActivity.get() >= idleMs

    companion object {
        const val DEFAULT_IDLE_MS = 2L * 60 * 1000
    }
}
