package pl.slava.kopernikadr.camera.diag

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/**
 * Bare diagnostics screen (debug/probe only): a button per probe, the active or last run, the last
 * report's summary, and a full-screen prompt with a big Continue button while a run waits.
 */
@Composable
fun DiagnosticsScreen(runner: ProbeRunner, onClose: () -> Unit) {
    val status by runner.core.status.collectAsStateWithLifecycle()
    val report by runner.core.lastReport.collectAsStateWithLifecycle()
    val current = status
    val prompt = current?.prompt
    Surface(Modifier.fillMaxSize()) {
        if (current != null && current.state == RunState.WAITING && prompt != null) {
            PromptScreen(prompt.text) { runner.core.continueRun(current.runId, prompt.id) }
            return@Surface
        }
        Column(
            modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Diagnostics", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
                OutlinedButton(onClick = onClose) { Text("Close") }
            }
            val idle = current == null || current.state.isTerminal
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                runner.core.probeNames.forEach { name ->
                    Button(onClick = { runner.start(name) }, enabled = idle) { Text(name) }
                }
            }
            if (current == null) {
                Text("No run yet.", style = MaterialTheme.typography.bodyLarge)
            } else {
                Text(
                    "${current.runId}: ${current.state.name.lowercase()}" + (current.step?.let { " — $it" } ?: ""),
                    style = MaterialTheme.typography.titleMedium,
                )
                current.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            report?.summary()?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
            Text(
                "Reports: ${runner.rootDir}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun PromptScreen(text: String, onContinue: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text, style = MaterialTheme.typography.displaySmall, textAlign = TextAlign.Center)
        Spacer(Modifier.height(32.dp))
        Button(onClick = onContinue, modifier = Modifier.fillMaxWidth(0.6f).height(120.dp)) {
            Text("Continue", style = MaterialTheme.typography.displaySmall)
        }
    }
}
