package pl.slava.kopernikadr.remote.native

import java.io.File
import java.util.UUID

/**
 * The segmenter sessions (`segOpen` / `segRun` / `segClose`). A session is one decoded image in
 * `tmp/seg-<handle>.png`. One engine (the model is heavy, creating it costs 4-8 s on GPU) is kept for
 * the whole app run, across sessions, and is bound to the picture of the session that ran last.
 * Not thread-safe: the plugin runs everything here on its segmenter executor.
 *
 * - **Open** decodes and downsizes the source (which is deleted), creates **no** engine, and closes
 *   every other session's files (only one cut-out is made at a time) but keeps the engine.
 * - **Run** creates the engine lazily and `setImage`s it again only when the session differs from the
 *   one it is bound to (the engine releases the previous image then). GPU is tried first, guarded by a crash marker in
 *   [stateDir]: `seg-gpu-attempt` is written before the engine is created and removed when the
 *   attempt ends. A marker found at start means the last attempt killed the process, so GPU is
 *   switched off for good (`seg-gpu-disabled`). A Java exception on GPU does the same, recreates the
 *   engine on CPU, binds the image again (a fresh decode: each engine owns its image and releases it
 *   on close; MediaPipe only encodes it lazily inside `segment`) and retries once.
 * - The mask goes to `tmp/seg-<handle>.mask`, overwritten each run.
 * - **Close** is idempotent and deletes `tmp/seg-<handle>.*`; the engine stays warm. [closeIdle] closes
 *   sessions unused for [idleMs] and the engine when it was unused for [idleMs]. [closeAll] closes the
 *   sessions and the engine (camera / picker in front, destroy).
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

    private class Entry(val handle: String, val image: File, val mask: File, var lastUse: Long)

    private val sessions = LinkedHashMap<String, Entry>()
    private var engine: SegEngine? = null
    private var engineGpu = false
    private var engineLastUse = 0L

    /** The handle whose picture the [engine] currently holds. */
    private var boundTo: String? = null
    private val attemptMarker get() = File(stateDir, "seg-gpu-attempt")
    private val disabledMarker get() = File(stateDir, "seg-gpu-disabled")

    fun open(srcRel: String, maxSide: Int): Opened {
        if (!srcRel.startsWith("${AppDirs.TMP}/")) raise(NativeErrorCode.PATH_INVALID, "the source image must be in ${AppDirs.TMP}/")
        val src = guard.resolve(srcRel)
        if (!src.isFile) raise(NativeErrorCode.NOT_FOUND, "no such image: ${src.name}")
        closeSessions()
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
        engineLastUse = e.lastUse
        return RunResult("${AppDirs.TMP}/${e.mask.name}", mask.width, mask.height, e.lastUse - t0, if (engineGpu) "gpu" else "cpu")
    }

    fun close(handle: String) {
        val e = sessions.remove(handle) ?: return
        e.image.parentFile?.listFiles { f -> f.name.startsWith("seg-$handle.") }?.forEach { it.delete() }
    }

    private fun closeSessions() = sessions.keys.toList().forEach(::close)

    /** Closes every session and releases the engine and its image. */
    fun closeAll() {
        closeSessions()
        closeEngine()
    }

    /** Closes the sessions idle for [idleMs] and the engine when it is idle too; returns how many sessions. */
    fun closeIdle(): Int {
        val now = clock()
        val stale = sessions.values.filter { now - it.lastUse >= idleMs }.map { it.handle }
        stale.forEach(::close)
        if (engine != null && now - engineLastUse >= idleMs) closeEngine()
        return stale.size
    }

    private fun segment(e: Entry, strokes: List<SegStroke>): SegMask {
        val gpu = if (engine != null) engineGpu else wantGpu()
        try {
            return runOn(e, gpu, strokes)
        } catch (x: NativeException) {
            throw x
        } catch (x: Throwable) {
            closeEngine()
            if (!gpu) throw NativeException(NativeErrorCode.SEG_FAILED, "segmentation failed: ${x.message}", x)
            log("segmenter: GPU failed, falling back to CPU: $x")
            disableGpu("exception")
        }
        try {
            return runOn(e, false, strokes)
        } catch (x: NativeException) {
            throw x
        } catch (x: Throwable) {
            closeEngine()
            throw NativeException(NativeErrorCode.SEG_FAILED, "segmentation failed: ${x.message}", x)
        }
    }

    /** One attempt on [gpu] or CPU: creates the engine if there is none, then runs the strokes. */
    private fun runOn(e: Entry, gpu: Boolean, strokes: List<SegStroke>): SegMask {
        val fresh = engine == null
        if (fresh && gpu) runCatching { stateDir.mkdirs(); attemptMarker.writeText("1") }
        try {
            val eng = engine ?: engines.create(gpu).also {
                engine = it
                engineGpu = gpu
                boundTo = null
            }
            if (boundTo != e.handle) {
                boundTo = null
                eng.setImage(e.image) // a failure is handled by the caller: it closes the engine
                boundTo = e.handle
            }
            return eng.segment(strokes)
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

    private fun closeEngine() {
        val eng = engine ?: return
        engine = null
        boundTo = null
        try {
            eng.close()
        } catch (t: Throwable) {
            log("segmenter: engine close failed: $t")
        }
    }

    companion object {
        const val IDLE_MS = 5 * 60 * 1000L
    }
}
