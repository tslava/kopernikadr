package pl.slava.kopernikadr.camera.camera

import android.content.Context
import android.graphics.ImageFormat
import android.graphics.PixelFormat
import android.graphics.Rect
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.util.Log
import android.util.Rational
import android.view.Surface
import androidx.annotation.MainThread
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.AspectRatio
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.ResolutionInfo
import androidx.camera.core.UseCaseGroup
import androidx.camera.core.ViewPort
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionFilter
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Observer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.completeWith
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import pl.slava.kopernikadr.camera.controls.Camera2
import pl.slava.kopernikadr.camera.controls.ResultSummary
import pl.slava.kopernikadr.camera.core.IntRect
import pl.slava.kopernikadr.camera.core.Size
import pl.slava.kopernikadr.camera.core.SizeSelection
import android.util.Size as ASize

/**
 * CameraX binding (ARCHITECTURE §4.3, plan Task 4): one [UseCaseGroup] with
 * `ViewPort(4:3, ROTATION_90)`; Preview (variant A only) + ImageAnalysis (KEEP_ONLY_LATEST) +
 * ImageCapture (in-memory JPEG, `full`), every target rotation `ROTATION_90`, so a buffer's
 * `rotationDegrees` is 0 or 180 and the 4:3 ViewPort is the full sensor-native landscape.
 *
 * Lifecycle: application-scoped object; [attach] it to the activity. It binds on every ON_START
 * and unbinds on every ON_STOP (screen lock, home), so each start is a fresh bind with its own
 * strict-bind attempt, logged under [TAG]. [onReadyChanged] is called on the main thread with
 * true when the camera of a bind reaches OPEN, and with false on unbind or when the open camera
 * closes or errors (the probe runner's `setCameraBound`).
 *
 * Bind: first strictly (`FALLBACK_RULE_NONE` for every size and aspect ratio); if CameraX rejects
 * that, again with fallbacks (analysis 1280×960 → 960×720 → closest 4:3). Requested vs resolved
 * sizes and the strict outcome are in [status] (`bind`).
 *
 * Threads: bind/unbind/[attach]/[setPreviewSurfaceProvider] on the main thread; analysis on
 * `kopernikadr-analysis`, still callbacks on `kopernikadr-capture`, capture results on CameraX's
 * camera thread. Everything in [CameraPort] may be called from any thread.
 */
