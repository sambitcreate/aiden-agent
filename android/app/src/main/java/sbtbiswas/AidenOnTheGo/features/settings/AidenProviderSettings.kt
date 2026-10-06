package sbtbiswas.AidenOnTheGo.features.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors
import java.util.UUID

@Composable
fun AidenProviderSettings(client: AidenRemoteClient?) {
    key(client) { ProviderSettingsContent(client) }
}

@Composable
private fun ProviderSettingsContent(client: AidenRemoteClient?) {
    val scope = rememberCoroutineScope()
    var catalog by remember { mutableStateOf<AidenModelCatalog?>(null) }
    var canCreate by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var expanded by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    suspend fun refresh() {
        if (client == null) return
        try {
            val server = client.server()
            canCreate = "providers-create-v1" in server.features && AidenRemoteCapability.WORKSPACE_MANAGE in server.capabilities
            catalog = client.modelCatalog(); error = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { error = "Providers are unavailable. Connect to an updated Mac and refresh." }
    }
    LaunchedEffect(client) { refresh() }
    Surface(color = AidenTheme.palette.raised, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Providers", style = MaterialTheme.typography.titleMedium)
            Text("Connections and API keys are stored on your paired Mac.", style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide connected providers" else "Show connected providers") }
            if (expanded) catalog?.providers?.forEach { provider ->
                Text("${provider.label} · ${provider.models.size} models", style = MaterialTheme.typography.bodyMedium)
            }
            if (error != null) Text(error!!, color = MaterialTheme.colorScheme.error)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { creating = true }, enabled = canCreate) { Text("Add provider") }
                TextButton(onClick = { scope.launch { refresh() } }, enabled = client != null) { Text("Refresh") }
            }
            if (!canCreate) Text("Requires an updated Mac and permission to manage workspaces.", style = MaterialTheme.typography.bodySmall)
        }
    }
    if (creating && client != null) ProviderCreationDialog(client, onDismiss = { creating = false }, onSaved = {
        creating = false; scope.launch { refresh() }
    })
}

@Composable
private fun ProviderCreationDialog(client: AidenRemoteClient, onDismiss: () -> Unit, onSaved: () -> Unit) {
    val scope = rememberCoroutineScope()
    var label by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var modelIds by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var needsKey by remember { mutableStateOf(true) }
    var kind by remember { mutableStateOf("openai") }
    var deployment by remember { mutableStateOf("hosted") }
    var vision by remember { mutableStateOf(false) }
    var reasoning by remember { mutableStateOf(false) }
    var options by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var creationKey by remember { mutableStateOf(UUID.randomUUID()) }
    var submitted by remember { mutableStateOf<AidenProviderCreation?>(null) }
    val draft = AidenProviderCreation(label.trim(), baseUrl.trim(), kind, deployment, needsKey,
        apiKey = if (needsKey) apiKey.trim() else null,
        models = modelIds.split(',').map { AidenProviderCreationModel(it.trim(), vision, reasoning) })
    AlertDialog(
        onDismissRequest = { if (!saving) { apiKey = ""; onDismiss() } },
        title = { Text("Add provider") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                TextField(label, { label = it }, colors = aidenTextFieldColors(), label = { Text("Name") }, singleLine = true, enabled = !saving)
                TextField(baseUrl, { baseUrl = it }, colors = aidenTextFieldColors(), label = { Text("Base URL") }, singleLine = true, enabled = !saving)
                if (needsKey) TextField(apiKey, { apiKey = it }, colors = aidenTextFieldColors(), label = { Text("API key") }, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false), singleLine = true, enabled = !saving)
                TextField(modelIds, { modelIds = it }, colors = aidenTextFieldColors(), label = { Text("Model IDs, separated by commas") }, enabled = !saving)
                Text("Use exact server model IDs. The first model is the default. Saving does not contact the provider.", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { options = !options }, enabled = !saving) { Text(if (options) "Hide options" else "Connection and model options") }
                if (options) {
                    ProviderOptionToggle("Requires API key", needsKey, !saving) { needsKey = it }
                    ProviderOptionToggle("Vision", vision, !saving) { vision = it }
                    ProviderOptionToggle("Reasoning", reasoning, !saving) { reasoning = it }
                    Text("Enable only features your server supports. Applies to every model entered above.", style = MaterialTheme.typography.bodySmall)
                    Text("API format", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { FilterChip(kind == "openai", { kind = "openai" }, label = { Text("OpenAI") }, enabled = !saving, border = null); FilterChip(kind == "anthropic", { kind = "anthropic" }, label = { Text("Anthropic") }, enabled = !saving, border = null) }
                    Text("Deployment", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { FilterChip(deployment == "hosted", { deployment = "hosted" }, label = { Text("Hosted") }, enabled = !saving, border = null); FilterChip(deployment == "local", { deployment = "local" }, label = { Text("Local to Mac") }, enabled = !saving, border = null) }
                }
                if (listOf(label, baseUrl, modelIds, apiKey).any { it.isNotEmpty() }) draft.validationMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                if (error != null) Text(error!!, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = { TextButton(enabled = !saving && draft.isValid, onClick = {
            if (submitted != draft) { creationKey = UUID.randomUUID(); submitted = draft }
            saving = true; error = null
            scope.launch {
                try { client.createProvider(draft, creationKey); apiKey = ""; submitted = null; onSaved() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { error = "Couldn't save the provider. Check the details and try again." }
                finally { saving = false }
            }
        }) { Text(if (saving) "Saving…" else "Save") } },
        dismissButton = { TextButton(onClick = { apiKey = ""; onDismiss() }, enabled = !saving) { Text("Cancel") } }
    )
}

@Composable
private fun ProviderOptionToggle(label: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}
