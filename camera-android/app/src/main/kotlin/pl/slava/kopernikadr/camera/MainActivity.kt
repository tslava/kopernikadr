package pl.slava.kopernikadr.camera

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.net.Inet4Address
import java.net.InetAddress
import pl.slava.kopernikadr.camera.camera.CameraController
import pl.slava.kopernikadr.camera.host.ServerHost
import pl.slava.kopernikadr.camera.ui.PermissionScreen
import pl.slava.kopernikadr.camera.ui.StatusScreen

class MainActivity : ComponentActivity() {
    private var wifiIp by mutableStateOf<String?>(null)
    private var diagnosticsOpen by mutableStateOf(false)
    private var cameraGranted by mutableStateOf(false)

    private val camera: CameraController get() = (application as App).camera
    private val server: ServerHost get() = (application as App).server

    private val connectivity by lazy { getSystemService(ConnectivityManager::class.java) }

    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        Log.i(CameraController.TAG, "CAMERA permission ${if (granted) "granted" else "denied"}")
        if (granted) {
            onCameraGranted()
            server.start() // delivered while started
        }
    }

    private val wifiCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val ip = firstIpv4(linkProperties.linkAddresses.map { it.address })
            runOnUiThread { wifiIp = ip }
        }

        override fun onLost(network: Network) {
            runOnUiThread { wifiIp = null }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (savedInstanceState == null && diagHook.onIntent(intent)) diagnosticsOpen = true
        if (hasCameraPermission()) {
            onCameraGranted()
        } else if (savedInstanceState == null) {
            permissionRequest.launch(Manifest.permission.CAMERA)
        }
        val diagnosticsScreen = diagHook.diagnosticsScreen
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                // The status screen (with the viewfinder) stays composed under the diagnostics
                // screen, so the Preview keeps its surface while a probe runs (variant A).
                Box(Modifier.fillMaxSize()) {
                    if (cameraGranted) {
                        val status by camera.status.collectAsStateWithLifecycle()
                        val serverState by server.state.collectAsStateWithLifecycle()
                        StatusScreen(
                            wifiIp = wifiIp,
                            server = serverState,
                            camera = status,
                            onPreviewView = { view -> camera.setPreviewSurfaceProvider(view?.surfaceProvider) },
                            // Release has no diagnostics screen, so its title gets no long-press at all.
                            onTitleHeld = diagnosticsScreen?.let { { diagnosticsOpen = true } },
                        )
                    } else {
                        PermissionScreen(onRetry = { permissionRequest.launch(Manifest.permission.CAMERA) })
                    }
                    if (diagnosticsOpen && diagnosticsScreen != null) {
                        BackHandler { diagnosticsOpen = false }
                        diagnosticsScreen { diagnosticsOpen = false }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (diagHook.onIntent(intent)) diagnosticsOpen = true
    }

    override fun onStart() {
        super.onStart()
        // Granted from the settings (or by the parent) while we were stopped.
        if (!cameraGranted && hasCameraPermission()) onCameraGranted()
        val wifi = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        connectivity.registerNetworkCallback(wifi, wifiCallback)
        if (cameraGranted) server.start()
    }

    override fun onStop() {
        server.stop()
        connectivity.unregisterNetworkCallback(wifiCallback)
        super.onStop()
    }

    private fun hasCameraPermission() =
        checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    /** Camera binding starts only from here: the controller binds on this activity's ON_START. */
    private fun onCameraGranted() {
        cameraGranted = true
        camera.attach(this)
    }
}

internal fun firstIpv4(addresses: List<InetAddress>): String? =
    addresses.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }?.hostAddress
