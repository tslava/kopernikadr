package pl.slava.kopernikadr.camera

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.util.Log
import pl.slava.kopernikadr.camera.camera.CameraControls
import pl.slava.kopernikadr.camera.camera.CameraController
import pl.slava.kopernikadr.camera.camera.CharacteristicsReader
import pl.slava.kopernikadr.camera.camera.PrefsKeyValueStore
import pl.slava.kopernikadr.camera.core.CapabilityMapper
import pl.slava.kopernikadr.camera.host.ServerHost

class App : Application() {
    /** Application-scoped; [MainActivity] attaches it to its lifecycle once CAMERA is granted. */
    lateinit var camera: CameraController
        private set

    @Volatile
    private var _controls: CameraControls? = null

    /** The controls adapter (also the server's `ControlsPort`), or null before [ensureControls]. */
    val controls: CameraControls? get() = _controls

    /** The camera server; [MainActivity] starts it on ON_START and stops it on ON_STOP. */
    val server: ServerHost by lazy { ServerHost(this) }

    override fun onCreate() {
        super.onCreate()
        camera = CameraController(this, onReadyChanged = { ready ->
            if (ready) ensureControls()
            diagHook.onCameraBound(ready)
        })
        diagHook.onAppCreate(this)
    }

    /**
     * Creates the controls once (capabilities from the back camera's characteristics, intents from
     * the prefs). Idempotent and thread-safe; null without the CAMERA permission or if the
     * characteristics cannot be read (logged). Called on the first camera open; the server may
     * call it earlier, once CAMERA is granted.
     */
    fun ensureControls(): CameraControls? {
        _controls?.let { return it }
        synchronized(this) {
            _controls?.let { return it }
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return null
            return try {
                val reader = CharacteristicsReader(this)
                val caps = CapabilityMapper.map(reader.read(reader.backCameraId()))
                val store = PrefsKeyValueStore(getSharedPreferences(CONTROLS_PREFS, MODE_PRIVATE))
                CameraControls(camera, caps, store).also { _controls = it }
            } catch (e: Exception) {
                Log.e(CameraControls.TAG, "cannot create the controls", e)
                null
            }
        }
    }

    companion object {
        const val CONTROLS_PREFS = "controls"
    }
}
