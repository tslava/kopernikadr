package pl.slava.kopernikadr.camera.diag

import android.app.Application
import android.content.pm.ApplicationInfo
import android.os.Build
import android.util.Log
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import pl.slava.kopernikadr.camera.camera.CharacteristicsReader

/**
 * Application-scoped probe runner: [ProbeRunnerCore] with the Android probes, reports under
 * `getExternalFilesDir("diag")` (readable with `adb pull` on a non-debuggable build too), and a
 * one-line logcat summary per run (tag [TAG]).
 */
class ProbeRunner(app: Application) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val reader = CharacteristicsReader(app)

    val rootDir: File = app.getExternalFilesDir("diag") ?: File(app.filesDir, "diag")

    val core = ProbeRunnerCore(
        rootDir = rootDir,
        scope = scope,
        probes = mapOf(
            CapsProbe.NAME to { _ -> CapsProbe { reader.read() } },
        ),
        environment = environment(app),
        onFinished = ::logFinished,
    )

    fun start(name: String, args: JsonObject = JsonObject(emptyMap())): StartResult =
        core.start(name, args).also { Log.i(TAG, "start $name $args -> $it") }

    private fun logFinished(status: RunStatus, report: JsonObject) {
        val summary = report.summary()
        val line = buildString {
            append("run ").append(status.runId).append(' ').append(status.state.name.lowercase())
            status.error?.let { append(" error=").append(it) }
            summary?.let { append(": ").append(it) }
            append(" [").append(File(rootDir, status.runId)).append(']')
        }
        if (status.state == RunState.DONE) Log.i(TAG, line) else Log.w(TAG, line)
    }

    companion object {
        const val TAG = "KopernikadrDiag"

        private fun environment(app: Application): JsonObject {
            val pkg = app.packageName
            val info = app.packageManager.getPackageInfo(pkg, 0)
            return buildJsonObject {
                put("packageName", pkg)
                put("buildType", pkg.substringAfterLast('.').takeIf { it == "debug" || it == "probe" } ?: "release")
                put("debuggable", app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
                put("versionName", info.versionName)
                put("versionCode", info.longVersionCode)
                put("manufacturer", Build.MANUFACTURER)
                put("model", Build.MODEL)
                put("sdkInt", Build.VERSION.SDK_INT)
                put("release", Build.VERSION.RELEASE)
                put("fingerprint", Build.FINGERPRINT)
            }
        }
    }
}

/** The probe's `summary` line, if it wrote one. */
internal fun JsonObject.summary(): String? = (this["summary"] as? JsonPrimitive)?.contentOrNull
