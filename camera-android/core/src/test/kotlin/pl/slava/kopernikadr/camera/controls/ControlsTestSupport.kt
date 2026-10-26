package pl.slava.kopernikadr.camera.controls

import org.junit.Assert.assertNotNull
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.CompensationCapability
import pl.slava.kopernikadr.camera.protocol.ExposureCapability
import pl.slava.kopernikadr.camera.protocol.ExposureLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusCapability
import pl.slava.kopernikadr.camera.protocol.FocusLockCapability
import pl.slava.kopernikadr.camera.protocol.FocusLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.Rational
import pl.slava.kopernikadr.camera.protocol.SetControlArgs
import pl.slava.kopernikadr.camera.protocol.Size
import pl.slava.kopernikadr.camera.protocol.Sizes
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceCapability
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceLockMethod

object TestCaps {
    /** moto g05: FULL + MANUAL_SENSOR + MANUAL_POST_PROCESSING, every lock is a freeze. */
    val G05 = Capabilities(
        aspect = "4:3",
        sizes = Sizes(Size(3264, 2448), Size(1440, 1080), Size(256, 192)),
        rotations = listOf(0, 180),
        exposure = ExposureCapability(
            lock = true,
            method = ExposureLockMethod.FREEZE,
            compensation = CompensationCapability(true, -4, 4, Rational(1, 2)),
        ),
        whiteBalance = WhiteBalanceCapability(true, WhiteBalanceLockMethod.FREEZE),
        focusLock = FocusLockCapability(FocusLockMethod.FREEZE),
        focus = FocusCapability(listOf(FocusMode.AUTO, FocusMode.LOCKED), 10.0),
        previewQualities = PreviewQuality.entries,
    )

    /** The Camera2 lock fallbacks. */
    val FALLBACK = G05.copy(
        exposure = G05.exposure.copy(method = ExposureLockMethod.AE_LOCK),
        whiteBalance = WhiteBalanceCapability(true, WhiteBalanceLockMethod.AWB_LOCK),
        focusLock = FocusLockCapability(FocusLockMethod.AF_LOCK),
    )

    /** No locks, no compensation, fixed-focus lens. */
    val BARE = G05.copy(
        exposure = ExposureCapability(false, null, CompensationCapability(false, 0, 0, Rational(0, 1))),
        whiteBalance = WhiteBalanceCapability(false, null),
        focusLock = FocusLockCapability(null),
        focus = FocusCapability(listOf(FocusMode.FIXED), 0.0),
    )
}

val GAINS = ColorGains(1.9f, 1.0f, 1.0f, 1.6f)
val TRANSFORM = ColorTransform(listOf(1.5, -0.4, -0.1, -0.2, 1.4, -0.2, 0.0, -0.6, 1.6))

/** A result of the auto pipeline with everything converged/locked by AF. */
fun autoResult(frame: Long) = ResultSummary(
    frameNumber = frame,
    aeMode = Camera2.AE_MODE_ON,
    aeState = Camera2.AE_STATE_CONVERGED,
    aeLock = false,
    iso = 400,
    exposureTimeNs = 20_000_000L,
    frameDurationNs = 33_333_333L,
    awbMode = Camera2.AWB_MODE_AUTO,
    awbState = Camera2.AWB_STATE_CONVERGED,
    awbLock = false,
    ccMode = Camera2.COLOR_CORRECTION_MODE_FAST,
    gains = GAINS,
    transform = TRANSFORM,
    afMode = Camera2.AF_MODE_AUTO,
    afState = Camera2.AF_STATE_FOCUSED_LOCKED,
    lensState = Camera2.LENS_STATE_STATIONARY,
    focusDistance = 9.5f,
    compensation = 0,
)

/** A result where nothing has converged yet. */
fun searchingResult(frame: Long) = autoResult(frame).copy(
    aeState = Camera2.AE_STATE_SEARCHING,
    awbState = Camera2.AWB_STATE_SEARCHING,
    afState = Camera2.AF_STATE_ACTIVE_SCAN,
    lensState = Camera2.LENS_STATE_MOVING,
)

/** A result that echoes the frozen manual values of [autoResult]. */
fun frozenResult(frame: Long) = autoResult(frame).copy(
    aeMode = Camera2.AE_MODE_OFF,
    aeState = Camera2.AE_STATE_INACTIVE,
    awbMode = Camera2.AWB_MODE_OFF,
    awbState = Camera2.AWB_STATE_INACTIVE,
    ccMode = Camera2.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX,
    afMode = Camera2.AF_MODE_OFF,
    afState = Camera2.AF_STATE_INACTIVE,
)

/** A result of the Camera2 locks (fallback methods) holding. */
fun lockedResult(frame: Long) = autoResult(frame).copy(
    aeState = Camera2.AE_STATE_LOCKED,
    aeLock = true,
    awbState = Camera2.AWB_STATE_LOCKED,
    awbLock = true,
)

class MemoryStore : KeyValueStore {
    val map = mutableMapOf<String, String>()
    var puts = 0

    override fun get(key: String): String? = map[key]

    override fun put(key: String, value: String) {
        puts++
        map[key] = value
    }
}

/** Drives a [ControlsEngine] like the Android adapter: a clock and a frame counter. */
class Rig(
    caps: Capabilities = TestCaps.G05,
    val store: MemoryStore = MemoryStore(),
    var now: Long = 10_000L,
    val config: ControlsConfig = ControlsConfig(),
) {
    val engine = ControlsEngine(caps, store, config)
    var frame = 100L
    val controls get() = engine.controls
    val state get() = engine.state

    fun set(args: SetControlArgs): ControlsUpdate = when (val r = engine.setControl(args, now)) {
        is SetControlOutcome.Ok -> r.update
        is SetControlOutcome.Rejected -> throw AssertionError("rejected: ${r.error}")
    }

    fun reject(args: SetControlArgs) = when (val r = engine.setControl(args, now)) {
        is SetControlOutcome.Ok -> throw AssertionError("expected a rejection, got ${r.update}")
        is SetControlOutcome.Rejected -> r.error
    }

    fun lock(control: String) = set(SetControlArgs(control, mode = "locked"))
    fun unlock(control: String) = set(SetControlArgs(control, mode = "auto"))

    /** The fence of the current generation at the next frame number. */
    fun fence(): ControlsUpdate = engine.onFence(engine.state.generation, ++frame, now)

    /** A result built for the next frame number. */
    fun result(build: (Long) -> ResultSummary): ControlsUpdate = engine.onResult(build(++frame), now)

    fun tick(advanceMs: Long): ControlsUpdate {
        now += advanceMs
        return engine.onTick(now)
    }

    /** Lock with fence + converged result + fence + echo: the happy path, returning the last update. */
    fun lockAndConfirm(control: String, converged: (Long) -> ResultSummary = ::autoResult, echo: (Long) -> ResultSummary = ::frozenResult): ControlsUpdate {
        lock(control)
        fence()
        val metered = result(converged)
        assertNotNull("converged result must apply a new generation", metered.step.apply)
        fence()
        return result(echo)
    }
}

fun ControlsUpdate.options(): Map<RequestOption, Any> = requireNotNull(step.apply) { "no apply in $this" }.options
