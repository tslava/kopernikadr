package pl.slava.kopernikadr.camera.spool

/**
 * Frees disk by reclaiming **acked** frames, oldest `ackedAt` first: when capture admission lacks
 * space ([reclaimUntil]) and periodically for frames acked [AGE_MS] ago or earlier ([reclaimAged]).
 * Unacked frames and other clients' frames are never candidates: [Spool.nextReclaimable] only
 * returns acked ones, and a frame is acked by its own client only.
 *
 * Per frame: `reclaimedAt` is written and committed first ([Spool.markReclaimed]), then the files
 * are deleted while holding the frame's exclusive lock in [DerivedFiles], so a `play`/`thumb`
 * generation of that frame either finished before (and its output is deleted too) or sees the
 * mark and writes nothing. A crash in between is finished by [Spool.recover].
 *
 * Every pass holds one reclaimer-level lock: [Spool.failedDeletes] is shared state, so an age pass
 * and a low-space pass must not interleave.
 */
class SpoolReclaimer(
    private val spool: Spool,
    private val derived: DerivedFiles,
    private val freeBytes: () -> Long,
    private val log: (String) -> Unit = {},
    /** Test hook: runs after `reclaimedAt` is committed and before the files are deleted. */
    private val beforeDelete: (frameId: String) -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val passLock = Any()

    /**
     * Reclaims acked frames until `freeBytes() >= neededFree` or none is left.
     * @return the number of frames reclaimed.
     */
    fun reclaimUntil(neededFree: Long): Int = synchronized(passLock) {
        pass(ackedAtMax = null) { freeBytes() < neededFree }
    }

    /**
     * Reclaims every acked frame whose `ackedAt` is at or before now - [AGE_MS] (any client), oldest
     * first. With a clock earlier than a frame's `ackedAt` that frame is not reclaimed.
     * @return the number of frames reclaimed.
     */
    fun reclaimAged(): Int = synchronized(passLock) {
        val cutoff = now() - AGE_MS
        val n = pass(ackedAtMax = cutoff) { true }
        log("age reclaim: $n frame(s) acked at or before $cutoff")
        n
    }

    private fun pass(ackedAtMax: Long?, wanted: () -> Boolean): Int {
        var n = 0
        while (wanted()) {
            val next = spool.nextReclaimable(ackedAtMax) ?: break
            if (!spool.markReclaimed(next.frameId)) continue
            beforeDelete(next.frameId)
            var freed = 0L
            var failed: List<String> = emptyList()
            derived.withFrameExclusive(next.frameId) {
                spool.failedDeletes.clear()
                freed = spool.deleteFiles(next.frameId)
                failed = spool.failedDeletes.toList()
            }
            if (failed.isNotEmpty()) {
                // the row stays marked (recover retries the delete); nothing was freed for it, so stop here
                log("reclaim of ${next.frameId} failed to delete $failed; stopping")
                break
            }
            n++
            log("reclaimed ${next.frameId} ($freed B)")
        }
        return n
    }

    companion object {
        /** An acked frame is kept this long before the periodic pass may reclaim it. */
        const val AGE_MS = 7L * 24 * 60 * 60 * 1000
    }
}
