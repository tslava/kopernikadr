package pl.slava.kopernikadr.remote.native

import java.io.File
import java.util.UUID

/**
 * The segmenter sessions (`segOpen` / `segRun` / `segClose`). A session is one decoded image in
 * `tmp/seg-<handle>.png` plus, after the first run, an engine holding it. Not thread-safe: the
 * plugin runs everything here on its segmenter executor.
 *
 * - **Open** decodes and downsizes the source (which is deleted), creates **no** engine, and closes
 *   every other session: only one cut-out is made at a time and the model is heavy.
 * - **Run** creates the engine lazily. GPU is tried first, guarded by a crash marker in
 *   [stateDir]: `seg-gpu-attempt` is written before the engine is created and removed when the
 *   attempt ends. A marker found at start means the last attempt killed the process, so GPU is
 *   switched off for good (`seg-gpu-disabled`). A Java exception on GPU does the same, recreates the
 *   engine on CPU, sets the image again and retries once.
 * - The mask goes to `tmp/seg-<handle>.mask`, overwritten each run.
 * - **Close** is idempotent and deletes `tmp/seg-<handle>.*`. [closeIdle] closes sessions unused
 *   for [idleMs].
 */
class SegSession(
    private val guard: PathGuard,
    private val loader: ImageLoader,
    private val engines: EngineFactory,
    private val stateDir: File,
    private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
    private val idleMs: Long = IDLE_MS,
    private val ids: () -> String = { UUID.randomUUID().toString() },
    private val log: (String) -> Unit = {},
) {
    class Opened(val handle: String, val image: String, val width: Int, val height: Int, val hasAlpha: Boolean)

    class RunResult(val mask: String, val width: Int, val height: Int, val ms: Long, val delegate: String)

    private class Entry(val handle: String, val image: File, val mask: File, var lastUse: Long) {
        var engine: SegEngine? = null
        var gpu = false
    }

    private val sessions = LinkedHashMap<String, Entry>()
    private val attemptMarker get() = File(stateDir, "seg-gpu-attempt")
    private val disabledMarker get() = File(stateDir, "seg-gpu-disabled")

    fun open(srcRel: String, maxSide: Int): Opened {
        if (!srcRel.startsWith("${AppDirs.TMP}/")) raise(NativeErrorCode.PATH_INVALID, "the source image must be in ${AppDirs.TMP}/")
        val src = guard.resolve(srcRel)
        if (!src.isFile) raise(NativeErrorCode.NOT_FOUND, "no such image: ${src.name}")
        closeAll()
        val handle = ids()
        val imageRel = "${AppDirs.TMP}/seg-$handle.png"
        val image = guard.resolve(imageRel)
        val loaded = try {
            loader.load(src, image, maxSide)
        } catch (e: Throwable) {
            image.delete()
            throw e
        }
        src.delete()
        sessions[handle] = Entry(handle, image, guard.resolve("${AppDirs.TMP}/seg-$handle.mask"), clock())
        return Opened(handle, imageRel, loaded.width, loaded.height, loaded.hasAlpha)
    }

    fun run(handle: String, strokes: List<SegStroke>): RunResult {
        val e = sessions[handle] ?: raise(NativeErrorCode.NO_SESSION, "no segmenter session '$handle'")
        val t0 = clock()
        val mask = segment(e, strokes)
        io("write the mask") { e.mask.writeBytes(mask.bytes) }
        e.lastUse = clock()
        return RunResult("${AppDirs.TMP}/${e.mask.name}", mask.width, mask.height, e.lastUse - t0, if (e.gpu) "gpu" else "cpu")
    }

    fun close(handle: String) {
        val e = sessions.remove(handle) ?: return
        closeEngine(e)
        e.image.parentFile?.listFiles { f -> f.name.startsWith("seg-$handle.") }?.forEach { it.delete() }
    }

    fun closeAll() = sessions.keys.toList().forEach(::close)

    /** Closes the sessions idle for [idleMs]; returns how many. */
    fun closeIdle(): Int {
        val now = clock()
        val stale = sessions.values.filter { now - it.lastUse >= idleMs }.map { it.handle }
        stale.forEach(::close)
        return stale.size
    }

    private fun segment(e: Entry, strokes: List<SegStroke>): SegMask {
        val gpu = if (e.engine != null) e.gpu else wantGpu()
        try {
            return runOn(e, gpu, strokes)
        } catch (x: NativeException) {
            throw x
        } catch (x: Throwable) {
            closeEngine(e)
            if (!gpu) throw NativeException(NativeErrorCode.SEG_FAILED, "segmentation failed: ${x.message}", x)
            log("segmenter: GPU failed, falling back to CPU: $x")
            disableGpu("exception")
        }
        try {
            return runOn(e, false, strokes)
        } catch (x: NativeException) {
            throw x
        } catch (x: Throwable) {
            closeEngine(e)
            throw NativeException(NativeErrorCode.SEG_FAILED, "segmentation failed: ${x.message}", x)
        }
    }

    /** One attempt on [gpu] or CPU: creates the engine if there is none, then runs the strokes. */
    private fun runOn(e: Entry, gpu: Boolean, strokes: List<SegStroke>): SegMask {
        val fresh = e.engine == null
        if (fresh && gpu) runCatching { stateDir.mkdirs(); attemptMarker.writeText("1") }
        try {
            if (fresh) {
                val engine = engines.create(gpu)
                try {
                    engine.setImage(e.image)
                } catch (t: Throwable) {
                    runCatching { engine.close() }
                    throw t
                }
                e.engine = engine
                e.gpu = gpu
            }
            return e.engine!!.segment(strokes)
        } finally {
            // the attempt ended (a native crash would not get here, and leaves the marker)
            if (fresh && gpu) attemptMarker.delete()
        }
    }

    private fun wantGpu(): Boolean {
        if (disabledMarker.exists()) return false
        if (attemptMarker.exists()) {
            log("segmenter: the last GPU attempt did not finish, using CPU from now on")
            disableGpu("crash")
            return false
        }
        return true
    }

    private fun disableGpu(why: String) {
        runCatching { stateDir.mkdirs(); disabledMarker.writeText(why) }
        attemptMarker.delete()
    }

    private fun closeEngine(e: Entry) {
        val engine = e.engine ?: return
        e.engine = null
        try {
            engine.close()
        } catch (t: Throwable) {
            log("segmenter: engine close failed: $t")
        }
    }

    companion object {
        const val IDLE_MS = 5 * 60 * 1000L
    }
}
