package pl.slava.kopernikadr.camera

import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import java.net.Inet4Address
import java.net.InetAddress

class MainActivity : ComponentActivity() {
    private var wifiIp by mutableStateOf<String?>(null)

    private val connectivity by lazy { getSystemService(ConnectivityManager::class.java) }

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
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                PlaceholderStatus(wifiIp)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        val wifi = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        connectivity.registerNetworkCallback(wifi, wifiCallback)
    }

    override fun onStop() {
        connectivity.unregisterNetworkCallback(wifiCallback)
        super.onStop()
    }
}

internal fun firstIpv4(addresses: List<InetAddress>): String? =
    addresses.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }?.hostAddress

@Composable
private fun PlaceholderStatus(wifiIp: String?) {
    Surface(Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.fillMaxSize().safeDrawingPadding(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(stringResource(R.string.status_title), style = MaterialTheme.typography.displaySmall)
            Text(
                text = wifiIp?.let { stringResource(R.string.status_ip, it) }
                    ?: stringResource(R.string.status_no_wifi),
                style = MaterialTheme.typography.headlineSmall,
            )
        }
    }
}
