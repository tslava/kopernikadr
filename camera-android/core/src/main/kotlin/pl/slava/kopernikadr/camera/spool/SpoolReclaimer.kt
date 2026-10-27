package pl.slava.kopernikadr.camera.spool

/**
 * Frees disk by reclaiming **acked** frames, oldest `ackedAt` first, and only when asked to
 * (capture admission lacks space; no timer). Unacked frames and other clients' frames are never
 * candidates: [Spool.nextReclaimable] only returns acked ones, and a frame is acked by its own
 * client only.
 *
 * Per frame: `reclaimedAt` is written and committed first ([Spool.markReclaimed]), then the files
 * are deleted while holding the frame's exclusive lock in [DerivedFiles], so a `play`/`thumb`
 * generation of that frame either finished before (and its output is deleted too) or sees the
 * mark and writes nothing. A crash in between is finished by [Spool.recover].
 */
class SpoolReclaimer(
    private val spool: Spool,
    private val derived: DerivedFiles,
    private val freeBytes: () -> Long,
    private val log: (String) -> Unit = {},
    /** Test hook: runs after `reclaimedAt` is committed and before the files are deleted. */
    private val beforeDelete: (frameId: String) -> Unit = {},
) {
    /**
     * Reclaims acked frames until `freeBytes() >= neededFree` or none is left.
     * @return the number of frames reclaimed.
     */
    fun reclaimUntil(neededFree: Long): Int {
        var n = 0
        while (freeBytes() < neededFree) {
            val next = spool.nextReclaimable() ?: break
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
}
