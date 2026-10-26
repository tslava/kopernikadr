package pl.slava.kopernikadr.camera.diag

import android.util.Log
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import pl.slava.kopernikadr.camera.camera.AnalysisFormat
import pl.slava.kopernikadr.camera.camera.CameraControls
import pl.slava.kopernikadr.camera.camera.CameraController
import pl.slava.kopernikadr.camera.camera.StreamVariant
import pl.slava.kopernikadr.camera.camera.short
import pl.slava.kopernikadr.camera.core.FrameTransform
import pl.slava.kopernikadr.camera.protocol.ControlMode
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.server.ControlChange
import pl.slava.kopernikadr.camera.server.PortResult

/**
 * One-off debug/probe actions (plan Task 4 on-device checks), started with
 * `adb shell am start -n <pkg>/pl.slava.kopernikadr.camera.MainActivity --es action <name>`:
 * - `capture-test`: waits for the camera, takes one still to
 *   `getExternalFilesDir("diag")/capture-test.jpg` and logs the still's and one analysis frame's
 *   geometry, the paired result, the rotation FrameTransform would apply, and the stream counters;
 * - `rebind` (+ `--es variant A|B`, `--es analysisFormat YUV_420_888|RGBA_8888`): rebinds the
 *   camera with that config (same config = a camera restart) and logs the counters before;
 * - `lock` (`--es control exposure|whiteBalance|focus --es mode locked|auto`): `setControl` through
 *   the controls port, waits (≤ 6 s) until that control is confirmed or failed, logs the controls,
 *   then takes one still and logs its paired result (frozen values must show there: `aeMode=OFF`,
 *   `awbMode=OFF ccMode=0`, `afMode=OFF`). `--es still 0` skips the still;
 * - `comp` (`--es steps N`, or `--ei steps N`): exposure compensation;
 * - `controls`: logs the current controls JSON.
 *
 * Everything is logged under [CameraController.TAG]; the controls themselves log under
 * [CameraControls.TAG].
 */
