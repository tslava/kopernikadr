package pl.slava.kopernikadr.remote

import com.getcapacitor.BridgeActivity

// Kotlin (not the template's Java): the in-app plugin lives in package `...remote.native`, and
// `native` is a reserved word in Java. In-app plugins are registered in onCreate *before*
// super.onCreate, e.g.:
//   override fun onCreate(savedInstanceState: Bundle?) {
//       registerPlugin(KopernikadrNativePlugin::class.java)
//       super.onCreate(savedInstanceState)
//   }
class MainActivity : BridgeActivity()
