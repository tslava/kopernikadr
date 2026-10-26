package pl.slava.kopernikadr.camera.host

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import pl.slava.kopernikadr.camera.protocol.Controls
import pl.slava.kopernikadr.camera.protocol.ErrorCodes
import pl.slava.kopernikadr.camera.protocol.ProtocolError
import pl.slava.kopernikadr.camera.server.ControlChange
import pl.slava.kopernikadr.camera.server.ControlsPort
import pl.slava.kopernikadr.camera.server.PortResult

/**
 * [ControlsPort] serialized with capture admission (§4.5). Every change takes the capture
 * [admission] mutex, which a capture holds from its admission (settling check) until its still
 * has been taken. So a change waits for an in-flight still, a capture waits for a change being
 * applied, and an exposure / white balance / focus change can never start a new metering
 * generation between a capture's settling check and its still. A rotation change is rejected
 * with `CAPTURE_IN_PROGRESS` while a capture runs (each capture keeps its admitted transform).
 */
class GuardedControls(
    private val delegate: ControlsPort,
    private val admission: Mutex,
    private val isCapturing: () -> Boolean,
) : ControlsPort {
    override fun get(): Controls = delegate.get()

    override val updates: Flow<Controls> get() = delegate.updates

    override suspend fun set(change: ControlChange): PortResult<Controls> = admission.withLock {
        if (change is ControlChange.Rotation && isCapturing()) {
            PortResult.Err(ProtocolError(ErrorCodes.CAPTURE_IN_PROGRESS, "cannot change rotation while a capture runs"))
        } else {
            delegate.set(change)
        }
    }
}
