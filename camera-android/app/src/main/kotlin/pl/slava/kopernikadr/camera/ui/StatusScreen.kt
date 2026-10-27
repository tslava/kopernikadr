package pl.slava.kopernikadr.camera.ui

import android.os.BatteryManager
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import pl.slava.kopernikadr.camera.R
import pl.slava.kopernikadr.camera.camera.CameraStatus
import pl.slava.kopernikadr.camera.host.QrMatrix
import pl.slava.kopernikadr.camera.host.ServerState

/** Diagnostics open after holding the status title this long. */
const val DIAGNOSTICS_HOLD_MS = 2_000L

/**
 * The phone's screen while the camera runs: the 4:3 viewfinder as large as the screen height
 * allows (full field of view, nothing cropped), and beside it the title, the address the tablet
 * connects to (or, once a tablet is connected, the \"ready\" card), and the camera state.
 *
 * @param onPreviewView called with the [PreviewView] once it exists and with null when it is
 *   released; the caller hands its surface provider to the camera.
 * @param onTitleHeld opens diagnostics after [DIAGNOSTICS_HOLD_MS]; null = no long-press (release).
 */
@Composable
fun StatusScreen(
    wifiIp: String?,
    server: ServerState,
    camera: CameraStatus,
    onPreviewView: (PreviewView?) -> Unit,
    onTitleHeld: (() -> Unit)?,
) {
    Surface(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxSize().safeDrawingPadding(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.fillMaxHeight().aspectRatio(4f / 3f).background(Color.Black)) {
                AndroidView(
                    factory = { ctx ->
                        PreviewView(ctx).apply {
                            scaleType = PreviewView.ScaleType.FIT_CENTER
                            implementationMode = PreviewView.ImplementationMode.PERFORMANCE
                        }.also(onPreviewView)
                    },
                    onRelease = { onPreviewView(null) },
                    modifier = Modifier.fillMaxSize(),
                )
            }
            BoxWithConstraints(Modifier.weight(1f).fillMaxHeight().padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                // Scrolls only as a last resort; the QR shrinks first.
                val panelHeight = maxHeight
                Column(
                    modifier = Modifier.heightIn(max = panelHeight).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Header(onTitleHeld)
                    val port = server.port
                    val qrSize = (panelHeight - 250.dp).coerceIn(56.dp, 96.dp)
                    when {
                        wifiIp == null -> StatusCard(AMBER_BG, AMBER, stringResource(R.string.status_no_wifi_title), stringResource(R.string.status_no_wifi_hint))
                        server.error != null -> StatusCard(RED_BG, RED, stringResource(R.string.status_error_title), stringResource(R.string.server_error, server.error))
                        port == null -> StatusCard(AMBER_BG, AMBER, stringResource(R.string.status_starting), null)
                        server.connected -> {
                            ReadyCard()
                            Facts(server.frames)
                        }
                        else -> WaitingCard("$wifiIp:$port", qrSize)
                    }
                    CameraNote(camera)
                }
            }
        }
    }
}

private val CARD_BG = Color(0xFF241D30)
private val PLUM = Color(0xFF2D1B3D)
private val PEACH = Color(0xFFFFA94D)
private val GREEN = Color(0xFF7CD992)
private val GREEN_BG = Color(0xFF173D2A)
private val AMBER = Color(0xFFFFD166)
private val AMBER_BG = Color(0xFF3D3317)
private val RED = Color(0xFFFF8A80)
private val RED_BG = Color(0xFF3D1A1A)

