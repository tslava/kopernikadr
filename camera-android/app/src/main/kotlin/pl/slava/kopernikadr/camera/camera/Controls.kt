package pl.slava.kopernikadr.camera.camera

import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.ColorSpaceTransform
import android.hardware.camera2.params.RggbChannelVector
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import pl.slava.kopernikadr.camera.controls.Apply
import pl.slava.kopernikadr.camera.controls.Camera2
import pl.slava.kopernikadr.camera.controls.ColorGains
import pl.slava.kopernikadr.camera.controls.ColorTransform
import pl.slava.kopernikadr.camera.controls.ControlsEngine
import pl.slava.kopernikadr.camera.controls.ControlsUpdate
import pl.slava.kopernikadr.camera.controls.KeyValueStore
import pl.slava.kopernikadr.camera.controls.RequestOption
import pl.slava.kopernikadr.camera.controls.SetControlOutcome
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.SetControlArgs
import pl.slava.kopernikadr.camera.server.ControlChange
import pl.slava.kopernikadr.camera.server.ControlsPort
import pl.slava.kopernikadr.camera.server.PortResult

/**
 * The Android adapter of [ControlsEngine] (ARCHITECTURE §4.4, plan Task 7). Application-scoped;
 * the engine lives on the single thread `kopernikadr-controls` and every input goes through it:
 *
 * - each time the camera of a bind reaches OPEN ([CameraController.status]; a re-open inside the
 *   same bind counts too, it is a new capture session with new frame numbers):
 *   [ControlsEngine.onCameraBound];
 * - every repeating-request result ([CameraController.results], still-intent results skipped):
 *   [ControlsEngine.onResult];
 * - every 100 ms while settling: [ControlsEngine.onTick];
 * - [set] (the `setControl` port): [ControlsEngine.setControl].
 *
 * Steps: an [Apply] goes out as the **complete** option set with
 * `Camera2CameraControl.setCaptureRequestOptions` (it replaces the previous set). The fence:
 * CameraX completes that future when the first capture result of a request carrying the new
 * options arrives, but does not say which frame that was. When the completion reaches this thread
 * we take `latestResult().frameNumber + 1` of the repeating stream: our own result callback has
 * delivered either the completing frame F already (then the fence is a frame or two after F) or
 * only F-1 (then it is F exactly). It is never before F, so a result of the previous option set is
 * never taken as a result of the new one; the cost is at most a frame or two of extra latency.
 * Completions of superseded generations (cancelled futures, stale generations) are ignored.
 *
 * AF trigger / cancel: `startFocusAndMetering(center, FLAG_AF, no auto-cancel)` /
 * `cancelFocusAndMetering()`.
 *
 * Logged under [TAG]: every apply, fence, AF trigger/cancel, setControl and confirm / fail.
 */
