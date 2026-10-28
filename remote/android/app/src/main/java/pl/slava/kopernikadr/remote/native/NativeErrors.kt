package pl.slava.kopernikadr.remote.native

import java.io.IOException

/** Stable error codes; the Capacitor bridge passes them to `call.reject(message, code)`. */
enum class NativeErrorCode {
    /** Not a safe path relative to `filesDir/kopernikadr/`, or the target is a directory. */
    PATH_INVALID,

    /** A malformed argument (negative size/position, bad sha256, same tmp and dest, bad id). */
    BAD_ARGUMENT,

    /** `installFile`: neither a tmp file nor a valid dest exists. */
    NOT_FOUND,

    /** `installFile`: the tmp file's size or sha256 differs from the expected one. */
    CHECKSUM_MISMATCH,

    /** ENOSPC, or the free space is below the writer's reserve. */
    NO_SPACE,

    /** Unknown video handle, or the operation needs a different handle state. */
    BAD_HANDLE,

    /** The video handle was closed or aborted (or its close failed). */
    CLOSED,

    /** Any other I/O failure. */
    IO,

    /** The user backed out of the camera or picker, or it returned nothing. */
    CANCELLED,

    /** No app on the tablet handles the camera or picker intent. */
    NO_APP,

    /** A picked image is over the byte cap. */
    TOO_LARGE,

    /** Not a jpeg, png, webp, heic or heif image. */
    UNSUPPORTED,

    /** The segmenter failed to run (both delegates). */
    SEG_FAILED,

    /** The segmenter model asset is not in the APK. */
    MODEL_MISSING,

    /** Unknown or closed segmenter session handle. */
    NO_SESSION,
}

class NativeException(val code: NativeErrorCode, message: String, cause: Throwable? = null) : Exception(message, cause)

internal fun raise(code: NativeErrorCode, message: String): Nothing = throw NativeException(code, message)

/** True if [t] or one of its causes reports ENOSPC (JVM and Android message forms). */
internal fun isNoSpace(t: Throwable): Boolean {
    var e: Throwable? = t
    var depth = 0
    while (e != null && depth++ < 10) {
        val m = e.message.orEmpty()
        if ("ENOSPC" in m || "No space left on device" in m) return true
        e = e.cause
    }
    return false
}

/** Runs [block], mapping [IOException] to [NativeErrorCode.NO_SPACE] or [NativeErrorCode.IO]. */
internal inline fun <T> io(what: String, block: () -> T): T =
    try {
        block()
    } catch (e: IOException) {
        val code = if (isNoSpace(e)) NativeErrorCode.NO_SPACE else NativeErrorCode.IO
        throw NativeException(code, "$what: ${e.message ?: e.javaClass.simpleName}", e)
    }
