package pl.slava.kopernikadr.remote

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import pl.slava.kopernikadr.remote.native.KopernikadrNativePlugin

// Kotlin (not the template's Java): the in-app plugin lives in package `...remote.native`, and
// `native` is a reserved word in Java. In-app plugins are registered before super.onCreate.
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(KopernikadrNativePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
