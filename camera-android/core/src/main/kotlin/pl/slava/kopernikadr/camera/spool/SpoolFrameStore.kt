package pl.slava.kopernikadr.camera.spool

import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.withLock
import pl.slava.kopernikadr.camera.core.Ulid
import pl.slava.kopernikadr.camera.image.StillPipeline
import pl.slava.kopernikadr.camera.server.AckResult
import pl.slava.kopernikadr.camera.server.FrameFile
import pl.slava.kopernikadr.camera.server.FramePage
import pl.slava.kopernikadr.camera.server.FrameStore
import pl.slava.kopernikadr.camera.server.FrameUnavailableException
import pl.slava.kopernikadr.camera.server.FrameVariant

/**
 * `play` / `thumb` display caches next to `full` in the spool dir, generated from `full` when
 * missing. Cache files are written atomically without fsync (§4.5 step 6).
 *
 * Right after a burst of captures the browser asks for every frame's `play` while the background
 * generator ([prefetch]) is still busy, so:
 * - **one generation per file**: a request for a file that is being generated waits for that
 *   generation (it never 404s or starts a second one);
 * - **bounded**: at most [maxParallel] generations run at once (each holds a decoded still);
 * - **requests first**: an on-demand request ([ensure]) takes the next free slot before the
 *   background does, and the background only claims a file once it holds a slot, so a request
 *   never waits behind the background backlog — at most behind the generations already running;
 * - **retried**: a failed generation is logged and retried once; a second failure throws
 *   [FrameUnavailableException] (→ 503).
 */
class DerivedFiles(
    private val spool: Spool,
    private val pipeline: StillPipeline,
    private val files: DurableFiles,
    private val maxParallel: Int = 2,
    private val log: (String) -> Unit = {},
) {
    init {
        require(maxParallel >= 1) { "maxParallel must be ≥ 1" }
    }

    /** Running generations by cache file name; the future yields the file, or null if `full` vanished. */
    private val inFlight = ConcurrentHashMap<String, CompletableFuture<File?>>()

    /**
     * Striped per-frame locks: a generation holds the read side, a reclaim ([withFrameExclusive])
     * the write side, so they never overlap for one frame.
     */
    private val frameLocks = Array(STRIPES) { ReentrantReadWriteLock() }

    private fun frameLock(frameId: String) = frameLocks[(frameId.hashCode() and Int.MAX_VALUE) % STRIPES]

    /** Runs [block] while no generation of [frameId]'s caches runs, and none starts. */
    fun <T> withFrameExclusive(frameId: String, block: () -> T): T = frameLock(frameId).writeLock().withLock(block)

    private val slots = ReentrantLock()
    private val slotFreed = slots.newCondition()
    private var busy = 0 // guarded by [slots]
    private var urgentWaiting = 0 // guarded by [slots]

    /**
     * The cache file of [variant] (`full` as is), generating it if missing, or waiting for the
     * running generation of the same file; null if `full` is gone. Blocks.
     * @throws FrameUnavailableException if the generation failed twice.
     */
    fun ensure(frameId: String, variant: FrameVariant): File? {
        if (Ulid.isValid(frameId) && spool.isReclaimed(frameId)) return null
        val full = fullOf(frameId) ?: return null
        if (variant == FrameVariant.FULL) return full
        val target = spool.file(frameId, variant)
        var failure: Throwable? = null
        repeat(ATTEMPTS) { attempt ->
            if (target.isFile) return target
            if (!full.isFile) return null
            val mine = CompletableFuture<File?>()
            val running = inFlight.putIfAbsent(target.name, mine)
            if (running != null) {
                // Someone generates this very file: wait for it. If it failed, retry ourselves.
                try {
                    return running.join()
                } catch (e: CompletionException) {
                    failure = e.cause ?: e
                    return@repeat
                }
            }
            val result = runCatching { withSlot(urgent = true) { generate(frameId, full, target, variant) } }
            // Unregister before completing: a woken waiter that retries must not find this future again.
            inFlight.remove(target.name, mine)
            result.onSuccess {
                mine.complete(it)
                return it
            }
            val e = result.exceptionOrNull()!!
            failure = e
            mine.completeExceptionally(e)
            log("derive ${target.name} failed (attempt ${attempt + 1}/$ATTEMPTS): $e")
        }
        throw FrameUnavailableException("cannot generate ${target.name}: $failure", failure)
    }

    /**
     * Background generation of [variant] if missing, at the lowest priority. Skips a file that a
     * request is already generating. Never throws: failures are logged (the next request retries).
     */
    fun prefetch(frameId: String, variant: FrameVariant) {
        if (variant == FrameVariant.FULL) return
        if (Ulid.isValid(frameId) && spool.isReclaimed(frameId)) return
        val full = fullOf(frameId) ?: return
        val target = spool.file(frameId, variant)
        repeat(ATTEMPTS) { attempt ->
            if (target.isFile || !full.isFile) return
            try {
                withSlot(urgent = false) {
                    // Claim the file only now: a request never waits for a generation that has no slot.
                    val mine = CompletableFuture<File?>()
                    if (target.isFile || inFlight.putIfAbsent(target.name, mine) != null) return
                    val result = runCatching { generate(frameId, full, target, variant) }
                    inFlight.remove(target.name, mine) // before completing, as in [ensure]
                    result.onSuccess {
                        mine.complete(it)
                        return
                    }
                    mine.completeExceptionally(result.exceptionOrNull()!!)
                    result.getOrThrow()
                }
            } catch (e: Throwable) {
                log("background derive ${target.name} failed (attempt ${attempt + 1}/$ATTEMPTS): $e")
            }
        }
    }

    private fun fullOf(frameId: String): File? {
        if (!Ulid.isValid(frameId)) return null
        return spool.file(frameId, FrameVariant.FULL).takeIf { it.isFile }
    }

    /** Generates [target] from [full] unless it exists; null if `full` vanished (reclaimed). */
    private fun generate(frameId: String, full: File, target: File, variant: FrameVariant): File? {
        // The read lock keeps a reclaim of this frame out; the mark is checked under it, so a
        // generation that starts after the mark writes nothing.
        val lock = frameLock(frameId).readLock()
        lock.lock()
        try {
            if (target.isFile) return target
            if (spool.isReclaimed(frameId)) return null
            val jpeg = try {
                full.readBytes()
            } catch (e: FileNotFoundException) {
                return null
            }
            val size = if (variant == FrameVariant.PLAY) StillPipeline.PLAY else StillPipeline.THUMB
            return files.writeAtomic(spool.dir, target.name, pipeline.derive(jpeg, size), durable = false)
        } finally {
            lock.unlock()
        }
    }

    /** Runs [block] holding one of [maxParallel] slots; [urgent] callers are served first. */
    private inline fun <T> withSlot(urgent: Boolean, block: () -> T): T {
        slots.withLock {
            if (urgent) urgentWaiting++
            try {
                while (busy >= maxParallel || (!urgent && urgentWaiting > 0)) slotFreed.await()
            } finally {
                if (urgent && --urgentWaiting == 0) slotFreed.signalAll()
            }
            busy++
        }
        try {
            return block()
        } finally {
            slots.withLock {
                busy--
                slotFreed.signalAll()
            }
        }
    }

    private companion object {
        /** A failed generation is retried once. */
        const val ATTEMPTS = 2
        const val STRIPES = 64
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