@OptIn(markerClass = [ExperimentalCamera2Interop::class])
class CameraControls(
    private val camera: CameraController,
    caps: Capabilities,
    store: KeyValueStore,
) : ControlsPort {

    private val executor: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "kopernikadr-controls") }
    private val dispatcher = executor.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    // Confined to the controls thread after construction.
    private val engine = ControlsEngine(caps, store)
    private var cameraOpen = false
    private var openBindId: Long? = null

    private val _controls = MutableStateFlow(engine.controls)

    /** The wire controls; updated on the controls thread after every input that changed them. */
    val controls: StateFlow<Controls> = _controls.asStateFlow()

    /** The option set of the latest generation sent to the camera (e.g. for a hand-built request). */
    @Volatile
    var appliedOptions: Map<RequestOption, Any> = engine.options
        private set

    init {
        RequestOptionMapping.checkKeys()
        Log.i(TAG, "controls start: ${json.encodeToString(Controls.serializer(), engine.controls)}")
        scope.launch {
            camera.status.collect { st ->
                val open = st.bound && st.open && st.bind != null
                if (open && (!cameraOpen || st.bind?.bindId != openBindId)) {
                    openBindId = st.bind?.bindId
                    cameraOpen = true
                    Log.i(TAG, "camera open (bind #$openBindId): onCameraBound")
                    handle(engine.onCameraBound(now()))
                } else if (!open) {
                    cameraOpen = false
                }
            }
        }
        scope.launch {
            camera.results.collect { r ->
                if (r.captureIntent != Camera2.CAPTURE_INTENT_STILL_CAPTURE) handle(engine.onResult(r, now()))
            }
        }
        scope.launch {
            while (true) {
                delay(TICK_MS)
                if (engine.state.settling) handle(engine.onTick(now()))
            }
        }
    }

    // ---- ControlsPort ----

    override fun get(): Controls = _controls.value

    override val updates: StateFlow<Controls> get() = controls

    override suspend fun set(change: ControlChange): PortResult<Controls> = withContext(dispatcher) {
        val args = change.toArgs()
        when (val o = engine.setControl(args, now())) {
            is SetControlOutcome.Ok -> {
                Log.i(TAG, "setControl $args -> generation ${o.update.controls.generation}")
                handle(o.update)
                PortResult.Ok(o.update.controls)
            }
            is SetControlOutcome.Rejected -> {
                Log.w(TAG, "setControl $args rejected: ${o.error.code} ${o.error.message}")
                PortResult.Err(o.error)
            }
        }
    }

    /** Project rotation (0/180) as stored by the controls (for the still pipeline). */
    fun currentRotation(): Int = _controls.value.rotation

    /** Preview quality as stored by the controls (for the preview encoder). */
    fun previewQuality(): PreviewQuality = _controls.value.previewQuality

    /** Any lock still settling (capture admission: wait / reject while true). */
    fun settling(): Boolean = _controls.value.settling

    // ---- steps ----

    private fun handle(u: ControlsUpdate) {
        val before = _controls.value
        if (u.step.cancelAf) cancelAf()
        u.step.apply?.let(::apply)
        if (u.step.triggerAf) triggerAf()
        if (u.controlsChanged) {
            _controls.value = u.controls
            logChange(before, u.controls)
        }
    }

    private fun apply(a: Apply) {
        appliedOptions = a.options
        val cam = camera.boundCamera()
        if (cam == null) {
            Log.i(TAG, "apply gen ${a.generation}: no camera bound (re-applied at the next open)")
            return
        }
        val options = CaptureRequestOptions.Builder()
            .apply { a.options.forEach { (o, v) -> RequestOptionMapping.set(this, o, v) } }
            .build()
        Log.i(TAG, "apply gen ${a.generation}: ${describe(a.options)}")
        val future = Camera2CameraControl.from(cam.cameraControl).setCaptureRequestOptions(options)
        future.addListener({
            try {
                future.get()
            } catch (e: Exception) {
                Log.i(TAG, "apply gen ${a.generation} not completed (${e.javaClass.simpleName}: ${e.message})")
                return@addListener
            }
            val latest = camera.latestResult()?.frameNumber
            val fence = (latest ?: -1L) + 1
            val u = engine.onFence(a.generation, fence, now())
            if (a.generation == engine.state.generation && engine.state.fenceFrame == fence) {
                Log.i(TAG, "fence gen ${a.generation}: frame $fence (latest stream result #$latest)")
            } else {
                Log.d(TAG, "stale fence gen ${a.generation} ignored (current gen ${engine.state.generation})")
            }
            handle(u)
        }, executor)
    }

    private fun triggerAf() {
        val cam = camera.boundCamera() ?: return
        val point = SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(.5f, .5f)
        val action = FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF).disableAutoCancel().build()
        Log.i(TAG, "AF trigger (center)")
        val f = cam.cameraControl.startFocusAndMetering(action)
        f.addListener({
            val r = runCatching { f.get() }
            Log.i(TAG, "AF trigger done: " + r.fold({ "focusSuccessful=${it.isFocusSuccessful}" }, { "${it.javaClass.simpleName}: ${it.message}" }))
        }, executor)
    }

    private fun cancelAf() {
        val cam = camera.boundCamera() ?: return
        Log.i(TAG, "AF cancel")
        cam.cameraControl.cancelFocusAndMetering()
    }

    private fun logChange(before: Controls, after: Controls) {
        fun lock(name: String, b: String, bc: Boolean, a: String, ac: Boolean, extra: String) {
            if (b == a && bc == ac) return
            val what = when {
                a == "failed" -> "FAIL"
                a == "locked" && ac && !bc -> "CONFIRM"
                else -> "change"
            }
            Log.i(TAG, "$what $name: $b/${if (bc) "confirmed" else "unconfirmed"} -> $a/${if (ac) "confirmed" else "unconfirmed"}$extra")
        }
        val e = after.exposure
        val w = after.whiteBalance
        val f = after.focus
        lock("exposure", before.exposure.mode.wire, before.exposure.confirmed, e.mode.wire, e.confirmed, " exact=${e.exact}")
        lock("whiteBalance", before.whiteBalance.mode.wire, before.whiteBalance.confirmed, w.mode.wire, w.confirmed, " exact=${w.exact}")
        lock("focus", before.focus.mode.wire, before.focus.confirmed, f.mode.wire, f.confirmed, " focusOk=${f.focusOk}")
        Log.i(TAG, "controls ${json.encodeToString(Controls.serializer(), after)}")
    }

    private fun describe(o: Map<RequestOption, Any>): String = o.entries.joinToString(" ") { (k, v) ->
        val value = when (v) {
            is ColorGains -> "[${v.r},${v.gEven},${v.gOdd},${v.b}]"
            is ColorTransform -> v.m.joinToString(",", "[", "]")
            else -> v.toString()
        }
        "$k=$value"
    }

    companion object {
        const val TAG = "KopernikadrCtl"
        private const val TICK_MS = 100L
        private val json = Json { encodeDefaults = true }

        private fun now() = SystemClock.elapsedRealtime()

        private val ControlMode.wire get() = name.lowercase()
        private val FocusMode.wire get() = name.lowercase()

        /** The `setControl` arguments of a port change (validated by the engine). */
        fun ControlChange.toArgs(): SetControlArgs = when (this) {
            is ControlChange.Exposure -> SetControlArgs(SetControlArgs.EXPOSURE, mode = mode.name.lowercase())
            is ControlChange.ExposureCompensation -> SetControlArgs(SetControlArgs.EXPOSURE_COMPENSATION, steps = steps)
            is ControlChange.WhiteBalance -> SetControlArgs(SetControlArgs.WHITE_BALANCE, mode = mode.name.lowercase())
            is ControlChange.Focus -> SetControlArgs(SetControlArgs.FOCUS, mode = mode.name.lowercase())
            is ControlChange.Rotation -> SetControlArgs(SetControlArgs.ROTATION, degrees = degrees)
            is ControlChange.Preview -> SetControlArgs(SetControlArgs.PREVIEW_QUALITY, value = quality.name.lowercase())
        }
    }
}

