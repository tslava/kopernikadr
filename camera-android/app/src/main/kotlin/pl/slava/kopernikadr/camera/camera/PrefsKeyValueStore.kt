package pl.slava.kopernikadr.camera.camera

import android.content.SharedPreferences
import android.util.Log
import pl.slava.kopernikadr.camera.controls.KeyValueStore

/** [KeyValueStore] over [SharedPreferences]; `put` is synchronous (`commit()`), as the port requires. */
class PrefsKeyValueStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun get(key: String): String? = prefs.getString(key, null)

    override fun put(key: String, value: String) {
        if (!prefs.edit().putString(key, value).commit()) Log.e(CameraControls.TAG, "prefs commit of $key failed")
    }
}
