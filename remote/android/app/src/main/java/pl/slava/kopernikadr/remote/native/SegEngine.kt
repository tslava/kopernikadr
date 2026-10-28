package pl.slava.kopernikadr.remote.native

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.framework.image.ByteBufferExtractor
import com.google.mediapipe.framework.image.MPImage
import com.google.mediapipe.tasks.components.containers.NormalizedKeypoint
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.interactivesegmenter.InteractiveSegmenter
import com.google.mediapipe.tasks.vision.interactivesegmenter.InteractiveSegmenterOptions
import com.google.mediapipe.tasks.vision.interactivesegmenter.Stroke
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException

/** A confidence mask as raw bytes: [bytes] is `width * height` uint8 (confidence x 255), row by row. */
class SegMask(val width: Int, val height: Int, val bytes: ByteArray)

/** One loaded segmenter, bound to one image. Any exception that is not a [NativeException] is an engine failure. */
interface SegEngine : AutoCloseable {
    /**
     * Binds the PNG [image] (the exact image the strokes refer to). The engine keeps the decoded image
     * alive until [close]: the encoder runs lazily inside [segment].
     */
    fun setImage(image: File)

    /** The decoder, for the whole stroke list (stateless per call). */
    fun segment(strokes: List<SegStroke>): SegMask

    override fun close()
}

fun interface EngineFactory {
    /** `MODEL_MISSING` as a [NativeException] when the model is not in the APK; any other exception is an engine failure. */
    fun create(gpu: Boolean): SegEngine
}

/** The MediaPipe Interactive Segmenter (`tasks-vision` 1.1.1, new stroke API) over the bundled model. */
class MediaPipeEngineFactory(private val context: Context) : EngineFactory {
    override fun create(gpu: Boolean): SegEngine {
        try {
            context.assets.open(MODEL_ASSET).close()
        } catch (e: FileNotFoundException) {
            throw NativeException(NativeErrorCode.MODEL_MISSING, "the segmenter model is not in the APK ($MODEL_ASSET)", e)
        } catch (e: IOException) {
            throw NativeException(NativeErrorCode.MODEL_MISSING, "the segmenter model cannot be read ($MODEL_ASSET)", e)
        }
        val base = BaseOptions.builder().setModelAssetPath(MODEL_ASSET)
            .setDelegate(if (gpu) Delegate.GPU else Delegate.CPU).build()
        val segmenter = InteractiveSegmenter.createFromOptions(
            context,
            InteractiveSegmenterOptions.builder().setBaseOptions(base).build(),
        )
        return MediaPipeEngine(segmenter)
    }

    companion object {
        const val MODEL_ASSET = "mediapipe/interactive_segmentation.task"
    }
}

/**
 * The MediaPipe `setImage` only keeps a reference: the encoder runs lazily inside `segment` (spike:
 * `setImage` 2-8 ms, every `segment` ~1.8 s on CPU). So the [MPImage] and its [Bitmap] must stay alive
 * for the whole engine and are released only by [close] (after the segmenter itself).
 */
private class MediaPipeEngine(private val segmenter: InteractiveSegmenter) : SegEngine {
    private var bitmap: Bitmap? = null
    private var mpImage: MPImage? = null

    override fun setImage(image: File) {
        releaseImage()
        val bmp = BitmapFactory.decodeFile(image.path) ?: throw IOException("cannot decode ${image.name}")
        try {
            val mp = BitmapImageBuilder(bmp).build()
            try {
                segmenter.setImage(mp)
            } catch (t: Throwable) {
                mp.close()
                throw t
            }
            mpImage = mp
            bitmap = bmp
        } catch (t: Throwable) {
            bmp.recycle()
            throw t
        }
    }

    private fun releaseImage() {
        val mp = mpImage
        val bmp = bitmap
        mpImage = null
        bitmap = null
        try {
            mp?.close()
        } finally {
            bmp?.recycle()
        }
    }

    override fun segment(strokes: List<SegStroke>): SegMask {
        val mpStrokes = strokes.map { s ->
            Stroke.builder()
                .setBrushMode(if (s.erase) Stroke.BrushMode.NEGATIVE else Stroke.BrushMode.POSITIVE)
                .setPoints(s.points.map { (x, y) -> NormalizedKeypoint.create(x, y) })
                .setCompleted(true)
                .build()
        }
        val mask = segmenter.segment(mpStrokes)
        try {
            val w = mask.width
            val h = mask.height
            val floats = ByteBufferExtractor.extract(mask).asFloatBuffer()
            val out = ByteArray(w * h)
            for (i in out.indices) out[i] = toByte(floats.get(i))
            return SegMask(w, h, out)
        } finally {
            mask.close()
        }
    }

    override fun close() {
        try {
            segmenter.close()
        } finally {
            releaseImage()
        }
    }

    private fun toByte(confidence: Float): Byte {
        val v = Math.round(confidence.coerceIn(0f, 1f) * 255f)
        return v.toByte()
    }
}