/**
 * [RequestOption] → `CaptureRequest` key and value. [spec] is the pure table (unit-tested: every
 * option, its Camera2 key name and the value type the engine sends); [set] is the Android side.
 * [checkKeys] ties the two together at runtime (key names must match the table).
 */
@OptIn(markerClass = [ExperimentalCamera2Interop::class])
internal object RequestOptionMapping {
    enum class ValueType { INT, BOOLEAN, LONG, FLOAT, GAINS, TRANSFORM }

    data class Spec(val keyName: String, val type: ValueType)

    fun spec(o: RequestOption): Spec = when (o) {
        RequestOption.CONTROL_MODE -> Spec("android.control.mode", ValueType.INT)
        RequestOption.AE_MODE -> Spec("android.control.aeMode", ValueType.INT)
        RequestOption.AE_LOCK -> Spec("android.control.aeLock", ValueType.BOOLEAN)
        RequestOption.AE_EXPOSURE_COMPENSATION -> Spec("android.control.aeExposureCompensation", ValueType.INT)
        RequestOption.AE_ANTIBANDING_MODE -> Spec("android.control.aeAntibandingMode", ValueType.INT)
        RequestOption.SENSOR_SENSITIVITY -> Spec("android.sensor.sensitivity", ValueType.INT)
        RequestOption.SENSOR_EXPOSURE_TIME -> Spec("android.sensor.exposureTime", ValueType.LONG)
        RequestOption.SENSOR_FRAME_DURATION -> Spec("android.sensor.frameDuration", ValueType.LONG)
        RequestOption.AWB_MODE -> Spec("android.control.awbMode", ValueType.INT)
        RequestOption.AWB_LOCK -> Spec("android.control.awbLock", ValueType.BOOLEAN)
        RequestOption.COLOR_CORRECTION_MODE -> Spec("android.colorCorrection.mode", ValueType.INT)
        RequestOption.COLOR_CORRECTION_GAINS -> Spec("android.colorCorrection.gains", ValueType.GAINS)
        RequestOption.COLOR_CORRECTION_TRANSFORM -> Spec("android.colorCorrection.transform", ValueType.TRANSFORM)
        RequestOption.AF_MODE -> Spec("android.control.afMode", ValueType.INT)
        RequestOption.LENS_FOCUS_DISTANCE -> Spec("android.lens.focusDistance", ValueType.FLOAT)
    }

