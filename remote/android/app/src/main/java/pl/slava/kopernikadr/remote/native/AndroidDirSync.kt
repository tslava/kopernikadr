package pl.slava.kopernikadr.remote.native

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.IOException

/**
 * Directory fsync on Android: `Os.open(dir, O_RDONLY)` + `Os.fsync`; falls back to
 * [DirSync.CHANNEL]. Logs once which path worked. Not unit-tested (needs the Android runtime).
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
            try {
                DirSync.CHANNEL.sync(dir)
            } catch (e2: IOException) {
                e2.addSuppressed(e)
                throw e2
            }
            "FileChannel.force (Os path failed: ${e.message})"
        }
        if (reported != path) {
            reported = path
            log("dir sync via $path")
        }
    }

    private companion object {
        const val TAG = "KopernikadrDirSync"
    }
}
