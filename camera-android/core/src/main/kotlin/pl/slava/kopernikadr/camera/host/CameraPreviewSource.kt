package pl.slava.kopernikadr.camera.host

import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.delay
import pl.slava.kopernikadr.camera.camera.CameraPort
import pl.slava.kopernikadr.camera.image.PreviewEncoder
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.PreviewLocks
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.server.PreviewFrameData
import pl.slava.kopernikadr.camera.server.PreviewSource

/**
 * [PreviewSource] over the analysis stream (ARCHITECTURE §4.3): every `next` encodes the next
 * analysis frame (pull — nothing is encoded while nobody waits) with the project rotation, and
 * stamps it with a strictly increasing `seq`, the wall clock and the controls' generation and
 * locks. A frame already produced for another waiter with `seq > afterSeq` at the same quality
 * is reused. Encoding failures are [log]ged and retried after [retryDelayMs]; a rebind just
 * delays the next frame ([CameraPort.withNextAnalysisFrame] waits across it).
 */
class CameraPreviewSource(
    private val camera: CameraPort,
    private val encoder: PreviewEncoder,
    private val controls: () -> Controls,
    private val clock: () -> Long = System::currentTimeMillis,
    private val retryDelayMs: Long = 250,
    private val log: (String) -> Unit = {},
) : PreviewSource {
    private class Produced(val quality: PreviewQuality, val data: PreviewFrameData)

    private val seq = AtomicLong()

    @Volatile
    private var last: Produced? = null

    override fun currentSeq(): Long = seq.get()

    override suspend fun nextFrame(quality: PreviewQuality, afterSeq: Long): PreviewFrameData {
        last?.let { if (it.quality == quality && it.data.seq > afterSeq) return it.data }
        while (true) {
            try {
                return camera.withNextAnalysisFrame { frame ->
                    val c = controls()
                    val jpeg = encoder.encode(frame, c.rotation, quality)
                    val data = PreviewFrameData(
                        jpeg = jpeg.jpeg,
                        w = jpeg.size.width,
                        h = jpeg.size.height,
                        seq = seq.incrementAndGet(),
                        ts = clock(),
                        generation = c.generation,
                        locks = PreviewLocks(c.exposure.mode, c.whiteBalance.mode, c.focus.mode),
                    )
                    last = Produced(quality, data)
                    data
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log("preview encode failed: $e")
                delay(retryDelayMs)
            }
        }
    }
}
