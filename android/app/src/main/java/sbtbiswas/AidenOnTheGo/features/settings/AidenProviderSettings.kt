package sbtbiswas.AidenOnTheGo.features.settings

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.shared.AidenProviderIcon
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSegmentedPillRow
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.aidenGroupItemShape
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors
import java.util.UUID
import sbtbiswas.AidenOnTheGo.ui.theme.AidenButtonDefaults

@Composable
fun AidenProviderSettings(client: AidenRemoteClient?) {
    key(client) { ProviderSettingsContent(client) }
}

@Composable
private fun ProviderSettingsContent(client: AidenRemoteClient?) {
    val palette = AidenTheme.palette
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
    val providers = catalog?.providers.orEmpty()
    val reduceMotion = aidenReduceMotion()
    val chevronRotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "providers_disclosure"
    )
    val rowCount = 1 + if (expanded) maxOf(providers.size, 1) else 0

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Providers", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground)
        Text("Connections and API keys are stored on your paired Mac.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        AidenConnectedColumn {
            AidenGroupCard(
                index = 0,
                count = rowCount,
                onClick = { expanded = !expanded },
                modifier = Modifier.semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
            ) {
                Text(
                    if (expanded) "Hide connected providers" else "Show connected providers",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground,
                    modifier = Modifier.weight(1f)
                )
                if (providers.isNotEmpty()) AidenProviderCountBadge("${providers.size}")
                Icon(
                    Icons.Default.KeyboardArrowDown,
                    contentDescription = null,
                    tint = palette.secondary,
                    modifier = Modifier.graphicsLayer { rotationZ = chevronRotation }
                )
            }
            AnimatedVisibility(
                visible = expanded,
                enter = if (reduceMotion) EnterTransition.None else expandVertically(AidenMotion.spatialExpressiveSpring()) + fadeIn(AidenMotion.short()),
                exit = if (reduceMotion) ExitTransition.None else shrinkVertically(AidenMotion.spatialExpressiveSpring()) + fadeOut(AidenMotion.short())
            ) {
                AidenConnectedColumn {
                    if (providers.isEmpty()) {
                        AidenGroupCard(index = 1, count = 2, role = null) {
                            Text("No connected providers yet.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                        }
                    } else {
                        providers.forEachIndexed { index, provider ->
                            AidenGroupCard(index = index + 1, count = providers.size + 1, role = null) {
                                AidenProviderIcon(
                                    providerId = provider.id,
                                    providerLabel = provider.label,
                                    artwork = provider.artwork,
                                    size = 28.dp
                                )
                                Text(
                                    provider.label,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = palette.foreground,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f)
                                )
                                AidenProviderCountBadge("${provider.models.size} models")
                            }
                        }
                    }
                }
            }
        }
        if (error != null) Text(error!!, style = MaterialTheme.typography.bodySmall, color = palette.danger)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AidenPrimaryButton(text = "Add provider", onClick = { creating = true }, enabled = canCreate)
            AidenTonalButton(text = "Refresh", onClick = { scope.launch { refresh() } }, enabled = client != null)
        }
        if (!canCreate) Text("Requires an updated Mac and permission to manage workspaces.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
    }
    if (creating && client != null) ProviderCreationDialog(client, onDismiss = { creating = false }, onSaved = {
        creating = false; scope.launch { refresh() }
    })
}

@Composable
private fun AidenProviderCountBadge(text: String) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(8.dp)) {
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = AidenTheme.palette.secondary,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)
        )
    }
}

@Composable
private fun ProviderCreationDialog(client: AidenRemoteClient, onDismiss: () -> Unit, onSaved: () -> Unit) {
    val palette = AidenTheme.palette
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
        shape = AidenShape.Dialog,
        containerColor = palette.raised,
        titleContentColor = palette.foreground,
        textContentColor = palette.secondary,
        title = { Text("Add provider") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                TextField(label, { label = it }, colors = aidenTextFieldColors(), label = { Text("Name") }, singleLine = true, enabled = !saving)
                TextField(baseUrl, { baseUrl = it }, colors = aidenTextFieldColors(), label = { Text("Base URL") }, singleLine = true, enabled = !saving)
                if (needsKey) TextField(apiKey, { apiKey = it }, colors = aidenTextFieldColors(), label = { Text("API key") }, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false), singleLine = true, enabled = !saving)
                TextField(modelIds, { modelIds = it }, colors = aidenTextFieldColors(), label = { Text("Model IDs, separated by commas") }, enabled = !saving)
                Text("Use exact server model IDs. The first model is the default. Saving does not contact the provider.", style = MaterialTheme.typography.bodySmall)
                TextButton(contentPadding = AidenButtonDefaults.TextContentPadding, onClick = { options = !options }, enabled = !saving, shape = AidenShape.Button) { Text(if (options) "Hide options" else "Connection and model options") }
                if (options) {
                    AidenConnectedColumn {
                        ProviderOptionToggle("Requires API key", needsKey, !saving, index = 0, count = 3) { needsKey = it }
                        ProviderOptionToggle("Vision", vision, !saving, index = 1, count = 3) { vision = it }
                        ProviderOptionToggle("Reasoning", reasoning, !saving, index = 2, count = 3) { reasoning = it }
                    }
                    Text("Enable only features your server supports. Applies to every model entered above.", style = MaterialTheme.typography.bodySmall)
                    Text("API format", style = MaterialTheme.typography.labelLarge, color = palette.foreground)
                    AidenSegmentedPillRow(
                        options = listOf("openai", "anthropic"),
                        selected = kind,
                        onSelect = { kind = it },
                        label = { if (it == "openai") "OpenAI" else "Anthropic" },
                        enabled = !saving
                    )
                    Text("Deployment", style = MaterialTheme.typography.labelLarge, color = palette.foreground)
                    AidenSegmentedPillRow(
                        options = listOf("hosted", "local"),
                        selected = deployment,
                        onSelect = { deployment = it },
                        label = { if (it == "hosted") "Hosted" else "Local to Mac" },
                        enabled = !saving
                    )
                }
                if (listOf(label, baseUrl, modelIds, apiKey).any { it.isNotEmpty() }) draft.validationMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                if (error != null) Text(error!!, color = palette.danger)
            }
        },
        confirmButton = {
            AidenDialogConfirmButton(
                text = if (saving) "Saving…" else "Save",
                enabled = !saving && draft.isValid,
                onClick = {
                    if (submitted != draft) { creationKey = UUID.randomUUID(); submitted = draft }
                    saving = true; error = null
                    scope.launch {
                        try { client.createProvider(draft, creationKey); apiKey = ""; submitted = null; onSaved() }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { error = "Couldn't save the provider. Check the details and try again." }
                        finally { saving = false }
                    }
                }
            )
        },
        dismissButton = { AidenTonalButton(text = "Cancel", onClick = { apiKey = ""; onDismiss() }, enabled = !saving) }
    )
}

@Composable
private fun ProviderOptionToggle(
    label: String,
    checked: Boolean,
    enabled: Boolean,
    index: Int,
    count: Int,
    onChange: (Boolean) -> Unit
) {
    AidenGroupCard(
        index = index,
        count = count,
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
        modifier = Modifier
            .clip(aidenGroupItemShape(index, count))
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange)
    ) {
        Text(label, Modifier.weight(1f), color = AidenTheme.palette.foreground)
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}
