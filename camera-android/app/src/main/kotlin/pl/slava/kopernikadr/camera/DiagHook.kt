package pl.slava.kopernikadr.camera

import android.content.Intent
import androidx.compose.runtime.Composable
import io.ktor.server.routing.Route

/**
 * Build-type seam for diagnostics. `src/probe` defines the top-level `diagHook` with the
 * diagnostics code (debug compiles `src/probe` too), `src/release` defines a no-op, so no
 * diagnostics classes reach a release APK.
 */
interface DiagHook {
    /** Called once from [App.onCreate]. */
    fun onAppCreate(app: App) {}

    /** Adds the `/diag` routes to the camera server. */
    fun installDiag(route: Route) {}

    /**
     * Called with the activity's launch intent (once per creation) and with each new intent.
     * Debug/probe start the probe named by the `probe` extra. True = show the diagnostics screen.
     */
    fun onIntent(intent: Intent): Boolean = false

    /** The diagnostics screen, or null when the build has none (then the title has no long-press). */
    val diagnosticsScreen: (@Composable (onClose: () -> Unit) -> Unit)? get() = null
}

fun Route.installDiag() = diagHook.installDiag(this)