// androidx (lint) opt-in: ExperimentalCamera2Interop is an androidx.annotation.RequiresOptIn marker.
@OptIn(markerClass = [ExperimentalCamera2Interop::class])
class CameraController(
    private val context: Context,
    private val onReadyChanged: (Boolean) -> Unit = {},
) : CameraPort {

    data class BindConfig(
        val variant: StreamVariant = StreamVariant.A,
        val analysisFormat: AnalysisFormat = AnalysisFormat.YUV_420_888,
    )

    /** Counters since the current bind (see [stats]). */
    data class Stats(
        val bindId: Long?,
        /** Results seen by the repeating-stream callback (Preview builder in A, analysis builder in B). */
        val streamResults: Long,
        /** Frame rate of those results (≈ preview fps in A). */
        val streamFps: Double?,
        /** Of those, results of STILL_CAPTURE requests (tells whether the callback is session-wide). */
        val streamCallbackStillResults: Long,
        /** Results seen by the ImageCapture builder's callback. */
        val stillCallbackResults: Long,
        /** Of those, results of non-still (repeating) requests. */
        val stillCallbackRepeatingResults: Long,
        val analysisFrames: Long,
        val analysisFps: Double?,
    ) {
        override fun toString(): String =
            "stream results $streamResults (${fps(streamFps)} fps, $streamCallbackStillResults still-intent), " +
                "still-callback results $stillCallbackResults ($stillCallbackRepeatingResults repeating), " +
                "analysis frames $analysisFrames (${fps(analysisFps)} fps)"

        private fun fps(v: Double?) = v?.let { String.format(java.util.Locale.ROOT, "%.1f", it) } ?: "-"
    }

    private val mainExecutor = context.mainExecutor
    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "kopernikadr-analysis") }
    private val captureExecutor: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "kopernikadr-capture") }
    private val reader = CharacteristicsReader(context)

    private val _status = MutableStateFlow(CameraStatus())
    override val status: StateFlow<CameraStatus> = _status.asStateFlow()

    private val _results = MutableSharedFlow<ResultSummary>(
        extraBufferCapacity = RESULTS_KEPT,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    override val results: SharedFlow<ResultSummary> = _results.asSharedFlow()

    private val streamResults = RecentResults(RESULTS_KEPT)
    private val stillResults = RecentResults(RESULTS_KEPT)
    private val streamFps = FrameRateMeter()
    private val analysisFps = FrameRateMeter()
    private val streamStillIntent = AtomicLong()
    private val stillRepeating = AtomicLong()
    private val frameRequests = ConcurrentLinkedQueue<FrameRequest>()

    // Main-thread state.
    private var provider: ProcessCameraProvider? = null
    private var providerRequested = false
    private var owner: LifecycleOwner? = null
    private var config = BindConfig()
    private var surfaceProvider: Preview.SurfaceProvider? = null
    private var requested: Requested? = null
    private var nextBindId = 1L

    @Volatile
    private var current: Bound? = null

    private class Requested(val cameraId: String, val preview: Size, val analysis: Size, val full: Size)

    private inner class Bound(
        val id: Long,
        val camera: Camera,
        val preview: Preview?,
        val analysis: ImageAnalysis,
        val capture: ImageCapture,
    ) {
        @Volatile
        var firstFrameSeen = false
        var readyNotified = false // main thread
        val stateObserver = Observer<CameraState> { onCameraState(this, it) }
    }

    private class FrameRequest(val deliver: (AnalysisFrame) -> Unit)

    private val lifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) = bindNow("start")

        override fun onStop(owner: LifecycleOwner) = unbindNow("stop")

        override fun onDestroy(owner: LifecycleOwner) {
            owner.lifecycle.removeObserver(this)
            if (this@CameraController.owner === owner) this@CameraController.owner = null
        }
    }

    // ---- lifecycle ----

    /** Binds to [owner]'s lifecycle (call once CAMERA is granted). Binding starts at ON_START. */
    @MainThread
    fun attach(owner: LifecycleOwner) {
        if (this.owner === owner) return
        this.owner?.let { old ->
            unbindNow("re-attach")
            old.lifecycle.removeObserver(lifecycleObserver)
        }
        this.owner = owner
        requestProvider()
        owner.lifecycle.addObserver(lifecycleObserver) // replays ON_START if already started
    }

    /** The viewfinder's surface (PreviewView); kept across binds. Null detaches it. */
    @MainThread
    fun setPreviewSurfaceProvider(provider: Preview.SurfaceProvider?) {
        surfaceProvider = provider
        current?.preview?.setSurfaceProvider(provider)
    }

    /**
     * Unbinds and binds again with [config] (e.g. variant B for the `streams` probe; the same
     * config = a camera restart). No-op bind while the activity is stopped: the next ON_START
     * binds with [config]. Returns the new bind, or null if it could not bind now.
     */
    suspend fun rebind(config: BindConfig = this.config): BindInfo? = withContext(Dispatchers.Main) {
        this@CameraController.config = config
        unbindNow("rebind")
        bindNow("rebind")
        current?.let { _status.value.bind }
    }

    val bindConfig: BindConfig get() = config

    fun stats(): Stats = Stats(
        bindId = current?.id,
        streamResults = streamResults.count,
        streamFps = streamFps.fps(),
        streamCallbackStillResults = streamStillIntent.get(),
        stillCallbackResults = stillResults.count,
        stillCallbackRepeatingResults = stillRepeating.get(),
        analysisFrames = analysisFps.count,
        analysisFps = analysisFps.fps(),
    )

    private fun requestProvider() {
        if (providerRequested) return
        providerRequested = true
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            try {
                provider = future.get()
                bindNow("provider ready")
            } catch (e: Exception) {
                Log.e(TAG, "camera provider failed", e)
                _status.update { it.copy(error = "camera provider: ${e.describe()}") }
            }
        }, mainExecutor)
    }

    @MainThread
    private fun bindNow(reason: String) {
        val owner = owner ?: return
        if (!owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return
        val provider = provider ?: return // bound when the provider arrives
        if (current != null) return
        val req = requested ?: try {
            readRequested().also { requested = it }
        } catch (e: Exception) {
            Log.e(TAG, "cannot read camera characteristics", e)
            _status.update { it.copy(bound = false, open = false, error = "characteristics: ${e.describe()}") }
            return
        }
        val cfg = config
        val id = nextBindId++
        resetCounters()
        val selector = CameraSelector.Builder()
            .addCameraFilter { infos -> infos.filter { Camera2CameraInfo.from(it).cameraId == req.cameraId } }
            .build()

        var useCases = buildUseCases(id, req, cfg, strict = true)
        var camera: Camera? = null
        val strict = try {
            camera = provider.bindToLifecycle(owner, selector, useCases.group)
            StrictBindOutcome(ok = true)
        } catch (e: Exception) {
            provider.unbindAll()
            StrictBindOutcome(ok = false, error = e.describe())
        }
        if (camera == null) {
            useCases = buildUseCases(id, req, cfg, strict = false)
            camera = try {
                provider.bindToLifecycle(owner, selector, useCases.group)
            } catch (e: Exception) {
                provider.unbindAll()
                Log.e(TAG, "bind #$id variant=${cfg.variant} failed (strict: ${strict.error})", e)
                _status.update { it.copy(bound = false, open = false, error = "bind: ${e.describe()}") }
                return
            }
        }

        val bound = Bound(id, camera, useCases.preview, useCases.analysis, useCases.capture)
        current = bound
        val info = BindInfo(
            bindId = id,
            variant = cfg.variant,
            analysisFormat = cfg.analysisFormat,
            strict = strict,
            preview = useCases.preview?.let { sizes(req.preview, it.resolutionInfo) },
            analysis = sizes(req.analysis, useCases.analysis.resolutionInfo),
            capture = sizes(req.full, useCases.capture.resolutionInfo),
        )
        _status.value = CameraStatus(bound = true, open = false, bind = info, error = null)
        camera.cameraInfo.cameraState.observe(owner, bound.stateObserver)
        Log.i(TAG, "bind #$id ($reason) camera ${req.cameraId} ${info.describe()}")
    }

    @MainThread
    private fun unbindNow(reason: String) {
        val b = current ?: return
        val stats = stats()
        current = null
        b.camera.cameraInfo.cameraState.removeObserver(b.stateObserver)
        b.analysis.clearAnalyzer()
        provider?.unbindAll()
        _status.update { it.copy(bound = false, open = false) }
        Log.i(TAG, "unbind #${b.id} ($reason): $stats")
        if (b.readyNotified) {
            b.readyNotified = false
            notifyReady(false)
        }
    }

    @MainThread
    private fun onCameraState(b: Bound, state: CameraState) {
        if (current !== b) return
        val error = state.error?.let { "camera error ${it.code}" + (it.cause?.let { c -> " (${c.describe()})" } ?: "") }
        Log.i(TAG, "camera #${b.id} state ${state.type}" + (error?.let { " $it" } ?: ""))
        val open = state.type == CameraState.Type.OPEN
        _status.update { it.copy(open = open, error = if (open) null else error ?: it.error) }
        if (open && !b.readyNotified) {
            b.readyNotified = true
            notifyReady(true)
        } else if (!open && b.readyNotified) {
            b.readyNotified = false
            notifyReady(false)
        }
    }

    private fun notifyReady(ready: Boolean) {
        try {
            onReadyChanged(ready)
        } catch (e: Exception) {
            Log.w(TAG, "ready listener failed", e)
        }
    }

    private fun resetCounters() {
        streamResults.clear()
        stillResults.clear()
        streamFps.reset()
        analysisFps.reset()
        streamStillIntent.set(0)
        stillRepeating.set(0)
    }

    private fun readRequested(): Requested {
        val id = reader.backCameraId()
        val caps = reader.read(id)
        return Requested(
            cameraId = id,
            preview = SizeSelection.selectPreview(caps.privateSizes),
            analysis = SizeSelection.selectAnalysis(caps.yuvSizes),
            full = SizeSelection.selectFull(caps.jpegSizes),
        )
    }

    // ---- use cases ----

    private class UseCases(val preview: Preview?, val analysis: ImageAnalysis, val capture: ImageCapture, val group: UseCaseGroup)

    private fun buildUseCases(id: Long, req: Requested, cfg: BindConfig, strict: Boolean): UseCases {
        val streamCallback = StreamCallback(id)
        val preview = if (cfg.variant == StreamVariant.A) {
            Preview.Builder()
                .setTargetRotation(TARGET_ROTATION)
                .setResolutionSelector(resolutionSelector(req.preview, strict, listOf(req.preview)))
                .also { Camera2Interop.Extender(it).setSessionCaptureCallback(streamCallback) }
                .build()
                .also { p -> surfaceProvider?.let(p::setSurfaceProvider) }
        } else {
            null
        }
        val analysis = ImageAnalysis.Builder()
            .setTargetRotation(TARGET_ROTATION)
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setOutputImageFormat(
                when (cfg.analysisFormat) {
                    AnalysisFormat.YUV_420_888 -> ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888
                    AnalysisFormat.RGBA_8888 -> ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888
                },
            )
            .setResolutionSelector(
                resolutionSelector(req.analysis, strict, listOf(SizeSelection.ANALYSIS_PREFERRED, SizeSelection.ANALYSIS_FALLBACK)),
            )
            // Variant B has no Preview builder: the repeating results come through the analysis builder.
            .also { if (preview == null) Camera2Interop.Extender(it).setSessionCaptureCallback(streamCallback) }
            .build()
            .also { a -> a.setAnalyzer(analysisExecutor) { proxy -> onAnalysisFrame(id, proxy) } }
        val capture = ImageCapture.Builder()
            .setTargetRotation(TARGET_ROTATION)
            // MINIMIZE_LATENCY: no AE precapture / AF trigger sequence before each still (it would
            // fight frozen controls later) and JPEG q95 instead of q100; we re-encode at q92 anyway.
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setFlashMode(ImageCapture.FLASH_MODE_OFF)
            .setResolutionSelector(resolutionSelector(req.full, strict, listOf(req.full)))
            .also { Camera2Interop.Extender(it).setSessionCaptureCallback(stillCallback) }
            .build()
        val viewPort = ViewPort.Builder(Rational(4, 3), TARGET_ROTATION).build()
        val group = UseCaseGroup.Builder()
            .setViewPort(viewPort)
            .apply { preview?.let(::addUseCase) }
            .addUseCase(analysis)
            .addUseCase(capture)
            .build()
        return UseCases(preview, analysis, capture, group)
    }

    /**
     * Strict: exactly [requested] at 4:3 or the bind fails. Otherwise 4:3 preferred, closest to
     * [requested] (lower first), with the [preferred] sizes tried first in their order.
     */
    private fun resolutionSelector(requested: Size, strict: Boolean, preferred: List<Size>): ResolutionSelector {
        val builder = ResolutionSelector.Builder()
        if (strict) {
            builder
                .setAspectRatioStrategy(AspectRatioStrategy(AspectRatio.RATIO_4_3, AspectRatioStrategy.FALLBACK_RULE_NONE))
                .setResolutionStrategy(ResolutionStrategy(requested.toAndroid(), ResolutionStrategy.FALLBACK_RULE_NONE))
        } else {
            builder
                .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                .setResolutionStrategy(
                    ResolutionStrategy(requested.toAndroid(), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER),
                )
                .setResolutionFilter(
                    ResolutionFilter { supported, _ ->
                        val core = supported.map { it.toCore() }
                        SizeSelection.prioritize(core, preferred).map { it.toAndroid() }
                    },
                )
        }
        return builder.build()
    }

    // ---- per-frame results ----

    /** Repeating-request results of bind [bindId]: preview fps + the [results] stream. */
    private inner class StreamCallback(private val bindId: Long) : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
            if (current?.id != bindId) return
            val summary = ResultSummaryMapper.fromResult(result)
            if (summary.captureIntent == Camera2.CAPTURE_INTENT_STILL_CAPTURE) {
                streamStillIntent.incrementAndGet()
            } else {
                summary.timestampNs?.let(streamFps::record)
            }
            streamResults.add(summary)
            _results.tryEmit(summary)
        }
    }

    /** Results seen by the ImageCapture builder: the candidates for still pairing. */
    private val stillCallback = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
            val summary = ResultSummaryMapper.fromResult(result)
            if (summary.captureIntent != Camera2.CAPTURE_INTENT_STILL_CAPTURE) stillRepeating.incrementAndGet()
            stillResults.add(summary)
        }
    }

    override fun latestResult(): ResultSummary? = streamResults.latest()

    // ---- analysis ----

    private fun onAnalysisFrame(bindId: Long, proxy: ImageProxy) {
        proxy.use {
            val b = current
            if (b == null || b.id != bindId) return
            analysisFps.record(proxy.imageInfo.timestamp)
            if (!b.firstFrameSeen) {
                b.firstFrameSeen = true
                val g = BufferGeometry(Size(proxy.width, proxy.height), proxy.cropRect.toCore(), proxy.imageInfo.rotationDegrees)
                _status.update { s ->
                    val bind = s.bind
                    if (bind?.bindId == bindId) s.copy(bind = bind.copy(analysisBuffer = g)) else s
                }
                Log.i(TAG, "bind #$bindId first analysis buffer ${g.size} crop=${g.cropRect} rot=${g.rotationDegrees} format=${proxy.format}")
            }
            if (frameRequests.isEmpty()) return
            while (true) {
                val request = frameRequests.poll() ?: break
                request.deliver(analysisFrame(proxy))
            }
        }
    }

    /** A fresh zero-copy view of [proxy] (own buffer positions per request). */
    private fun analysisFrame(proxy: ImageProxy): AnalysisFrame {
        val format = when (proxy.format) {
            ImageFormat.YUV_420_888 -> AnalysisFormat.YUV_420_888
            PixelFormat.RGBA_8888 -> AnalysisFormat.RGBA_8888
            else -> throw IllegalStateException("unexpected analysis format ${proxy.format}")
        }
        return AnalysisFrame(
            format = format,
            size = Size(proxy.width, proxy.height),
            cropRect = proxy.cropRect.toCore(),
            rotationDegrees = proxy.imageInfo.rotationDegrees,
            timestampNs = proxy.imageInfo.timestamp,
            planes = proxy.planes.map { p ->
                AnalysisFrame.Plane(p.buffer.duplicate().apply { rewind() }.asReadOnlyBuffer(), p.rowStride, p.pixelStride)
            },
        )
    }

    override suspend fun <T> withNextAnalysisFrame(block: (AnalysisFrame) -> T): T {
        val done = CompletableDeferred<T>()
        val request = FrameRequest { frame -> done.completeWith(runCatching { block(frame) }) }
        frameRequests.add(request)
        try {
            return done.await()
        } finally {
            frameRequests.remove(request)
        }
    }

    // ---- stills ----

    private class RawStill(
        val jpeg: ByteArray,
        val size: Size,
        val cropRect: IntRect,
        val rotationDegrees: Int,
        val timestampNs: Long,
        val captureNs: Long,
        val copyNs: Long,
    )

    override suspend fun takePicture(): StillCapture {
        val b = current
        val st = _status.value
        if (b == null || !st.open) throw CameraNotReadyException("camera not ready (bound=${st.bound}, open=${st.open})")
        val t0 = System.nanoTime()
        val raw = suspendCancellableCoroutine { cont ->
            b.capture.takePicture(captureExecutor, object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    val t1 = System.nanoTime()
                    val still = try {
                        image.use { readStill(it, t1 - t0) }
                    } catch (e: Exception) {
                        cont.resumeWithException(e)
                        return
                    }
                    cont.resume(still)
                }

                override fun onError(exception: ImageCaptureException) {
                    cont.resumeWithException(
                        CameraCaptureException(exception.imageCaptureError, exception.message ?: "capture failed", exception),
                    )
                }
            })
        }
        val tPair = System.nanoTime()
        var result = stillResults.awaitTimestamp(raw.timestampNs, PAIR_TIMEOUT_MS)
        val pairing = when {
            result != null -> StillPairing.Outcome.STILL_CALLBACK
            else -> {
                result = streamResults.find(raw.timestampNs)
                if (result != null) StillPairing.Outcome.STREAM_CALLBACK else StillPairing.Outcome.NONE
            }
        }
        val pairWaitNs = System.nanoTime() - tPair
        if (pairing == StillPairing.Outcome.NONE) {
            val nearest = StillPairing.nearest(raw.timestampNs, stillResults.snapshot() + streamResults.snapshot())
            Log.w(
                TAG,
                "still ts=${raw.timestampNs} has no result with that SENSOR_TIMESTAMP; nearest " +
                    (nearest?.let { "#${it.first.frameNumber} Δ=${it.second} ns" } ?: "none"),
            )
        }
        return StillCapture(
            jpeg = raw.jpeg,
            bufferSize = raw.size,
            cropRect = raw.cropRect,
            rotationDegrees = raw.rotationDegrees,
            sensorTimestampNs = raw.timestampNs,
            result = result,
            pairing = pairing,
            timings = StillTimings(
                captureMs = raw.captureNs / 1e6,
                copyMs = raw.copyNs / 1e6,
                pairWaitMs = pairWaitNs / 1e6,
            ),
        )
    }

    private fun readStill(image: ImageProxy, captureNs: Long): RawStill {
        check(image.format == ImageFormat.JPEG) { "still format ${image.format} is not JPEG" }
        val t = System.nanoTime()
        val buffer = image.planes[0].buffer
        buffer.rewind()
        val bytes = ByteArray(buffer.remaining()).also(buffer::get)
        return RawStill(
            jpeg = bytes,
            size = Size(image.width, image.height),
            cropRect = image.cropRect.toCore(),
            rotationDegrees = image.imageInfo.rotationDegrees,
            timestampNs = image.imageInfo.timestamp,
            captureNs = captureNs,
            copyNs = System.nanoTime() - t,
        )
    }

    companion object {
        const val TAG = "KopernikadrCam"

        /** Every use case and the ViewPort (see the class doc). */
        const val TARGET_ROTATION = Surface.ROTATION_90

        /** Results kept per callback (≈ 3 s at 30 fps). */
        private const val RESULTS_KEPT = 90

        /** How long a still waits for its capture result after the image arrived. */
        private const val PAIR_TIMEOUT_MS = 1_000L

        private fun sizes(requested: Size, info: ResolutionInfo?) = StreamSizes(
            requested = requested,
            resolved = info?.resolution?.toCore(),
            cropRect = info?.cropRect?.toCore(),
            rotationDegrees = info?.rotationDegrees,
        )

        private fun Size.toAndroid() = ASize(width, height)

        private fun ASize.toCore() = Size(width, height)

        private fun Rect.toCore() = IntRect(left, top, right, bottom)

        private fun Throwable.describe() = "${this::class.simpleName}: $message"

        private fun BindInfo.describe(): String = buildString {
            append("variant=").append(variant).append(" analysisFormat=").append(analysisFormat)
            append(" strict=").append(if (strict.ok) "ok" else "FAILED (${strict.error})")
            preview?.let { append(" | preview ").append(it.describe()) }
            append(" | analysis ").append(analysis.describe())
            append(" | capture ").append(capture.describe())
        }

        private fun StreamSizes.describe() =
            "requested $requested resolved ${resolved ?: "?"} crop=${cropRect ?: "?"} rot=${rotationDegrees ?: "?"}"
    }
}
