package pl.slava.kopernikadr.camera.diag

import kotlinx.serialization.json.JsonPrimitive
import pl.slava.kopernikadr.camera.core.CapabilityMapper
import pl.slava.kopernikadr.camera.core.CharacteristicsSnapshot
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.ProtocolJson

/**
 * `caps`: dumps the back camera's characteristics (`snapshot`) and what the camera will announce
 * in `hello` (`capabilities`). The snapshot is in the report even if the mapping fails.
 */
class CapsProbe(private val read: () -> CharacteristicsSnapshot) : Probe {
    override suspend fun run(ctx: ProbeContext) {
        ctx.step("reading characteristics")
        val snapshot = read()
        ctx.put("snapshot", CharacteristicsSnapshot.Json.encodeToJsonElement(CharacteristicsSnapshot.serializer(), snapshot))
        ctx.step("mapping capabilities")
        val caps = CapabilityMapper.map(snapshot)
        ctx.put("capabilities", ProtocolJson.encodeToJsonElement(Capabilities.serializer(), caps))
        ctx.put("summary", JsonPrimitive(summary(snapshot, caps)))
        ctx.step("done")
    }

    private fun summary(s: CharacteristicsSnapshot, c: Capabilities): String = listOf(
        "camera ${s.cameraId} ${s.hardwareLevel}",
        "full ${c.sizes.full.w}x${c.sizes.full.h}",
        "exposure ${c.exposure.method?.name?.lowercase() ?: "none"}",
        "wb ${c.whiteBalance.method?.name?.lowercase() ?: "none"}",
        "focus ${c.focusLock.method?.name?.lowercase() ?: "fixed"} (min ${s.minFocusDistanceDiopters} dpt, ${s.focusDistanceCalibration})",
        "sensor ${s.sensorOrientation}°",
        "camera permission ${if (s.cameraPermissionGranted == true) "granted" else "missing"}",
    ).joinToString(" · ")

    companion object {
        const val NAME = "caps"
    }
}
