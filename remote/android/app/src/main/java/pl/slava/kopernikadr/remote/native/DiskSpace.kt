package pl.slava.kopernikadr.remote.native

import java.io.File

/** Free bytes for the filesystem holding an **existing** directory. */
fun interface DiskSpace {
    fun freeBytes(existingDir: File): Long

    companion object {
        /** `File.usableSpace` (space available to this app). An `StatFs` impl may replace it. */
        val USABLE = DiskSpace { it.usableSpace }
    }
}
