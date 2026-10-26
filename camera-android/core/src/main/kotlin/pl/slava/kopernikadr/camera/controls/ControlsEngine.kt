package pl.slava.kopernikadr.camera.controls

import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.ProtocolError
import pl.slava.kopernikadr.camera.protocol.SetControlArgs

/** The result of an input: what to do ([step]) and the wire controls after it. */
data class ControlsUpdate(
    val step: Step,
    val controls: Controls,
    /** Emit a `controls` event (the wire controls differ from before the input). */
    val controlsChanged: Boolean,
)

sealed interface SetControlOutcome {
    /** Answer the request with [ControlsUpdate.controls]; run [ControlsUpdate.step]. */
    data class Ok(val update: ControlsUpdate) : SetControlOutcome
    data class Rejected(val error: ProtocolError) : SetControlOutcome
}

/**
 * The controls as the Android adapter drives them: state + persistence around the pure
 * [ConfirmationMachine]. Not thread-safe: call from one thread (the camera executor).
 *
 * Adapter contract (nowMs = a monotonic clock, e.g. `SystemClock.elapsedRealtime()`):
 * - after every (re)bind of the camera use cases: [onCameraBound];
 * - every `TotalCaptureResult` of the repeating request: [onResult] with its [ResultSummary];
 * - when the `setCaptureRequestOptions` future of an [Apply] completes: [onFence] with that
 *   generation and the frame number of the result that completed it;
 * - every ~100 ms while [Controls.settling]: [onTick];
 * - `setControl`: [setControl].
 * After each, run the returned [Step]; when [ControlsUpdate.controlsChanged], send a `controls`
 * event. The intent and frozen values are written to [store] whenever they change.
 */
class ControlsEngine(
    caps: Capabilities,
    private val store: KeyValueStore,
    private val config: ControlsConfig = ControlsConfig(),
) {
    var state: ControlsState = ControlsPersistence.load(store, caps)
        private set

    private var saved: ControlsSnapshot = ControlsPersistence.snapshot(state)

    val controls: Controls get() = ControlsReducer.reduce(state)

    /** The option set of the current generation (e.g. for a still request built by hand). */
    val options: Map<RequestOption, Any> get() = ControlsPlan.options(state)

    fun setControl(args: SetControlArgs, nowMs: Long): SetControlOutcome =
        when (val r = SetControlHandler.handle(state, args, nowMs, config)) {
            is SetControlHandler.Result.Ok -> SetControlOutcome.Ok(commit(r.transition))
            is SetControlHandler.Result.Rejected -> SetControlOutcome.Rejected(r.error)
        }

    fun onCameraBound(nowMs: Long): ControlsUpdate = commit(ConfirmationMachine.onCameraBound(state, nowMs, config))

    fun onFence(generation: Long, frameNumber: Long, nowMs: Long): ControlsUpdate =
        commit(ConfirmationMachine.onFence(state, generation, frameNumber, nowMs, config))

    fun onResult(result: ResultSummary, nowMs: Long): ControlsUpdate =
        commit(ConfirmationMachine.onResult(state, result, nowMs, config))

    fun onTick(nowMs: Long): ControlsUpdate = commit(ConfirmationMachine.onTick(state, nowMs))

    private fun commit(t: Transition): ControlsUpdate {
        val before = controls
        state = t.state
        val snap = ControlsPersistence.snapshot(state)
        if (snap != saved) {
            store.put(ControlsPersistence.KEY, ControlsPersistence.encode(snap))
            saved = snap
        }
        val after = controls
        return ControlsUpdate(t.step, after, after != before)
    }
}
