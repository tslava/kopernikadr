package pl.slava.kopernikadr.remote.native

/**
 * The `KopernikadrNative` API (`remote/lib/native.ts`) over plain arguments and results, so the
 * whole bridge contract is JVM-testable. [KopernikadrNativePlugin] only adapts `PluginCall` to
 * [BridgeArgs], runs these off the main thread and turns the result map into a `JSObject`.
 * Not thread-safe by itself; the plugin calls it from one thread.
 */
class NativeApi(
    private val files: AtomicFiles,
    private val writer: VideoWriter,
    private val gallery: GalleryPublisher,
    private val log: (String) -> Unit = {},
) {
    fun writeTextAtomic(a: BridgeArgs): Map<String, Any> {
        files.writeTextAtomic(a.string("path"), a.string("text"))
        return emptyMap()
    }

    fun installFile(a: BridgeArgs): Map<String, Any> {
        val r = files.installFile(a.string("tmp"), a.string("dest"), a.long("bytes"), a.string("sha256"))
        return mapOf("result" to r.name)
    }

    fun freeBytes(a: BridgeArgs): Map<String, Any> = mapOf("bytes" to files.freeBytes(a.optString("path")))

    fun videoOpen(@Suppress("UNUSED_PARAMETER") a: BridgeArgs): Map<String, Any> {
        val h = writer.open()
        return mapOf("handle" to h.id, "path" to h.relPath)
    }

    fun videoWriteAt(a: BridgeArgs): Map<String, Any> {
        val handle = a.string("handle")
        val position = a.long("position")
        writer.writeAt(handle, position, a.base64("data"))
        return emptyMap()
    }

    fun videoClose(a: BridgeArgs): Map<String, Any> {
        writer.close(a.string("handle"))
        return emptyMap()
    }

    /** Needs a closed handle. After the gallery copy succeeds the temp file is deleted (`abort`). */
    fun videoPublish(a: BridgeArgs): Map<String, Any> {
        val handle = a.string("handle")
        val displayName = a.string("displayName")
        val uri = gallery.publish(writer.closedFile(handle), displayName)
        try {
            writer.abort(handle)
        } catch (e: NativeException) {
            // Published already; the leftover temp file goes with the next videoCleanupAbandoned.
            log("videoPublish: temp cleanup failed for '$handle': ${e.message}")
        }
        return mapOf("uri" to uri)
    }

    fun videoAbort(a: BridgeArgs): Map<String, Any> {
        writer.abort(a.string("handle"))
        return emptyMap()
    }

    fun videoCleanupAbandoned(@Suppress("UNUSED_PARAMETER") a: BridgeArgs): Map<String, Any> =
        mapOf("deletedFiles" to writer.cleanupAbandoned(), "deletedRows" to gallery.cleanupAbandoned())

    /** Debug builds only (the plugin checks): a pending gallery row as a killed publish leaves it. */
    fun testInsertPending(a: BridgeArgs): Map<String, Any> =
        mapOf("uri" to gallery.insertPendingForTest(a.optString("displayName") ?: "test-pending"))
}
