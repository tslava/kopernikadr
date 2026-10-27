package pl.slava.kopernikadr.remote.native

import android.content.ContentResolver
import android.provider.MediaStore
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream

/**
 * The MediaStore calls [GalleryPublisher] needs, on the `Video.Media` collection of the primary
 * external volume. A seam: [AndroidMediaStoreGateway] uses `ContentResolver`; JVM tests use a
 * fake. URIs are plain strings so the decision logic stays free of Android runtime classes.
 */
interface MediaStoreGateway {
    /** Inserts a row with [values] (column → String/Int). @return its content URI, or null. */
    fun insert(values: Map<String, Any>): String?

    /** `openOutputStream(uri, "w")`. @return null if the provider gave none. */
    fun openOutput(uri: String): OutputStream?

    /** Updates the row at [uri] with [values]. @return the number of rows updated. */
    fun update(uri: String, values: Map<String, Any>): Int

    /** Deletes the row at [uri] (and its file). @return the number of rows deleted. */
    fun delete(uri: String): Int

    /**
     * Queries the collection with a `Bundle` built from [queryArgs] (String, Int or
     * Array<String> values). @return the content URIs of the matching rows.
     */
    fun query(queryArgs: Map<String, Any>): List<String>
}

/**
 * Publishes a finished export into the gallery (`Movies/Kopernikadr/`, ARCHITECTURE §5.7):
 * free-space check → insert a pending row → copy → `IS_PENDING=0`. Any failure after the insert
 * deletes that row, so a failed publish leaves nothing visible. Not thread-safe; the bridge
 * serializes calls.
 *
 * @param packageName our package (`owner_package_name` of the rows we insert).
 * @param volumeDir a directory on the primary external volume, for the free-space check.
 */
class GalleryPublisher(
    private val gateway: MediaStoreGateway,
    private val packageName: String,
    private val volumeDir: File,
    private val disk: DiskSpace,
    private val reserveBytes: Long = RESERVE_BYTES,
) {
    /** Copies [file] into the gallery as [displayName] (normalized by [normalizeDisplayName]). @return the content URI. */
    fun publish(file: File, displayName: String): String {
        val name = normalizeDisplayName(displayName)
        if (!file.isFile) raise(NativeErrorCode.NOT_FOUND, "'${file.name}' does not exist")
        val size = file.length()
        val free = io("gallery free space") { disk.freeBytes(volumeDir) }
        if (free < size + reserveBytes) {
            raise(NativeErrorCode.NO_SPACE, "free $free < file $size + reserve $reserveBytes")
        }
        val uri = guarded("insert '$name'") { gateway.insert(pendingValues(name)) }
            ?: raise(NativeErrorCode.IO, "MediaStore insert returned no URI for '$name'")
        try {
            guarded("copy to '$name'") {
                val out = gateway.openOutput(uri) ?: raise(NativeErrorCode.IO, "no output stream for $uri")
                out.use {
                    val copied = file.inputStream().use { input -> input.copyTo(out, COPY_BUFFER) }
                    if (copied != size) throw IOException("copied $copied of $size bytes")
                    out.flush()
                    (out as? FileOutputStream)?.fd?.sync()
                }
            }
            val updated = guarded("publish '$name'") { gateway.update(uri, mapOf(IS_PENDING to 0)) }
            if (updated != 1) raise(NativeErrorCode.IO, "clearing IS_PENDING updated $updated rows for $uri")
            return uri
        } catch (e: Throwable) {
            try {
                gateway.delete(uri)
            } catch (d: Throwable) {
                e.addSuppressed(d)
            }
            throw e
        }
    }

    /**
     * Deletes our own pending rows (owner package + `kopernikadr-` prefix) left by a killed
     * publish. @return the number of rows deleted.
     */
    fun cleanupAbandoned(): Int = guarded("gallery cleanup") {
        gateway.query(cleanupQueryArgs()).sumOf { gateway.delete(it) }
    }

    /** A pending row with nothing written: the state a publish killed mid-copy leaves (debug/emulator check). */
    fun insertPendingForTest(displayName: String): String {
        val name = normalizeDisplayName(displayName)
        return guarded("insert '$name'") { gateway.insert(pendingValues(name)) }
            ?: raise(NativeErrorCode.IO, "MediaStore insert returned no URI for '$name'")
    }

    internal fun cleanupQueryArgs(): Map<String, Any> = mapOf(
        ContentResolver.QUERY_ARG_SQL_SELECTION to CLEANUP_SELECTION,
        ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS to arrayOf(packageName),
        MediaStore.QUERY_ARG_MATCH_PENDING to MediaStore.MATCH_INCLUDE,
    )

    private fun pendingValues(name: String): Map<String, Any> = mapOf(
        DISPLAY_NAME to name,
        MIME_TYPE to MIME_MP4,
        RELATIVE_PATH to GALLERY_DIR,
        IS_PENDING to 1,
    )

    companion object {
        const val RESERVE_BYTES: Long = 300L * 1024 * 1024
        const val NAME_PREFIX = "kopernikadr-"
        const val GALLERY_DIR = "Movies/Kopernikadr/"
        const val MIME_MP4 = "video/mp4"
        private const val MAX_NAME = 200
        private const val COPY_BUFFER = 1 shl 20

        // MediaStore.MediaColumns names (compile-time constants, inlined).
        const val DISPLAY_NAME = MediaStore.MediaColumns.DISPLAY_NAME
        const val MIME_TYPE = MediaStore.MediaColumns.MIME_TYPE
        const val RELATIVE_PATH = MediaStore.MediaColumns.RELATIVE_PATH
        const val IS_PENDING = MediaStore.MediaColumns.IS_PENDING

        const val CLEANUP_SELECTION =
            "owner_package_name = ? AND is_pending = 1 AND _display_name LIKE '$NAME_PREFIX%'"

        private val UNSAFE = Regex("[\\u0000-\\u001f\\u007f/\\\\:*?\"<>|]")

        /**
         * Trims, replaces path separators/control/reserved characters with `_`, forces the
         * `kopernikadr-` prefix and the `.mp4` extension. Blank or too long → [NativeErrorCode.BAD_ARGUMENT].
         */
        fun normalizeDisplayName(raw: String): String {
            var name = UNSAFE.replace(raw.trim(), "_")
            if (name.endsWith(".mp4", ignoreCase = true)) name = name.dropLast(4)
            if (name.startsWith(NAME_PREFIX)) name = name.removePrefix(NAME_PREFIX)
            if (name.isBlank() || name.all { it == '.' }) raise(NativeErrorCode.BAD_ARGUMENT, "displayName is blank")
            val result = "$NAME_PREFIX$name.mp4"
            if (result.length > MAX_NAME) raise(NativeErrorCode.BAD_ARGUMENT, "displayName longer than $MAX_NAME chars")
            return result
        }

        /** [io] plus: provider RuntimeExceptions (SecurityException, IllegalStateException…) → [NativeErrorCode.IO]. */
        private inline fun <T> guarded(what: String, block: () -> T): T =
            try {
                io(what, block)
            } catch (e: NativeException) {
                throw e
            } catch (e: RuntimeException) {
                throw NativeException(NativeErrorCode.IO, "$what: ${e.message ?: e.javaClass.simpleName}", e)
            }
    }
}
