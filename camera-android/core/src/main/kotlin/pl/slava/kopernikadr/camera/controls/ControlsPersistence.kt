package pl.slava.kopernikadr.camera.controls

import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.ExposureLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusLockMethod
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceLockMethod

/** Durable key-value port. `put` must be synchronous (Android: `SharedPreferences.commit()`). */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
}

/** What survives a restart: intents, the methods they were made with, frozen values, settings. */
@Serializable
data class ControlsSnapshot(
    val version: Int = 1,
    val exposure: LockIntent,
    val whiteBalance: LockIntent,
    val focus: LockIntent,
    val exposureMethod: ExposureLockMethod? = null,
    val whiteBalanceMethod: WhiteBalanceLockMethod? = null,
    val focusMethod: FocusLockMethod? = null,
    val compensationSteps: Int = 0,
    val rotation: Int = 0,
    val previewQuality: PreviewQuality = PreviewQuality.NORMAL,
    val frozenExposure: FrozenExposure? = null,
    val frozenWhiteBalance: FrozenWhiteBalance? = null,
    val frozenFocus: FrozenFocus? = null,
)

object ControlsPersistence {
    const val KEY = "camera.controls.v1"

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    fun snapshot(s: ControlsState) = ControlsSnapshot(
        exposure = s.exposure.intent,
        whiteBalance = s.whiteBalance.intent,
        focus = s.focus.intent,
        exposureMethod = s.exposureMethod,
        whiteBalanceMethod = s.whiteBalanceMethod,
        focusMethod = s.focusMethod,
        compensationSteps = s.compensationSteps,
        rotation = s.rotation,
        previewQuality = s.previewQuality,
        frozenExposure = s.frozenExposure,
        frozenWhiteBalance = s.frozenWhiteBalance,
        frozenFocus = s.frozenFocus,
    )

    fun encode(s: ControlsSnapshot): String = json.encodeToString(ControlsSnapshot.serializer(), s)

    /** Null for missing or unreadable data (the controls then start in auto). */
    fun decode(text: String): ControlsSnapshot? = try {
        json.decodeFromString(ControlsSnapshot.serializer(), text)
    } catch (e: SerializationException) {
        null
    } catch (e: IllegalArgumentException) {
        null
    }

    /**
     * The state at start, before the camera binds: locked intents are `Pending` (settling) and
     * [ConfirmationMachine.onCameraBound] re-applies frozen values or re-meters. Frozen values made
     * with another method than the device's current one are dropped (re-metered); a lock the
     * device no longer offers falls back to auto; settings are clamped to the capabilities.
     */
    fun restore(caps: Capabilities, snap: ControlsSnapshot?): ControlsState {
        val base = ControlsState(caps)
        if (snap == null) return base
        fun lock(intent: LockIntent, supported: Boolean) =
            if (intent == LockIntent.LOCKED && supported) ControlLock(LockIntent.LOCKED, LockPhase.Pending, exact = true)
            else ControlLock()
        val comp = caps.exposure.compensation
        val s = base.copy(
            exposure = lock(snap.exposure, base.exposureMethod != null),
            whiteBalance = lock(snap.whiteBalance, base.whiteBalanceMethod != null),
            focus = lock(snap.focus, base.focusMethod != null),
            compensationSteps = if (comp.supported) snap.compensationSteps.coerceIn(comp.minSteps, comp.maxSteps) else 0,
            rotation = snap.rotation.takeIf { it in caps.rotations } ?: base.rotation,
            previewQuality = snap.previewQuality.takeIf { it in caps.previewQualities } ?: base.previewQuality,
        )
        return s.copy(
            frozenExposure = snap.frozenExposure.takeIf {
                s.exposure.intent == LockIntent.LOCKED && snap.exposureMethod == s.exposureMethod && s.exposureMethod == ExposureLockMethod.FREEZE
            },
            frozenWhiteBalance = snap.frozenWhiteBalance.takeIf {
                s.whiteBalance.intent == LockIntent.LOCKED && snap.whiteBalanceMethod == s.whiteBalanceMethod &&
                    s.whiteBalanceMethod == WhiteBalanceLockMethod.FREEZE
            },
            frozenFocus = snap.frozenFocus.takeIf {
                s.focus.intent == LockIntent.LOCKED && snap.focusMethod == s.focusMethod && s.focusMethod == FocusLockMethod.FREEZE
            },
        ).let { st -> st.copy(focus = st.focus.copy(focusOk = st.frozenFocus?.focusOk ?: true)) }
    }

    fun load(store: KeyValueStore, caps: Capabilities): ControlsState =
        restore(caps, store.get(KEY)?.let(::decode))
}
