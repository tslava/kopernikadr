package pl.slava.kopernikadr.camera.diag

import android.util.Log
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import pl.slava.kopernikadr.camera.camera.AnalysisFormat
import pl.slava.kopernikadr.camera.camera.CameraController
import pl.slava.kopernikadr.camera.camera.StreamVariant
import pl.slava.kopernikadr.camera.camera.short
import pl.slava.kopernikadr.camera.core.FrameTransform

/**
 * One-off debug/probe actions (plan Task 4 on-device checks), started with
 * `adb shell am start -n <pkg>/pl.slava.kopernikadr.camera.MainActivity --es action <name>`:
 * - `capture-test`: waits for the camera, takes one still to
 *   `getExternalFilesDir("diag")/capture-test.jpg` and logs the still's and one analysis frame's
 *   geometry, the paired result, the rotation FrameTransform would apply, and the stream counters;
 * - `rebind` (+ `--es variant A|B`, `--es analysisFormat YUV_420_888|RGBA_8888`): rebinds the
 *   camera with that config (same config = a camera restart) and logs the counters before.
 *
 * Everything is logged under [CameraController.TAG].
 */
class DebugActions(private val camera: CameraController, private val dir: File) {
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

    companion object {
        const val CAPTURE_TEST = "capture-test"
        const val REBIND = "rebind"
        const val NAME = "capture-test.jpg"
        private const val TAG = CameraController.TAG
        private const val WAIT_MS = 15_000L
    }
}
