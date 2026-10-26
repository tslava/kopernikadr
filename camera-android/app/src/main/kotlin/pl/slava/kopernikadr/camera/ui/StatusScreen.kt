package pl.slava.kopernikadr.camera.ui

import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import pl.slava.kopernikadr.camera.R
import pl.slava.kopernikadr.camera.camera.CameraStatus

/** Diagnostics open after holding the status title this long. */
const val DIAGNOSTICS_HOLD_MS = 2_000L

/**
 * The phone's screen while the camera runs: the 4:3 viewfinder as large as the screen height
 * allows (full field of view, nothing cropped), and beside it the title, the address the tablet
 * connects to, and the camera state.
 *
 * @param onPreviewView called with the [PreviewView] once it exists and with null when it is
 *   released; the caller hands its surface provider to the camera.
 * @param onTitleHeld opens diagnostics after [DIAGNOSTICS_HOLD_MS]; null = no long-press (release).
 */
@Composable
fun StatusScreen(
    wifiIp: String?,
    port: Int,
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
            Column(
                modifier = Modifier.weight(1f).padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    stringResource(R.string.status_title),
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = if (onTitleHeld != null) Modifier.holdFor(DIAGNOSTICS_HOLD_MS, onTitleHeld) else Modifier,
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    text = wifiIp?.let { stringResource(R.string.status_ip, "$it:$port") }
                        ?: stringResource(R.string.status_no_wifi),
                    style = MaterialTheme.typography.titleMedium,
                )
                Spacer(Modifier.height(12.dp))
                Text(cameraLine(camera), style = MaterialTheme.typography.bodyLarge)
                camera.bind?.let { bind ->
                    Text(
                        text = buildString {
                            append(bind.variant)
                            append(if (bind.strict.ok) " · strict ok" else " · fallback")
                            bind.preview?.resolved?.let { append(" · P ").append(it) }
                            bind.analysis.resolved?.let { append(" · A ").append(it) }
                            bind.capture.resolved?.let { append(" · C ").append(it) }
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun cameraLine(camera: CameraStatus): String {
    val error = camera.error
    return when {
        camera.ready -> stringResource(R.string.camera_ready)
        error != null -> stringResource(R.string.camera_error, error)
        else -> stringResource(R.string.camera_starting)
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
