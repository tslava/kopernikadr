package pl.slava.kopernikadr.remote.native

import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * One camera capture file per `takePhoto` request (`<dir>/photo-<uuid>.jpg`), remembered by the
 * request's callback id. A result consumes exactly its own file, so a cancelled request whose import
 * is still queued can never take (or delete) the photo of a newer one.
 */
class CaptureFiles(private val dir: File) {
    private val byCall = ConcurrentHashMap<String, File>()

    /** A fresh, not yet existing file for [callId] (the directory is created). */
    fun newFor(callId: String): File {
        dir.mkdirs()
        val file = File(dir, "photo-${UUID.randomUUID()}.jpg")
        byCall.put(callId, file)?.delete() // a reused id: its older file is dead
        return file
    }

    /** Removes and returns the file of [callId]; null if there is none (unknown or already consumed). */
    fun take(callId: String?): File? = if (callId == null) null else byCall.remove(callId)

    /** Forgets [callId] and deletes its file. */
    fun discard(callId: String?) {
        take(callId)?.delete()
    }

    fun pending(): Int = byCall.size
}
