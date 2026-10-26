package pl.slava.kopernikadr.camera

import android.content.Intent
import android.util.Log
import androidx.compose.runtime.Composable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import pl.slava.kopernikadr.camera.diag.DebugActions
import pl.slava.kopernikadr.camera.diag.DiagnosticsScreen
import pl.slava.kopernikadr.camera.diag.ProbeRunner

// Diagnostics for the probe and debug builds (debug compiles src/probe as well).
internal val diagHook: DiagHook = DiagnosticsHook

internal object DiagnosticsHook : DiagHook {
    /** `adb shell am start -n <pkg>/pl.slava.kopernikadr.camera.MainActivity --es probe caps`. */
    const val EXTRA_PROBE = "probe"

    /** Optional probe args as a JSON object, e.g. `--es probeArgs '{"manualRestart":true}'`. */
    const val EXTRA_PROBE_ARGS = "probeArgs"

    /** A one-off debug action instead of a probe: `--es action capture-test` (see [DebugActions]). */
    const val EXTRA_ACTION = "action"

    lateinit var runner: ProbeRunner
        private set

    private lateinit var actions: DebugActions

    override fun onAppCreate(app: App) {
        runner = ProbeRunner(app)
        actions = DebugActions(app.camera, runner.rootDir)
    }

    override fun onCameraBound(bound: Boolean) {
        if (::runner.isInitialized) runner.core.setCameraBound(bound)
    }

    override fun onIntent(intent: Intent): Boolean {
        intent.getStringExtra(EXTRA_ACTION)?.let { action ->
            intent.removeExtra(EXTRA_ACTION)
            val extras = intent.extras?.keySet().orEmpty().associateWith { intent.getStringExtra(it) }
            if (!actions.start(action, extras)) Log.w(ProbeRunner.TAG, "unknown $EXTRA_ACTION '$action'")
        }
        val name = intent.getStringExtra(EXTRA_PROBE) ?: return false
        val argsText = intent.getStringExtra(EXTRA_PROBE_ARGS)
        // Consume the extras so a re-delivered intent does not start the probe again.
        intent.removeExtra(EXTRA_PROBE)
        intent.removeExtra(EXTRA_PROBE_ARGS)
        val args = try {
            argsText?.let { Json.parseToJsonElement(it).jsonObject } ?: JsonObject(emptyMap())
        } catch (e: Exception) {
            Log.w(ProbeRunner.TAG, "bad $EXTRA_PROBE_ARGS '$argsText': ${e.message}")
            return true
        }
        runner.start(name, args)
        return true
    }

    override val diagnosticsScreen: @Composable (onClose: () -> Unit) -> Unit = { onClose ->
        DiagnosticsScreen(runner, onClose)
    }
}
