package pl.slava.kopernikadr.camera.camera

import java.util.Locale
import pl.slava.kopernikadr.camera.controls.Camera2
import pl.slava.kopernikadr.camera.controls.ResultSummary

/**
 * Compact log form of a result, e.g.
 * `#123 ae=ON/CONVERGED iso=200 t=10.000ms fd=33.333ms awb=AUTO/CONVERGED gains=… af=CONTINUOUS_PICTURE/PASSIVE_FOCUSED lens=STATIONARY d=4.10dpt ts=…`.
 */
fun ResultSummary.short(): String = buildString {
    append('#').append(frameNumber)
    append(" ae=").append(Camera2Names.aeMode(aeMode)).append('/').append(Camera2Names.aeState(aeState))
    append(" iso=").append(iso)
    append(" t=").append(exposureTimeNs?.let { fmt("%.3fms", it / 1e6) })
    append(" fd=").append(frameDurationNs?.let { fmt("%.3fms", it / 1e6) })
    append(" awb=").append(Camera2Names.awbMode(awbMode)).append('/').append(Camera2Names.awbState(awbState))
    append(" gains=").append(gains?.let { g -> listOf(g.r, g.gEven, g.gOdd, g.b).joinToString(",") { fmt("%.3f", it) } })
    append(" af=").append(Camera2Names.afMode(afMode)).append('/').append(Camera2Names.afState(afState))
    append(" lens=").append(Camera2Names.lensState(lensState))
    append(" d=").append(focusDistance?.let { fmt("%.2fdpt", it) })
    append(" ts=").append(timestampNs)
}

private fun fmt(pattern: String, v: Any): String = String.format(Locale.ROOT, pattern, v)

/** Names of the [Camera2] int values for logs; `null` / `UNKNOWN_<n>` otherwise. */
object Camera2Names {
    fun aeMode(v: Int?) = name(v, mapOf(Camera2.AE_MODE_OFF to "OFF", Camera2.AE_MODE_ON to "ON"))

    fun aeState(v: Int?) = name(
        v,
        mapOf(
            Camera2.AE_STATE_INACTIVE to "INACTIVE", Camera2.AE_STATE_SEARCHING to "SEARCHING",
            Camera2.AE_STATE_CONVERGED to "CONVERGED", Camera2.AE_STATE_LOCKED to "LOCKED",
            Camera2.AE_STATE_FLASH_REQUIRED to "FLASH_REQUIRED", Camera2.AE_STATE_PRECAPTURE to "PRECAPTURE",
        ),
    )

    fun awbMode(v: Int?) = name(v, mapOf(Camera2.AWB_MODE_OFF to "OFF", Camera2.AWB_MODE_AUTO to "AUTO"))

    fun awbState(v: Int?) = name(
        v,
        mapOf(
            Camera2.AWB_STATE_INACTIVE to "INACTIVE", Camera2.AWB_STATE_SEARCHING to "SEARCHING",
            Camera2.AWB_STATE_CONVERGED to "CONVERGED", Camera2.AWB_STATE_LOCKED to "LOCKED",
        ),
    )

    fun afMode(v: Int?) = name(
        v,
        mapOf(
            Camera2.AF_MODE_OFF to "OFF", Camera2.AF_MODE_AUTO to "AUTO", Camera2.AF_MODE_MACRO to "MACRO",
            Camera2.AF_MODE_CONTINUOUS_VIDEO to "CONTINUOUS_VIDEO", Camera2.AF_MODE_CONTINUOUS_PICTURE to "CONTINUOUS_PICTURE",
        ),
    )

    fun afState(v: Int?) = name(
        v,
        mapOf(
            Camera2.AF_STATE_INACTIVE to "INACTIVE", Camera2.AF_STATE_PASSIVE_SCAN to "PASSIVE_SCAN",
            Camera2.AF_STATE_PASSIVE_FOCUSED to "PASSIVE_FOCUSED", Camera2.AF_STATE_ACTIVE_SCAN to "ACTIVE_SCAN",
            Camera2.AF_STATE_FOCUSED_LOCKED to "FOCUSED_LOCKED", Camera2.AF_STATE_NOT_FOCUSED_LOCKED to "NOT_FOCUSED_LOCKED",
            Camera2.AF_STATE_PASSIVE_UNFOCUSED to "PASSIVE_UNFOCUSED",
        ),
    )

    fun lensState(v: Int?) = name(v, mapOf(Camera2.LENS_STATE_STATIONARY to "STATIONARY", Camera2.LENS_STATE_MOVING to "MOVING"))

    private fun name(v: Int?, names: Map<Int, String>): String = if (v == null) "null" else names[v] ?: "UNKNOWN_$v"
}