/** Logo, name and the "Kamera" chip; holding it opens diagnostics. */
@Composable
private fun Header(onTitleHeld: (() -> Unit)?) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = if (onTitleHeld != null) Modifier.holdFor(DIAGNOSTICS_HOLD_MS, onTitleHeld) else Modifier,
    ) {
        Image(painterResource(R.drawable.logo), contentDescription = null, modifier = Modifier.size(40.dp))
        Text(
            stringResource(R.string.status_title),
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
        Text(
            stringResource(R.string.status_chip),
            style = MaterialTheme.typography.labelMedium,
            color = PEACH,
            modifier = Modifier.background(PLUM, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

/** A rounded status card: bold [title] in [accent] and an optional small [text] under it. */
@Composable
private fun StatusCard(bg: Color, accent: Color, title: String, text: String?) {
    Column(
        Modifier.fillMaxWidth().background(bg, RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = accent)
        if (text != null) Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
    }
}

/** Server up, no tablet: the hint, and the QR + address for the browser remote. */
@Composable
private fun WaitingCard(address: String, qrSize: Dp) {
    Column(
        Modifier.fillMaxWidth().background(CARD_BG, RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(stringResource(R.string.status_hint_open_tablet), style = MaterialTheme.typography.bodyMedium)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            QrCode("http://$address/", Modifier.size(qrSize))
            Column {
                Text(
                    stringResource(R.string.status_qr_caption),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                // "ip:port" stays on one line.
                Text(address, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false)
            }
        }
    }
}

/** A tablet is connected: the big green "ready" card. */
@Composable
private fun ReadyCard() {
    Row(
        Modifier.fillMaxWidth().background(GREEN_BG, RoundedCornerShape(16.dp)).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // A drawn tablet: rounded outline with a home dot.
        Canvas(Modifier.size(width = 44.dp, height = 32.dp)) {
            drawRoundRect(GREEN, cornerRadius = CornerRadius(6.dp.toPx()), style = Stroke(3.dp.toPx()))
            drawCircle(GREEN, radius = 2.dp.toPx(), center = Offset(size.width - 8.dp.toPx(), size.height / 2))
        }
        Column {
            Text(stringResource(R.string.status_ready), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = GREEN)
            Text(stringResource(R.string.status_tablet_connected), style = MaterialTheme.typography.bodySmall, color = GREEN)
        }
    }
}

/** Frame count (while known) and battery percentage; the battery is polled once a minute. */
@Composable
private fun Facts(frames: Int?) {
    val context = LocalContext.current
    var battery by remember { mutableIntStateOf(-1) }
    LaunchedEffect(Unit) {
        val bm = context.getSystemService(BatteryManager::class.java)
        while (true) {
            battery = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
            delay(60_000)
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        val style = MaterialTheme.typography.bodyMedium
        val color = MaterialTheme.colorScheme.onSurfaceVariant
        if (frames != null) Text(stringResource(R.string.status_frames, frames), style = style, color = color)
        if (battery in 0..100) Text("\uD83D\uDD0B " + stringResource(R.string.status_battery, battery), style = style, color = color)
    }
}

/** Camera trouble as a red card; "starting" as a small line; nothing when ready. */
@Composable
private fun CameraNote(camera: CameraStatus) {
    val error = camera.error
    when {
        camera.ready -> {}
        error != null -> StatusCard(RED_BG, RED, stringResource(R.string.status_error_title), stringResource(R.string.camera_error, error))
        else -> Text(stringResource(R.string.camera_starting), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The remote's URL as a QR code, black on a white plate with the standard 4-module quiet zone. */
@Composable
private fun QrCode(text: String, modifier: Modifier = Modifier) {
    val qr = remember(text) { QrMatrix.encode(text) }
    Canvas(modifier.background(Color.White)) {
        val cell = size.minDimension / (qr.size + 8)
        for (y in 0 until qr.size) {
            for (x in 0 until qr.size) {
                if (qr[x, y]) {
                    drawRect(Color.Black, Offset((x + 4) * cell, (y + 4) * cell), Size(cell + 0.5f, cell + 0.5f))
                }
            }
        }
    }
}

/** Calls [onHold] when a pointer stays down for [millis] without being released or cancelled. */
fun Modifier.holdFor(millis: Long, onHold: () -> Unit): Modifier = pointerInput(millis) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false)
        var ended = false
        withTimeoutOrNull(millis) {
            waitForUpOrCancellation()
            ended = true
        }
        if (!ended) onHold()
    }
}
