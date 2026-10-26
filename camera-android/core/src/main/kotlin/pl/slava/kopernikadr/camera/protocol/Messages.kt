package pl.slava.kopernikadr.camera.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

// Data types of PROTOCOL.md §3, §6 and §7. Field names are the wire names.

@Serializable
data class VersionRange(val min: Int, val max: Int) {
    init {
        require(min in 1..max) { "invalid protocol version range $min-$max" }
    }

    /** The highest version both ranges support, or null if they do not overlap. */
    fun highestCommon(other: VersionRange): Int? =
        minOf(max, other.max).takeIf { it >= maxOf(min, other.min) }
}

/** Body of `GET /info`. */
@Serializable
data class Info(
    val cameraId: String,
    val name: String,
    val bootId: String,
    val protocolVersions: VersionRange,
)

@Serializable
data class Size(val w: Int, val h: Int)

@Serializable
data class Rational(val num: Int, val den: Int)

// --- Capabilities ---

@Serializable
data class Sizes(val full: Size, val play: Size, val thumb: Size)

@Serializable
data class CompensationCapability(
    val supported: Boolean,
    val minSteps: Int,
    val maxSteps: Int,
    val stepEv: Rational,
)

@Serializable
enum class ExposureLockMethod {
    @SerialName("freeze") FREEZE,
    @SerialName("ae_lock") AE_LOCK,
}

@Serializable
enum class WhiteBalanceLockMethod {
    @SerialName("freeze") FREEZE,
    @SerialName("awb_lock") AWB_LOCK,
}

@Serializable
enum class FocusLockMethod {
    @SerialName("freeze") FREEZE,
    @SerialName("af_lock") AF_LOCK,
}

/** `method == null` (absent on the wire) with `lock == false` means "not supported". */
@Serializable
data class ExposureCapability(
    val lock: Boolean,
    val method: ExposureLockMethod? = null,
    val compensation: CompensationCapability,
)

@Serializable
data class WhiteBalanceCapability(val lock: Boolean, val method: WhiteBalanceLockMethod? = null)

@Serializable
data class FocusLockCapability(val method: FocusLockMethod? = null)

@Serializable
data class FocusCapability(val modes: List<FocusMode>, val minFocusDistanceDiopters: Double? = null)

@Serializable
data class Capabilities(
    val aspect: String,
    val sizes: Sizes,
    val rotations: List<Int>,
    val exposure: ExposureCapability,
    val whiteBalance: WhiteBalanceCapability,
    val focusLock: FocusLockCapability,
    val focus: FocusCapability,
    val previewQualities: List<PreviewQuality>,
)

// --- Controls ---

/** Mode of the exposure and white-balance controls. */
@Serializable
enum class ControlMode {
    @SerialName("auto") AUTO,
    @SerialName("locked") LOCKED,
    @SerialName("failed") FAILED,
    @SerialName("unsupported") UNSUPPORTED,
}

@Serializable
enum class FocusMode {
    @SerialName("auto") AUTO,
    @SerialName("locked") LOCKED,
    @SerialName("fixed") FIXED,
}

@Serializable
enum class PreviewQuality {
    @SerialName("low") LOW,
    @SerialName("normal") NORMAL,
    @SerialName("high") HIGH,
}

@Serializable
data class ExposureControl(
    val mode: ControlMode,
    val confirmed: Boolean,
    val exact: Boolean,
    val compensationSteps: Int,
    val compensationEnabled: Boolean,
)

@Serializable
data class WhiteBalanceControl(val mode: ControlMode, val confirmed: Boolean, val exact: Boolean)

@Serializable
data class FocusControl(val mode: FocusMode, val confirmed: Boolean, val focusOk: Boolean)

@Serializable
data class Controls(
    val generation: Long,
    val settling: Boolean,
    val exposure: ExposureControl,
    val whiteBalance: WhiteBalanceControl,
    val focus: FocusControl,
    val rotation: Int,
    val previewQuality: PreviewQuality,
)

// --- Status ---

@Serializable
enum class Thermal {
    @SerialName("none") NONE,
    @SerialName("light") LIGHT,
    @SerialName("moderate") MODERATE,
    @SerialName("severe") SEVERE,
    @SerialName("critical") CRITICAL,
    @SerialName("emergency") EMERGENCY,
    @SerialName("shutdown") SHUTDOWN,
    @SerialName("unknown") UNKNOWN,
}

@Serializable
data class Status(
    val batteryPct: Int,
    val charging: Boolean,
    val freeBytes: Long,
    val spoolBytes: Long,
    val unackedCount: Int,
    val orphanCount: Int,
    val integrityErrors: Int,
    val thermal: Thermal,
)

// --- Operation results ---

/** `data` of a granted `hello`. */
@Serializable
data class HelloData(
    val cameraId: String,
    val bootId: String,
    val sessionId: String,
    val name: String,
    val protocolVersion: Int,
    val capabilities: Capabilities,
    val controls: Controls,
    val status: Status,
    val sessionTtlMs: Long,
)

@Serializable
data class PingData(val serverTimeMs: Long)

@Serializable
data class FullImage(val w: Int, val h: Int, val bytes: Long, val sha256: String)

/** Display caches; no hash, never an export source. */
@Serializable
data class DerivedImages(val play: Size, val thumb: Size)

/** Optional diagnostics of a still. */
@Serializable
data class ExposureInfo(val iso: Int, val exposureTimeNs: Long)

/** `data` of `capture`, `result` of a done `getOperation`. */
@Serializable
data class FrameInfo(
    val frameId: String,
    val seq: Long,
    val projectId: String,
    val clientId: String,
    val rotation: Int,
    /** ISO-8601 UTC with milliseconds, e.g. `2026-10-26T15:04:05.123Z`. */
    val capturedAt: String,
    val full: FullImage,
    val derived: DerivedImages,
    val exposure: ExposureInfo? = null,
)

/** `error` of a failed `getOperation` (no `retryable`: the remote never retries it). */
@Serializable
data class OperationError(val code: String, val message: String)

/**
 * `data` of `getOperation`. Encode it through [OperationState.serializer] (or a reified
 * `OperationState`), not a subclass serializer, or the `state` field is lost.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("state")
sealed interface OperationState {
    @Serializable
    @SerialName("done")
    data class Done(val result: FrameInfo) : OperationState

    @Serializable
    @SerialName("pending")
    data object Pending : OperationState

    @Serializable
    @SerialName("failed")
    data class Failed(val error: OperationError) : OperationState

    @Serializable
    @SerialName("unknown")
    data object Unknown : OperationState
}

// --- Preview WS (§7) ---

/** Lock modes as in [Controls], at the frame's `generation`. */
@Serializable
data class PreviewLocks(val exposure: ControlMode, val whiteBalance: ControlMode, val focus: FocusMode)

/** JSON header of a preview binary message. `ts`: camera wall clock, epoch ms, frame produced. */
@Serializable
data class PreviewHeader(
    val seq: Long,
    val bootId: String,
    val generation: Long,
    val w: Int,
    val h: Int,
    val ts: Long,
    val locks: PreviewLocks,
)

/** Text message from the preview client. */
@Serializable
data class PreviewNext(val t: String = NEXT) {
    companion object {
        const val NEXT = "next"
    }
}
