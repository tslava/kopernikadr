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
 * [ControlsPort] that rejects a rotation change with `CAPTURE_IN_PROGRESS` while a capture runs
 * (§4.5). Rotation changes take the capture [admission] mutex, so one cannot slip in between a
 * capture's admission and its start.
 */
class GuardedControls(
    private val delegate: ControlsPort,
    private val admission: Mutex,
    private val isCapturing: () -> Boolean,
) : ControlsPort {
    override fun get(): Controls = delegate.get()

    override val updates: Flow<Controls> get() = delegate.updates

    override suspend fun set(change: ControlChange): PortResult<Controls> {
        if (change !is ControlChange.Rotation) return delegate.set(change)
        return admission.withLock {
            if (isCapturing()) {
                PortResult.Err(ProtocolError(ErrorCodes.CAPTURE_IN_PROGRESS, "cannot change rotation while a capture runs"))
            } else {
                delegate.set(change)
            }
        }
    }
}
