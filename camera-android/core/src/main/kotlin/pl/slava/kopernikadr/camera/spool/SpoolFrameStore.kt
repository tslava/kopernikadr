package pl.slava.kopernikadr.camera.spool

import java.io.File
import pl.slava.kopernikadr.camera.core.Ulid
import pl.slava.kopernikadr.camera.image.StillPipeline
import pl.slava.kopernikadr.camera.server.AckResult
import pl.slava.kopernikadr.camera.server.FrameFile
import pl.slava.kopernikadr.camera.server.FramePage
import pl.slava.kopernikadr.camera.server.FrameStore
import pl.slava.kopernikadr.camera.server.FrameVariant

/**
 * `play` / `thumb` display caches next to `full` in the spool dir, generated from `full` when
 * missing. One generation at a time (bounds memory); cache files are written atomically without
 * fsync (§4.5 step 6).
 */
class DerivedFiles(
    private val spool: Spool,
    private val pipeline: StillPipeline,
    private val files: DurableFiles,
) {
    private val lock = Any()

    /** The cache file of [variant] (`full` as is), generating it if missing; null if `full` is gone. */
    fun ensure(frameId: String, variant: FrameVariant): File? {
        if (!Ulid.isValid(frameId)) return null
        val full = spool.file(frameId, FrameVariant.FULL)
        if (!full.isFile) return null
        if (variant == FrameVariant.FULL) return full
        val target = spool.file(frameId, variant)
        if (target.isFile) return target
        synchronized(lock) {
            if (target.isFile) return target
            val size = if (variant == FrameVariant.PLAY) StillPipeline.PLAY else StillPipeline.THUMB
            val bytes = pipeline.derive(full.readBytes(), size)
            return files.writeAtomic(spool.dir, target.name, bytes, durable = false)
        }
    }
}

/** [FrameStore] over the [Spool]: listing/ack from the DB, files from the spool dir. */
class SpoolFrameStore(private val spool: Spool, private val derived: DerivedFiles) : FrameStore {
    override fun listUnacked(clientId: String, afterSeq: Long?, limit: Int): FramePage =
        spool.listUnacked(clientId, afterSeq, limit)

    override fun ack(clientId: String, frameIds: List<String>): AckResult = spool.ack(clientId, frameIds)

    override fun open(frameId: String, variant: FrameVariant): FrameFile? =
        derived.ensure(frameId, variant)?.let { FrameFile.OnDisk(it) }
}
