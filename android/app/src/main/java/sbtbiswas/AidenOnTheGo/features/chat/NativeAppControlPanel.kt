package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.*
import java.util.UUID

@Composable
internal fun NativeAppControlPanel(
    panel: AidenAppControlPanel,
    available: Boolean,
    palette: AidenPalette,
    load: suspend (AidenAppControlPanel) -> AidenAppControlSnapshot,
    apply: suspend (AidenAppControlPanel, AidenAppControlOperation) -> AidenAppControlReceipt
) {
    var snapshot by remember(panel.id) { mutableStateOf<AidenAppControlSnapshot?>(null) }
    var pending by remember(panel.id) { mutableStateOf(false) }
    var status by remember(panel.id) { mutableStateOf("") }
    var confirmation by remember(panel.id) { mutableStateOf<AidenAppControlOperation?>(null) }
    var retry by remember(panel.id) { mutableStateOf<AidenAppControlOperation?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun refresh() {
        try { snapshot = load(panel) }
        catch (error: Exception) {
            if (error is CancellationException) throw error
            snapshot = null; status = "Current settings are unavailable. Reconnect or enable paired chat controls on the desktop."
        }
    }
    suspend fun commit(operation: AidenAppControlOperation) {
        if (pending || !available) return
        pending = true; retry = operation
        try {
            val receipt = apply(panel, operation)
            if (receipt.status == "outcome_unknown") status = "Change could not be confirmed. Refresh its value; checking the change will not repeat it."
            else { retry = null; status = receipt.warning ?: if (receipt.effective == "now") "Saved." else "Saved. Applies to subsequent agent work." }
            refresh()
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            snapshot = null; status = "Change could not be confirmed. Check the change after reconnecting."
        } finally { pending = false }
    }
    fun propose(row: AidenAppControlRow, value: JsonPrimitive) {
        if (!pending && available && row.disabledReason == null && value != row.value)
            confirmation = AidenAppControlOperation(row.id, value, row.revision, UUID.randomUUID().toString())
    }
    LaunchedEffect(panel.id, available) { snapshot = null; confirmation = null; if (available) refresh() }
    Surface(color = palette.raised, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(snapshot?.title ?: "Aiden settings", style = MaterialTheme.typography.titleSmall, color = palette.foreground)
            Text("Paired host · These controls change the serving app, not this phone.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            if (available && snapshot != null) snapshot!!.rows.forEach { row ->
                val enabled = !pending && row.disabledReason == null && snapshot!!.policy != "disabled"
                Column {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(row.label, modifier = Modifier.weight(1f), color = palette.foreground)
                        if (!row.value.isString && row.value.booleanOrNull != null) Switch(modifier = Modifier.semantics { contentDescription = "${row.label} — ${row.scope}" }, checked = row.value.boolean, onCheckedChange = { propose(row, JsonPrimitive(it)) }, enabled = enabled)
                        else {
                            var expanded by remember(row.id) { mutableStateOf(false) }
                            Box {
                                TextButton(onClick = { expanded = true }, enabled = enabled) { Text(row.value.content) }
                                DropdownMenu(expanded = expanded && enabled, onDismissRequest = { expanded = false }) {
                                    row.options.orEmpty().forEach { option -> DropdownMenuItem(text = { Text(option.label) }, onClick = { expanded = false; propose(row, JsonPrimitive(option.value)) }) }
                                }
                            }
                        }
                    }
                    Text(row.description, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                    Text(row.scope, style = MaterialTheme.typography.labelSmall, color = palette.secondary)
                    row.disabledReason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = palette.secondary) }
                }
            } else Text(panel.fallback, color = palette.secondary)
            if (status.isNotEmpty()) Text(status, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            Row {
                TextButton(onClick = { scope.launch { refresh() } }, enabled = available && !pending) { Text("Refresh") }
                retry?.let { operation -> TextButton(onClick = { scope.launch { commit(operation) } }, enabled = available && !pending) { Text("Check change") } }
            }
        }
    }
    confirmation?.let { operation ->
        AlertDialog(onDismissRequest = { confirmation = null }, title = { Text("Change this preference on the paired host?") },
            text = { Text(snapshot?.rows?.firstOrNull { it.id == operation.control }?.scope ?: "Paired host") },
            confirmButton = { TextButton(onClick = { confirmation = null; scope.launch { commit(operation) } }) { Text("Apply change") } },
            dismissButton = { TextButton(onClick = { confirmation = null }) { Text("Cancel") } })
    }
}
