package pl.slava.kopernikadr.camera.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.text.format.Formatter
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import pl.slava.kopernikadr.camera.R
import pl.slava.kopernikadr.camera.spool.QuarantineEntry
import pl.slava.kopernikadr.camera.spool.QuarantineListing
import pl.slava.kopernikadr.camera.spool.QuarantineStore

/** The newest this many files get a thumbnail. */
private const val THUMB_LIMIT = 12
private const val THUMB_PX = 96

private val CARD = Color(0xFF241D30)
private val GREEN_OK = Color(0xFF7CD992)

/**
 * The quarantine section of the parent screen: count, size, up to [THUMB_LIMIT] newest thumbnails
 * (decoded downsampled off the main thread), and "Wyczyść", which asks the parent to type the
 * file count. The clear deletes exactly the files this screen listed (see [QuarantineStore.clear]).
 */
@Composable
fun QuarantineSection(store: QuarantineStore) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var listing by remember { mutableStateOf<QuarantineListing?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(reload) { listing = withContext(Dispatchers.IO) { store.list() } }

    val l = listing
    Column(
        Modifier.fillMaxWidth().background(CARD, RoundedCornerShape(16.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(stringResource(R.string.quarantine_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        when {
            l == null -> {}
            l.count == 0 -> Text(stringResource(R.string.quarantine_empty), style = MaterialTheme.typography.bodyMedium)
            else -> {
                Text(
                    stringResource(R.string.quarantine_summary, l.count, Formatter.formatShortFileSize(context, l.bytes)),
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Bold,
                )
                Text(stringResource(R.string.quarantine_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Thumbs(store, l.entries.take(THUMB_LIMIT))
                Button(onClick = { confirming = true }) { Text(stringResource(R.string.quarantine_clear)) }
            }
        }
        message?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = GREEN_OK) }
    }

    if (confirming && l != null) {
        ConfirmClear(
            count = l.count,
            onCancel = { confirming = false },
            onConfirm = {
                confirming = false
                scope.launch {
                    val r = withContext(Dispatchers.IO) { store.clear(l.entries) }
                    message = if (r.failed.isEmpty()) {
                        context.getString(R.string.quarantine_cleared, r.removed)
                    } else {
                        context.getString(R.string.quarantine_cleared_failed, r.removed, r.failed.size)
                    }
                    reload++
                }
            },
        )
    }
}

/** The parent types the file count; only an exact match enables the button. */
@Composable
private fun ConfirmClear(count: Int, onCancel: () -> Unit, onConfirm: () -> Unit) {
    var typed by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(stringResource(R.string.quarantine_confirm_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.quarantine_confirm_text, count))
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it.filter(Char::isDigit).take(6) },
                    label = { Text(stringResource(R.string.quarantine_confirm_label)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = typed.toIntOrNull() == count) { Text(stringResource(R.string.quarantine_confirm_ok)) }
        },
        dismissButton = { TextButton(onClick = onCancel) { Text(stringResource(R.string.quarantine_cancel)) } },
    )
}

/** A row of downsampled thumbnails; each decodes on [Dispatchers.IO] and shows when ready. */
@Composable
private fun Thumbs(store: QuarantineStore, entries: List<QuarantineEntry>) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (e in entries) {
            val file = store.file(e)
            val bmp by produceState<Bitmap?>(null, file) { value = withContext(Dispatchers.IO) { decodeThumb(file, THUMB_PX) } }
            Box(Modifier.size(64.dp).background(Color.Black, RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
                bmp?.let { Image(it.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(64.dp)) }
            }
        }
    }
}

/** Decodes [file] with `inSampleSize` so its larger side stays at least [target] px (null if it is not an image). */
internal fun decodeThumb(file: File, target: Int): Bitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    val side = maxOf(bounds.outWidth, bounds.outHeight)
    if (side <= 0) return@runCatching null
    var sample = 1
    while (side / (sample * 2) >= target) sample *= 2
    BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
}.getOrNull()