class DebugActions(
    private val camera: CameraController,
    private val dir: File,
    private val controls: () -> CameraControls?,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** False if [name] is not an action. */
    fun start(name: String, extras: Map<String, String?>): Boolean {
        val action: suspend () -> Unit = when (name) {
            CAPTURE_TEST -> ::captureTest
            REBIND -> {
                {
                    val cfg = CameraController.BindConfig(
                        variant = extras["variant"]?.let(StreamVariant::valueOf) ?: camera.bindConfig.variant,
                        analysisFormat = extras["analysisFormat"]?.let(AnalysisFormat::valueOf) ?: camera.bindConfig.analysisFormat,
                    )
                    Log.i(TAG, "rebind: before ${camera.stats()}")
                    val bind = camera.rebind(cfg)
                    Log.i(TAG, "rebind: $cfg -> ${bind?.let { "bind #${it.bindId} strict=${it.strict.ok}" } ?: "not bound now"}")
                }
            }
            LOCK -> { { lock(extras) } }
            COMP -> {
                {
                    val steps = extras["steps"]?.toIntOrNull() ?: error("comp needs --es steps N")
                    setControl(ControlChange.ExposureCompensation(steps))
                }
            }
            CONTROLS -> { { Log.i(TAG, "controls: ${json(readyControls().get())}") } }
            else -> return false
        }
        scope.launch {
            try {
                action()
            } catch (e: Exception) {
                Log.e(TAG, "$name failed", e)
            }
        }
        return true
    }

    private suspend fun captureTest() {
        Log.i(TAG, "capture-test: waiting for the camera")
        withTimeout(WAIT_MS) { camera.status.first { it.ready } }
        val bind = camera.status.value.bind
        Log.i(TAG, "capture-test: bind ${bind?.bindId} strict=${bind?.strict} analysisBuffer=${bind?.analysisBuffer}")

        val frame = camera.withNextAnalysisFrame { it.toString() }
        Log.i(TAG, "capture-test: analysis $frame")

        val still = camera.takePicture()
        val file = File(dir, NAME)
        dir.mkdirs()
        file.writeBytes(still.jpeg)
        Log.i(TAG, "capture-test: still $still -> $file")
        Log.i(TAG, "capture-test: paired ${still.pairing} ${still.result?.short()}")
        val t = FrameTransform.compute(still.bufferSize, still.cropRect, still.rotationDegrees, projectRotation = 0)
        Log.i(
            TAG,
            "capture-test: FrameTransform at project rotation 0 -> crop ${t.cropRect} total rotation ${t.rotationDegrees} " +
                "output ${t.outputSize} (not applied yet: Task 5)",
        )
        Log.i(TAG, "capture-test: latest stream result ${camera.latestResult()?.short()}")
        Log.i(TAG, "capture-test: ${camera.stats()}")
    }

    private suspend fun readyControls(): CameraControls {
        withTimeout(WAIT_MS) { camera.status.first { it.ready } }
        return controls() ?: error("controls unavailable")
    }

    private suspend fun setControl(change: ControlChange): Controls? {
        val c = readyControls()
        return when (val r = c.set(change)) {
            is PortResult.Ok -> r.value.also { Log.i(TAG, "setControl $change ok: ${json(it)}") }
            is PortResult.Err -> null.also { Log.w(TAG, "setControl $change rejected: ${r.error.code} ${r.error.message}") }
        }
    }

    private suspend fun lock(extras: Map<String, String?>) {
        val control = extras["control"] ?: error("lock needs --es control exposure|whiteBalance|focus")
        val mode = extras["mode"] ?: "locked"
        val change = when (control) {
            "exposure" -> ControlChange.Exposure(ControlMode.valueOf(mode.uppercase()))
            "whiteBalance" -> ControlChange.WhiteBalance(ControlMode.valueOf(mode.uppercase()))
            "focus" -> ControlChange.Focus(FocusMode.valueOf(mode.uppercase()))
            else -> error("unknown control '$control'")
        }
        val t0 = System.nanoTime()
        setControl(change) ?: return
        val c = readyControls()
        fun state(x: Controls): Pair<String, Boolean> = when (control) {
            "exposure" -> x.exposure.mode.name to x.exposure.confirmed
            "whiteBalance" -> x.whiteBalance.mode.name to x.whiteBalance.confirmed
            else -> x.focus.mode.name to x.focus.confirmed
        }
        val done = withTimeoutOrNull(LOCK_WAIT_MS) {
            c.controls.first { x -> state(x).let { it.second || it.first == "FAILED" } }
        }
        val ms = (System.nanoTime() - t0) / 1_000_000
        if (done == null) {
            Log.w(TAG, "lock $control $mode: not settled after $ms ms: ${json(c.get())}")
        } else {
            Log.i(TAG, "lock $control $mode: ${state(done)} after $ms ms: ${json(done)}")
        }
        Log.i(TAG, "lock: latest stream result ${camera.latestResult()?.let { "${it.short()} cc=${it.ccMode}" }}")
        if (extras["still"] == "0") return
        val still = camera.takePicture()
        val r = still.result
        Log.i(
            TAG,
            "lock: still paired ${still.pairing} ${r?.short()} aeMode=${r?.aeMode} awbMode=${r?.awbMode} ccMode=${r?.ccMode} " +
                "afMode=${r?.afMode} gains=${r?.gains} transform=${r?.transform?.m}",
        )
    }

    private fun json(c: Controls) = JSON.encodeToString(Controls.serializer(), c)

    companion object {
        const val LOCK = "lock"
        const val COMP = "comp"
        const val CONTROLS = "controls"
        private const val LOCK_WAIT_MS = 6_000L
        private val JSON = Json { encodeDefaults = true }
        const val CAPTURE_TEST = "capture-test"
        const val REBIND = "rebind"
        const val NAME = "capture-test.jpg"
        private const val TAG = CameraController.TAG
        private const val WAIT_MS = 15_000L
    }
}
