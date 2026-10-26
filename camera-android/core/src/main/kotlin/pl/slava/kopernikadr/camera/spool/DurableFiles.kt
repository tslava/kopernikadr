package pl.slava.kopernikadr.camera.spool

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID

/** Makes a directory's entries (a rename) durable. Android: `Os.open(dir, O_RDONLY)` + `Os.fsync`. */
fun interface DirSync {
    fun sync(dir: File)

    companion object {
        /** For tests and caches. */
        val NONE = DirSync { }
    }
}

/** Crash-safe file writes (ARCHITECTURE §4.5 step 4). */
class DurableFiles(private val dirSync: DirSync) {
    /**
     * Writes [bytes] to `dir/name` atomically: `name.<random>.tmp` → `fd.sync()` → atomic rename
     * over any existing file → [DirSync]. With [durable] false (display caches) both syncs are
     * skipped. On failure the tmp file is removed and an existing target is left untouched.
     * @return the target file.
     */
    fun writeAtomic(dir: File, name: String, bytes: ByteArray, durable: Boolean = true): File {
        val target = File(dir, name)
        val tmp = File(dir, "$name.${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.flush()
                if (durable) out.fd.sync()
            }
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: Throwable) {
            tmp.delete()
            throw e
        }
        if (durable) dirSync.sync(dir)
        return target
    }

    companion object {
        /** Lower-case hex SHA-256. */
        fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
