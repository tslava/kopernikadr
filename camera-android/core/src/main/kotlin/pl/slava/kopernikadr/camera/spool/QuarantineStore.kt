package pl.slava.kopernikadr.camera.spool

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes

/** One file of `spool/quarantine/`. */
data class QuarantineEntry(val name: String, val size: Long, val modified: Long)

/** What the parent screen shows; [entries] are newest first. */
data class QuarantineListing(val entries: List<QuarantineEntry>) {
    val count: Int get() = entries.size
    val bytes: Long get() = entries.sumOf { it.size }
}

/** [removed] files were deleted; [failed] names matched but could not be deleted. */
data class QuarantineClearResult(val removed: Int, val failed: List<String>)

/**
 * Shows and clears `spool/quarantine/`, the place where recovery moves a `full` it must not delete.
 * It is the first destructive action reachable on the kid's phone, so the rule is narrow: only
 * regular files directly inside the directory, with a name [SpoolFiles.QUARANTINED] accepts, are
 * ever listed or deleted. Directories, symlinks (never followed: the link itself is neither listed
 * nor deleted) and any other name are left alone, as is everything outside the directory.
 *
 * No lock: [Spool.recover], the only writer of the directory, runs once per process before the
 * server starts, and the parent screen is used by hand, so nothing races a clear. [clear] still
 * re-lists right before it deletes and removes only names that were listed AND still match.
 */
class QuarantineStore(spoolDir: File) {
    private val dir = File(spoolDir, SpoolFiles.QUARANTINE)

    /** The matching files, newest first (ties by name, descending). Empty when the directory is missing. */
    fun list(): QuarantineListing {
        val real = runCatching {
            Files.readAttributes(dir.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS).isDirectory
        }.getOrDefault(false)
        if (!real) return QuarantineListing(emptyList())
        val entries = dir.listFiles().orEmpty().mapNotNull { f ->
            if (!SpoolFiles.QUARANTINED.matches(f.name)) return@mapNotNull null
            val a = runCatching {
                Files.readAttributes(f.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            }.getOrNull()
            if (a == null || !a.isRegularFile) null else QuarantineEntry(f.name, a.size(), a.lastModifiedTime().toMillis())
        }
        return QuarantineListing(entries.sortedWith(compareByDescending<QuarantineEntry> { it.modified }.thenByDescending { it.name }))
    }

    /** The file of a listed entry (for a thumbnail). */
    fun file(entry: QuarantineEntry): File = File(dir, entry.name)

    /**
     * Deletes the files of [listed] that are still there and still match (a fresh listing decides),
     * so the count never exceeds what the screen showed.
     */
    fun clear(listed: List<QuarantineEntry>): QuarantineClearResult {
        val names = listed.mapTo(HashSet()) { it.name }
        var removed = 0
        val failed = ArrayList<String>()
        for (e in list().entries) {
            if (e.name !in names) continue
            val ok = runCatching { Files.delete(File(dir, e.name).toPath()) }.isSuccess
            if (ok) removed++ else failed += e.name
        }
        return QuarantineClearResult(removed, failed)
    }
}
