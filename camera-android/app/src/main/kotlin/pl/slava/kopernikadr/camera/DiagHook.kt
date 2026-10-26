package pl.slava.kopernikadr.camera

import io.ktor.server.routing.Route

/**
 * Build-type seam for diagnostics. Each of `src/debug`, `src/probe` and `src/release` defines the
 * top-level `diagHook`: debug and probe carry the diagnostics code, release is a no-op, so no
 * diagnostics classes reach a release APK.
 */
interface DiagHook {
    /** Called once from [App.onCreate]. */
    fun onAppCreate(app: App) {}

    /** Adds the `/diag` routes to the camera server. */
    fun installDiag(route: Route) {}
}

fun Route.installDiag() = diagHook.installDiag(this)
