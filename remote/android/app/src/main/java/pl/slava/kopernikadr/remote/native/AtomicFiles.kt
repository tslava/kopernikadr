package pl.slava.kopernikadr.remote.native

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID

/** Low-level file steps, a seam for failure injection (ENOSPC, a failing rename) in tests. */
interface FileOps {
    fun openOutput(file: File): FileOutputStream = FileOutputStream(file)

    fun syncStream(out: FileOutputStream) = out.fd.sync()

    /** fsync of an existing file without truncating it. */
    fun syncFile(file: File) = RandomAccessFile(file, "rw").use { it.fd.sync() }

    /** `rename(2)` over any existing [to]; never deletes [to] first. */
    fun move(from: File, to: File) {
        Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    companion object {
        val DEFAULT: FileOps = object : FileOps {}
    }
}

enum class InstallResult {
    /** The tmp file was verified and renamed over dest. */
    INSTALLED,

    /** dest already had the expected size and sha256 (tmp, if any, was deleted). */
    ALREADY_INSTALLED,
}

/**
 * Crash-safe writes under `filesDir/kopernikadr/` (ARCHITECTURE §5.1). All paths are relative and
 * go through [guard]. Errors are [NativeException]s.
 */
class AtomicFiles(
    private val guard: PathGuard,
    private val dirSync: DirSync = DirSync.CHANNEL,
    private val disk: DiskSpace = DiskSpace.USABLE,
    private val ops: FileOps = FileOps.DEFAULT,
) {
    /**
     * Writes [text] (UTF-8) to [path]: tmp in the same dir → fsync → atomic rename over the target
     * → fsync dir. Missing parent dirs are created (and made durable). The target is never deleted
     * first: after any failure it holds either the old or the complete new content.
     */
    fun writeTextAtomic(path: String, text: String) {
        val target = guard.resolve(path)
        if (target.isDirectory) raise(NativeErrorCode.PATH_INVALID, "'$path' is a directory")
        val dir = target.parentFile!!
        io("writeTextAtomic '$path'") {
            ensureDir(dir)
            val tmp = File(dir, ".${target.name}.${UUID.randomUUID()}.tmp")
            try {
                ops.openOutput(tmp).use { out ->
                    val bytes = text.toByteArray(Charsets.UTF_8)
                    out.write(bytes, 0, bytes.size)
                    out.flush()
                    ops.syncStream(out)
                }
                ops.move(tmp, target)
            } catch (e: Throwable) {
                tmp.delete()
                throw e
            }
            dirSync.sync(dir)
        }
    }

    /**
     * Moves a downloaded [tmpPath] to [destPath], verified against [bytes] and [sha256]
     * (64 hex chars, any case). Idempotent, so a repeat after a crash succeeds:
     * - dest already matches → tmp deleted (if present), dest dir fsynced, [InstallResult.ALREADY_INSTALLED];
     * - otherwise tmp must match ([NativeErrorCode.NOT_FOUND] if missing,
     *   [NativeErrorCode.CHECKSUM_MISMATCH] if not; both files are left untouched) → fsync tmp →
     *   atomic rename over dest → fsync dest dir, [InstallResult.INSTALLED].
     */
    fun installFile(tmpPath: String, destPath: String, bytes: Long, sha256: String): InstallResult {
        if (bytes < 0) raise(NativeErrorCode.BAD_ARGUMENT, "bytes must be >= 0, got $bytes")
        if (!SHA256_HEX.matches(sha256)) raise(NativeErrorCode.BAD_ARGUMENT, "sha256 must be 64 hex chars")
        val expected = sha256.lowercase()
        val tmp = guard.resolve(tmpPath)
        val dest = guard.resolve(destPath)
        if (tmp == dest) raise(NativeErrorCode.BAD_ARGUMENT, "tmp and dest are the same file")
        if (dest.isDirectory) raise(NativeErrorCode.PATH_INVALID, "'$destPath' is a directory")
        val destDir = dest.parentFile!!
        return io("installFile '$tmpPath' -> '$destPath'") {
            if (matches(dest, bytes, expected)) {
                tmp.delete()
                // A crash may have hit between the rename and the dir fsync.
                dirSync.sync(destDir)
                return@io InstallResult.ALREADY_INSTALLED
            }
            if (!tmp.isFile) raise(NativeErrorCode.NOT_FOUND, "'$tmpPath' is missing and '$destPath' is not valid")
            if (!matches(tmp, bytes, expected)) {
                raise(NativeErrorCode.CHECKSUM_MISMATCH, "'$tmpPath' does not match the expected size/sha256")
            }
            ops.syncFile(tmp)
            ensureDir(destDir)
            ops.move(tmp, dest)
            dirSync.sync(destDir)
            InstallResult.INSTALLED
        }
    }

    /**
     * Free bytes on the filesystem holding [path] (the app root if null), asked of [disk] for the
     * nearest existing directory.
     */
    fun freeBytes(path: String? = null): Long {
        var dir: File? = if (path == null) guard.root else guard.resolve(path)
        while (dir != null && !dir.isDirectory) dir = dir.parentFile
        if (dir == null) raise(NativeErrorCode.IO, "no existing directory for '$path'")
        return io("freeBytes '$path'") { disk.freeBytes(dir) }
    }

    private fun ensureDir(dir: File) = ensureDirDurable(dir, dirSync)

    private fun matches(file: File, bytes: Long, sha256: String): Boolean =
        file.isFile && file.length() == bytes && sha256Of(file) == sha256

    companion object {
        private val SHA256_HEX = Regex("[0-9a-fA-F]{64}")

        /** Lower-case hex SHA-256 of a file's content. */
        fun sha256Of(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

/** Creates [dir] and missing ancestors top-down, fsyncing each new entry's parent. */
internal fun ensureDirDurable(dir: File, dirSync: DirSync) {
    val missing = generateSequence(dir) { it.parentFile }.takeWhile { !it.isDirectory }.toList().asReversed()
    for (d in missing) {
        if (!d.mkdir() && !d.isDirectory) throw IOException("cannot create directory ${d.path}")
        dirSync.sync(d.parentFile!!)
    }
}
