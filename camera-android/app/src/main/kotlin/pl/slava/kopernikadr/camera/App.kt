package pl.slava.kopernikadr.camera

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        diagHook.onAppCreate(this)
    }
}
