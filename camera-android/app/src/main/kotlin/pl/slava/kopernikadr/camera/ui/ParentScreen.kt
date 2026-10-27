package pl.slava.kopernikadr.camera.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import pl.slava.kopernikadr.camera.R
import pl.slava.kopernikadr.camera.spool.QuarantineStore

/**
 * The parent screen, opened by holding the status title for [PARENT_HOLD_MS]. In the main source set,
 * so release has it too. [onDiagnostics] is null in release (no diagnostics screen there).
 */
@Composable
fun ParentScreen(store: QuarantineStore, onClose: () -> Unit, onDiagnostics: (() -> Unit)?) {
    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.parent_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            QuarantineSection(store)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (onDiagnostics != null) {
                    OutlinedButton(onClick = onDiagnostics) { Text(stringResource(R.string.parent_diagnostics)) }
                }
                Button(onClick = onClose) { Text(stringResource(R.string.parent_close)) }
            }
        }
    }
}
