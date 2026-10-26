package pl.slava.kopernikadr.remote.native

import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.util.UUID

/** File steps of [VideoWriter], a seam for failure injection (ENOSPC) in tests. */
interface VideoFileOps {
    fun open(file: File): RandomAccessFile = RandomAccessFile(file, "rw")

    fun sync(file: RandomAccessFile) = file.fd.sync()

    companion object {
        val DEFAULT: VideoFileOps = object : VideoFileOps {}
    }
}

/**
 * Positional writer for MP4 exports in `exports/` (ARCHITECTURE §5.7). Mediabunny's
 * `StreamTarget` writes chunks at arbitrary (out-of-order, overlapping) positions. The writer owns
 * `exports/` and never touches project metadata. Thread-safe: every call holds this writer's lock.
 *
 * Handle states: open → closed (fsynced) → aborted (file deleted). A failed close leaves the
 * handle unusable except for [abort].
 *
 * @param reserveBytes [writeAt] fails with [NativeErrorCode.NO_SPACE] unless the free space is at
 *   least the chunk size plus this reserve.
 */
class VideoWriter(
    private val guard: PathGuard,
    private val dirSync: DirSync,
    private val ids: () -> String = { UUID.randomUUID().toString() },
    private val disk: DiskSpace = DiskSpace.USABLE,
    private val reserveBytes: Long = 0,
    private val ops: VideoFileOps = VideoFileOps.DEFAULT,
) {
    /** [relPath] is relative to `filesDir/kopernikadr/`, e.g. `exports/export-<id>.mp4`. */
    data class Handle(val id: String, val relPath: String)

    private enum class State { OPEN, CLOSED, FAILED, ABORTED }

    private class Entry(val file: File, var raf: RandomAccessFile?, var state: State)

    private val entries = HashMap<String, Entry>()

    /** Creates (or truncates) `exports/export-<id>.mp4` and opens it for positional writes. */
    @Synchronized
    fun open(): Handle {
        val id = ids()
        if (!ID.matches(id)) raise(NativeErrorCode.BAD_ARGUMENT, "unsafe handle id '$id'")
        entries[id]?.let { if (it.state != State.ABORTED) raise(NativeErrorCode.BAD_ARGUMENT, "handle id '$id' is in use") }
        val rel = "${AppDirs.EXPORTS}/export-$id.mp4"
        val file = guard.resolve(rel)
        return io("videoOpen '$rel'") {
            ensureDirDurable(file.parentFile!!, dirSync)
            val raf = ops.open(file)
            try {
                raf.setLength(0)
            } catch (e: Throwable) {
                closeQuietly(raf)
                throw e
            }
            entries[id] = Entry(file, raf, State.OPEN)
            Handle(id, rel)
        }
    }

    /** Writes [bytes] at [position] (≥ 0); gaps read as zeros, overlaps take the last write. */
    @Synchronized
    fun writeAt(id: String, position: Long, bytes: ByteArray) {
        val e = entry(id)
        if (e.state != State.OPEN) raise(NativeErrorCode.CLOSED, "handle '$id' is ${e.state.name.lowercase()}")
        if (position < 0) raise(NativeErrorCode.BAD_ARGUMENT, "position must be >= 0, got $position")
        if (bytes.isEmpty()) return
        val raf = e.raf!!
        io("videoWriteAt '$id'") {
            val free = disk.freeBytes(e.file.parentFile!!)
            if (free < bytes.size + reserveBytes) {
                raise(NativeErrorCode.NO_SPACE, "free $free < chunk ${bytes.size} + reserve $reserveBytes")
            }
            raf.seek(position)
            raf.write(bytes, 0, bytes.size)
        }
    }

    /** fsync + close + fsync `exports/`. Idempotent on a closed handle. */
    @Synchronized
    fun close(id: String) {
        val e = entry(id)
        when (e.state) {
            State.CLOSED -> return
            State.FAILED, State.ABORTED -> raise(NativeErrorCode.CLOSED, "handle '$id' is ${e.state.name.lowercase()}")
            State.OPEN -> Unit
        }
        val raf = e.raf!!
        try {
            io("videoClose '$id'") {
                ops.sync(raf)
                raf.close()
                dirSync.sync(e.file.parentFile!!)
            }
            e.state = State.CLOSED
        } catch (ex: NativeException) {
            closeQuietly(raf)
            e.state = State.FAILED
            throw ex
        } finally {
            e.raf = null
        }
    }

    /** Closes the file if open and deletes it. Idempotent. */
    @Synchronized
    fun abort(id: String) {
        val e = entry(id)
        if (e.state == State.ABORTED) return
        e.raf?.let(::closeQuietly)
        e.raf = null
        io("videoAbort '$id'") { Files.deleteIfExists(e.file.toPath()) }
        e.state = State.ABORTED
    }

    /** The finished file of a closed handle (the source for the gallery publish). */
    @Synchronized
    fun closedFile(id: String): File {
        val e = entry(id)
        return when (e.state) {
            State.CLOSED -> e.file
            State.OPEN -> raise(NativeErrorCode.BAD_HANDLE, "handle '$id' is still open")
            State.FAILED, State.ABORTED -> raise(NativeErrorCode.CLOSED, "handle '$id' is ${e.state.name.lowercase()}")
        }
    }

    /**
     * Deletes every entry in `exports/` that is not the file of an open or closed handle
     * (symlinks are removed, never followed). @return the number of top-level entries deleted.
     */
    @Synchronized
    fun cleanupAbandoned(): Int {
        val dir = guard.resolve(AppDirs.EXPORTS)
        if (!dir.isDirectory) return 0
        val live = entries.values.filter { it.state == State.OPEN || it.state == State.CLOSED }.map { it.file }.toSet()
        return io("videoCleanupAbandoned") {
            var count = 0
            for (child in dir.listFiles().orEmpty()) {
                if (child in live) continue
                deleteTree(child.toPath())
                count++
            }
            count
        }
    }

    private fun entry(id: String): Entry = entries[id] ?: raise(NativeErrorCode.BAD_HANDLE, "unknown video handle '$id'")

    private companion object {
        val ID = Regex("[A-Za-z0-9_-]{1,64}")

        fun closeQuietly(raf: RandomAccessFile) {
            try {
                raf.close()
            } catch (_: Exception) {
            }
        }

        /** Deletes [p]; a real directory recursively. `Files.walk` does not follow symlinks. */
        fun deleteTree(p: Path) {
            if (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) {
                Files.walk(p).use { s -> s.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
            } else {
                Files.deleteIfExists(p)
            }
        }
    }
}
