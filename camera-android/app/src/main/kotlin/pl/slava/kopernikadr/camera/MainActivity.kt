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
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
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
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.net.Inet4Address
import java.net.InetAddress
import pl.slava.kopernikadr.camera.camera.CameraController
import pl.slava.kopernikadr.camera.host.ServerHost
import pl.slava.kopernikadr.camera.screen.ScreenPolicy
import pl.slava.kopernikadr.camera.ui.PermissionScreen
import pl.slava.kopernikadr.camera.ui.StatusScreen

class MainActivity : ComponentActivity() {
    private var wifiIp by mutableStateOf<String?>(null)
    private var diagnosticsOpen by mutableStateOf(false)
    private var cameraGranted by mutableStateOf(false)

    // ScreenPolicy: dims the window after 2 min without a touch or a remote command.
    private var screenPolicy = ScreenPolicy(SystemClock::elapsedRealtime)
    private val main = Handler(Looper.getMainLooper())
    private var dimmed = false
    private val dimTick = object : Runnable {
        override fun run() {
            applyBrightness()
            main.postDelayed(this, DIM_TICK_MS)
        }
    }

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
        // Debug builds only: `--ei idle_ms N` shortens the dim delay for device checks (release and probe stay 2 min).
        if (BuildConfig.DEBUG) {
            intent.getIntExtra(EXTRA_IDLE_MS, 0).takeIf { it > 0 }?.let {
                screenPolicy = ScreenPolicy(SystemClock::elapsedRealtime, it.toLong())
                Log.i(TAG_SCREEN, "debug idle override: $it ms")
            }
        }
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
                        // No dim while the waiting card (with the QR) shows, nor while diagnostics run.
                        val waitingCard = wifiIp != null && serverState.error == null && serverState.port != null && !serverState.connected
                        SideEffect { screenPolicy.setQrShown(waitingCard || diagnosticsOpen) }
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

    override fun onResume() {
        super.onResume()
        screenPolicy.onResume()
        server.onActivity = { screenPolicy.onActivity(); main.post { applyBrightness() } }
        main.post(dimTick)
    }

    override fun onPause() {
        main.removeCallbacks(dimTick)
        server.onActivity = null
        setDimmed(false)
        super.onPause()
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        screenPolicy.onActivity()
        applyBrightness()
        return super.dispatchTouchEvent(ev)
    }

    private fun applyBrightness() = setDimmed(screenPolicy.shouldDim())

    /** Window brightness only; FLAG_KEEP_SCREEN_ON stays so the server and NSD keep running. */
    private fun setDimmed(dim: Boolean) {
        if (dim == dimmed) return
        dimmed = dim
        val lp = window.attributes
        lp.screenBrightness = if (dim) DIM_BRIGHTNESS else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = lp
        Log.i(TAG_SCREEN, if (dim) "dim" else "bright")
    }

    override fun onStop() {
        server.stop()
        connectivity.unregisterNetworkCallback(wifiCallback)
        super.onStop()
    }

    private companion object {
        const val TAG_SCREEN = "KopernikadrScreen"
        const val EXTRA_IDLE_MS = "idle_ms"
        const val DIM_BRIGHTNESS = 0.05f
        const val DIM_TICK_MS = 1_000L
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
