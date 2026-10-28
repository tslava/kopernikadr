package pl.slava.kopernikadr.remote.native

/**
 * Maps what a camera or picker activity returned to one outcome, so the rules are JVM-testable
 * (the plugin's `@ActivityCallback` only feeds it plain values).
 */
object ActivityResults {
    // android.app.Activity.RESULT_OK / RESULT_CANCELED, spelled out to keep this class Android-free.
    const val RESULT_OK = -1
    const val RESULT_CANCELED = 0

    /** `PluginCall.CALLBACK_ID_DANGLING` (Capacitor 8): the call Capacitor restores after a process death. */
    const val CALLBACK_ID_DANGLING = "-1"

    /**
     * Whether there is a caller to answer: a null call (older Capacitor) and a restored "dangling"
     * call (Capacitor 8, its answer goes nowhere) are the same thing: discard the result.
     */
    fun callLive(present: Boolean, callbackId: String?): Boolean = present && callbackId != CALLBACK_ID_DANGLING

    enum class Outcome {
        /** No saved call: the process died while the other app was in front. Nobody to answer. */
        IGNORE,

        /** `RESULT_OK` with a usable payload (a picked uri, a non-empty photo file). */
        OK,

        /** The user backed out, or the app returned OK with nothing in it. */
        CANCELLED,

        /** No activity handles the intent (`ActivityNotFoundException` at launch). */
        NO_APP,
    }

    fun outcome(callPresent: Boolean, resultCode: Int, hasPayload: Boolean): Outcome = when {
        !callPresent -> Outcome.IGNORE
        resultCode == RESULT_OK && hasPayload -> Outcome.OK
        else -> Outcome.CANCELLED
    }

    /** The camera result: the payload is a non-empty output file, not an intent extra. */
    fun cameraOutcome(callPresent: Boolean, resultCode: Int, photoBytes: Long): Outcome =
        outcome(callPresent, resultCode, photoBytes > 0)

    /** The error to reject the call with, or null when the outcome is not an error. */
    fun errorOf(o: Outcome): NativeErrorCode? = when (o) {
        Outcome.CANCELLED -> NativeErrorCode.CANCELLED
        Outcome.NO_APP -> NativeErrorCode.NO_APP
        Outcome.IGNORE, Outcome.OK -> null
    }
}