    /** Whether [v] has the Kotlin type [spec] declares for [o]. */
    fun accepts(o: RequestOption, v: Any): Boolean = when (spec(o).type) {
        ValueType.INT -> v is Int
        ValueType.BOOLEAN -> v is Boolean
        ValueType.LONG -> v is Long
        ValueType.FLOAT -> v is Float
        ValueType.GAINS -> v is ColorGains
        ValueType.TRANSFORM -> v is ColorTransform
    }

    /** `RggbChannelVector` constructor arguments. */
    fun gainsArgs(g: ColorGains): FloatArray = floatArrayOf(g.r, g.gEven, g.gOdd, g.b)

    /** `ColorSpaceTransform(int[])` argument: 9 × (numerator, 65536). */
    fun transformArgs(t: ColorTransform): IntArray = t.toRationals()

    fun key(o: RequestOption): CaptureRequest.Key<*> = when (o) {
        RequestOption.CONTROL_MODE -> CaptureRequest.CONTROL_MODE
        RequestOption.AE_MODE -> CaptureRequest.CONTROL_AE_MODE
        RequestOption.AE_LOCK -> CaptureRequest.CONTROL_AE_LOCK
        RequestOption.AE_EXPOSURE_COMPENSATION -> CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION
        RequestOption.AE_ANTIBANDING_MODE -> CaptureRequest.CONTROL_AE_ANTIBANDING_MODE
        RequestOption.SENSOR_SENSITIVITY -> CaptureRequest.SENSOR_SENSITIVITY
        RequestOption.SENSOR_EXPOSURE_TIME -> CaptureRequest.SENSOR_EXPOSURE_TIME
        RequestOption.SENSOR_FRAME_DURATION -> CaptureRequest.SENSOR_FRAME_DURATION
        RequestOption.AWB_MODE -> CaptureRequest.CONTROL_AWB_MODE
        RequestOption.AWB_LOCK -> CaptureRequest.CONTROL_AWB_LOCK
        RequestOption.COLOR_CORRECTION_MODE -> CaptureRequest.COLOR_CORRECTION_MODE
        RequestOption.COLOR_CORRECTION_GAINS -> CaptureRequest.COLOR_CORRECTION_GAINS
        RequestOption.COLOR_CORRECTION_TRANSFORM -> CaptureRequest.COLOR_CORRECTION_TRANSFORM
        RequestOption.AF_MODE -> CaptureRequest.CONTROL_AF_MODE
        RequestOption.LENS_FOCUS_DISTANCE -> CaptureRequest.LENS_FOCUS_DISTANCE
    }

    fun set(b: CaptureRequestOptions.Builder, o: RequestOption, v: Any) {
        require(accepts(o, v)) { "$o: unexpected value ${v::class.simpleName} $v" }
        val value: Any = when (v) {
            is ColorGains -> gainsArgs(v).let { RggbChannelVector(it[0], it[1], it[2], it[3]) }
            is ColorTransform -> ColorSpaceTransform(transformArgs(v))
            else -> v
        }
        @Suppress("UNCHECKED_CAST")
        b.setCaptureRequestOption(key(o) as CaptureRequest.Key<Any>, value)
    }

    fun checkKeys() {
        for (o in RequestOption.entries) {
            check(key(o).name == spec(o).keyName) { "$o: key ${key(o).name} != ${spec(o).keyName}" }
        }
    }
}
