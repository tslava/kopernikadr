package pl.slava.kopernikadr.remote.native

import java.io.File
import java.io.IOException

/**
 * Resolves app-relative paths (`tmp/x.jpg`, `projects/p/project.json`) under [root]
 * (`filesDir/kopernikadr/`, ARCHITECTURE §5.4). Rejects empty, absolute, `.`/`..`/empty segments,
 * backslashes and NUL, and anything whose canonical path (symlinks resolved) leaves [root].
 */
class PathGuard(root: File) {
    /** Canonical root; it need not exist yet. */
    val root: File = root.canonicalFile

    /** @return the canonical file for [rel], strictly inside [root]. */
    fun resolve(rel: String): File {
        if (rel.isEmpty()) invalid(rel, "empty")
        if ('\u0000' in rel) invalid(rel, "NUL")
        if ('\\' in rel) invalid(rel, "backslash")
        if (rel.startsWith('/') || File(rel).isAbsolute) invalid(rel, "absolute")
        for (segment in rel.split('/')) {
            if (segment.isEmpty() || segment == "." || segment == "..") invalid(rel, "bad segment '$segment'")
        }
        val file = try {
            File(root, rel).canonicalFile
        } catch (e: IOException) {
            invalid(rel, "cannot canonicalize: ${e.message}")
        }
        if (!file.path.startsWith(root.path + File.separator)) invalid(rel, "escapes the app root")
        return file
    }

    private fun invalid(rel: String, why: String): Nothing =
        raise(NativeErrorCode.PATH_INVALID, "invalid path '${rel.replace("\u0000", "\\0")}': $why")

    companion object {
        /** The guard for `filesDir/kopernikadr/`. */
        fun forFilesDir(filesDir: File) = PathGuard(File(filesDir, AppDirs.ROOT))
    }
}
