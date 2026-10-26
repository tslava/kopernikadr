package pl.slava.kopernikadr.camera.spool

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption

/**
 * fsync of a directory: `Os.open(dir, O_RDONLY)` + `Os.fsync` (primary); falls back to
 * `FileChannel.force` on the directory. Logs once which path worked.
 */
class AndroidDirSync(private val log: (String) -> Unit = { Log.i(TAG, it) }) : DirSync {
    @Volatile
    private var reported: String? = null

    override fun sync(dir: File) {
        val path = try {
            val fd = Os.open(dir.path, OsConstants.O_RDONLY, 0)
            try {
                Os.fsync(fd)
            } finally {
                Os.close(fd)
            }
            "Os.open+fsync"
        } catch (e: ErrnoException) {
            FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
            "FileChannel.force (Os path failed: ${e.message})"
        }
        if (reported != path) {
            reported = path
            log("dir sync via $path")
        }
    }

    private companion object {
        const val TAG = "DirSync"
    }
}
