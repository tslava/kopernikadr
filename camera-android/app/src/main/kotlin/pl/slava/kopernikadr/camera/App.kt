package pl.slava.kopernikadr.camera

import android.app.Application
import pl.slava.kopernikadr.camera.camera.CameraController

class App : Application() {
    /** Application-scoped; [MainActivity] attaches it to its lifecycle once CAMERA is granted. */
    lateinit var camera: CameraController
        private set

    override fun onCreate() {
        super.onCreate()
        camera = CameraController(this, onReadyChanged = { diagHook.onCameraBound(it) })
        diagHook.onAppCreate(this)
    }
}
