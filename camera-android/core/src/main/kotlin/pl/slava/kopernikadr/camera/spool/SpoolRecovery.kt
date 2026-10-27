package pl.slava.kopernikadr.camera.spool

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** What one [Spool.recover] run did. All zero on a clean spool and on a second run. */
data class RecoveryReport(
    /** `pending` rows whose `full` was complete → `committed`. */
    val committed: Int = 0,
    /** `pending` rows without a valid `full` → `failed(INTERRUPTED)`. */
    val interrupted: Int = 0,
    /** Unacked `committed` rows whose `full` is missing → `lost`. */
    val lost: Int = 0,
    /** Rows with `reclaimedAt` whose files were still there (a crash during reclaim). */
    val reclaimFinished: Int = 0,
    /** Stray cache and tmp files deleted. */
    val deleted: Int = 0,
    /** `full` files without a row (or a bad one of a `pending` row) moved to `quarantine/`. */
    val quarantined: Int = 0,
)

/** The file-name rule of recovery (plan "Spool recovery file rule"): nothing else is ever touched. */
internal object SpoolFiles {
    const val QUARANTINE = "quarantine"

    /**
     * `{ULID}.{full|play|thumb}.jpg`, optionally a tmp: `….jpg.tmp` or the `….jpg.{uuid}.tmp` that
     * `DurableFiles.writeAtomic` really writes.
     */
    val NAME = Regex(
        "^([0-9A-Z]{26})\\.(full|play|thumb)\\.jpg" +
            "(\\.tmp|\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp)?$",
    )

    /** Moves [file] into `dir/quarantine/` without overwriting anything; false if it could not. */
    fun quarantine(dir: File, file: File): Boolean {
        val q = File(dir, QUARANTINE)
        if (!q.isDirectory && !q.mkdirs()) return false
        var target = File(q, file.name)
        var n = 1
        while (target.exists()) target = File(q, "${file.name}.dup${n++}")
        return try {
            Files.move(file.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE)
            true
        } catch (e: Exception) {
            false
        }
    }
}

/** A minimal JPEG structure check (no decoding): SOI, a SOF marker with dimensions, EOI. */
object JpegCheck {
    /** (width, height) of a JPEG that starts with SOI, has a SOF marker and ends with EOI; else null. */
    fun dimensions(b: ByteArray): Pair<Int, Int>? {
        if (b.size < 4 || b[0] != 0xFF.toByte() || b[1] != 0xD8.toByte()) return null
        var end = b.size
        while (end > 2 && b[end - 1] == 0.toByte()) end-- // tolerate zero padding after EOI
        if (end < 4 || b[end - 2] != 0xFF.toByte() || b[end - 1] != 0xD9.toByte()) return null
        var i = 2
        while (i + 4 <= end) {
            if (b[i] != 0xFF.toByte()) return null
            val m = b[i + 1].toInt() and 0xFF
            if (m == 0xFF) { i++; continue }
            if (m == 0xD9 || m == 0xDA) return null // EOI / SOS before any SOF
            if (m in 0xD0..0xD7 || m == 0x01) { i += 2; continue }
            val len = ((b[i + 2].toInt() and 0xFF) shl 8) or (b[i + 3].toInt() and 0xFF)
            if (len < 2) return null
            if (m in 0xC0..0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC) {
                if (i + 9 > end) return null
                val h = ((b[i + 5].toInt() and 0xFF) shl 8) or (b[i + 6].toInt() and 0xFF)
                val w = ((b[i + 7].toInt() and 0xFF) shl 8) or (b[i + 8].toInt() and 0xFF)
                return if (w > 0 && h > 0) w to h else null
            }
            i += 2 + len
        }
        return null
    }
}
