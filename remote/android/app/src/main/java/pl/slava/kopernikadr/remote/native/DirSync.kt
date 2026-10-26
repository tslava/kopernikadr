package pl.slava.kopernikadr.remote.native

import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption

/** Makes a directory's entries (a rename, a new child) durable. */
fun interface DirSync {
    fun sync(dir: File)

    companion object {
        /** `FileChannel.open(dir, READ).force(true)`: works on the JVM; see [AndroidDirSync]. */
        val CHANNEL = DirSync { dir -> FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) } }

        /** For tests. */
        val NONE = DirSync { }
    }
}
