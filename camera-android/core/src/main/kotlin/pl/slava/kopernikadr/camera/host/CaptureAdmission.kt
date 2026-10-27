package pl.slava.kopernikadr.camera.host

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import pl.slava.kopernikadr.camera.protocol.CaptureArgs
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.ProtocolError

/**
 * The app-side `capture` admission checks (ARCHITECTURE §4.5), run by `SpoolCaptureService`
 * after dedup / single flight under the admission mutex:
 *
 * 1. `args.rotation` ≠ the controls' project rotation → `GEOMETRY_MISMATCH`;
 * 2. the camera is not bound and open → `CAMERA_NOT_READY` (retryable);
 * 3. free − [minFreeBytes] < 2 × the expected `full` size → [reclaim] acked frames (oldest first)
 *    and look again; still short → `STORAGE_LOW`;
 * 4. a lock is settling → wait up to [settleTimeoutMs] for `settling == false`, else
 *    `CAMERA_NOT_READY` (retryable).
 */
class CaptureAdmission(
    private val controls: Flow<Controls>,
    private val currentControls: () -> Controls,
    private val cameraReady: () -> Boolean,
    private val freeBytes: () -> Long,
    private val settleTimeoutMs: Long = SETTLE_TIMEOUT_MS,
    private val minFreeBytes: Long = MIN_FREE_BYTES,
    /** Expected size of the next `full` (the spool's recent maximum); 0 = just the reserve. */
    private val expectedFullBytes: () -> Long = { 0L },
    /** Frees space by reclaiming acked frames until at least `needFreeBytes` are free (or none is left). */
    private val reclaim: suspend (needFreeBytes: Long) -> Unit = {},
) {
    suspend fun check(args: CaptureArgs): ProtocolError? {
        val c = currentControls()
        if (args.rotation != c.rotation) {
            return ProtocolError(
                ErrorCodes.GEOMETRY_MISMATCH,
                "capture rotation ${args.rotation} differs from the camera's project rotation ${c.rotation}",
            )
        }
        if (!cameraReady()) return ProtocolError(ErrorCodes.CAMERA_NOT_READY, "camera is not open")
        val need = minFreeBytes + 2 * expectedFullBytes()
        var free = freeBytes()
        if (free < need) {
            reclaim(need)
            free = freeBytes()
        }
        if (free < need) {
            return ProtocolError(ErrorCodes.STORAGE_LOW, "only ${free / 1_000_000} MB free (need ${need / 1_000_000} MB)")
        }
        if (c.settling) {
            val settled = withTimeoutOrNull(settleTimeoutMs) { controls.first { !it.settling } }
            if (settled == null) return ProtocolError(ErrorCodes.CAMERA_NOT_READY, "locks still settling after $settleTimeoutMs ms")
        }
        return null
    }

    companion object {
        const val SETTLE_TIMEOUT_MS = 1_500L
        const val MIN_FREE_BYTES = 500L * 1_000_000
    }
}
