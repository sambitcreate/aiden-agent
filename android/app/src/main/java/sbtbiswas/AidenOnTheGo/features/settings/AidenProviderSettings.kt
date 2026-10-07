package sbtbiswas.AidenOnTheGo.features.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.shared.AidenProviderIcon
import sbtbiswas.AidenOnTheGo.models.AidenProviderCreation
import sbtbiswas.AidenOnTheGo.models.AidenProviderCreationModel
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors
import java.util.UUID

/**
 * Providers connected on the paired desktop. The list renders from cache and refreshes in
 * the background; Add provider appears only when the desktop allows it, and otherwise the
 * page explains what is needed instead of showing a disabled button.
 */
@Composable
fun AidenProviderSettingsScreen(
    store: AidenSettingsStore,
    onAddProvider: () -> Unit,
    onNavigateBack: () -> Unit
) {
    val state by store.state.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { store.refresh() }
    val providers = state.providers

    AidenSettingsScaffold(
        title = stringResource(R.string.settings_providers),
        onNavigateBack = onNavigateBack
    ) {
        item(key = "providers") {
            AidenSettingsGroup(
                title = stringResource(R.string.providers_group_connected),
                footer = stringResource(R.string.settings_providers_footer),
                error = if (state.providersFailure != null && providers != null) stringResource(R.string.providers_stale) else null
            ) {
                when {
                    providers != null && providers.isEmpty() -> row(dividerInset = AidenSettingsDefaults.DividerInset) {
                        AidenSettingsMessageRow(stringResource(R.string.providers_empty))
                    }
                    providers != null -> providers.forEach { provider ->
                        row {
                            val models = pluralStringResource(R.plurals.providers_model_count, provider.modelCount, provider.modelCount)
                            AidenSettingsListItem(
                                headline = provider.label,
                                modifier = Modifier.semantics(mergeDescendants = true) {},
                                supporting = { Text(models) },
                                leading = {
                                    AidenProviderIcon(
                                        providerId = provider.id,
                                        providerLabel = provider.label,
                                        artwork = provider.artwork,
                                        size = 24.dp
                                    )
                                },
                                trailing = null
                            )
                        }
                    }
                    state.isLoadingProviders -> repeat(3) { row { AidenSettingsSkeletonRow() } }
                    else -> row(dividerInset = AidenSettingsDefaults.DividerInset) {
                        AidenSettingsMessageRow(
                            stringResource(if (state.isConnected) R.string.settings_providers_unavailable else R.string.settings_connect_to_manage)
                        )
                    }
                }
            }
        }
        if (state.isConnected && providers != null) {
            item(key = "add") {
                if (state.canCreateProvider) {
                    AidenSettingsGroup(title = null) {
                        row {
                            AidenSettingsNavigationRow(
                                headline = stringResource(R.string.providers_add),
                                supporting = stringResource(R.string.providers_add_supporting),
                                leadingIcon = Icons.Outlined.Add,
                                onClick = onAddProvider
                            )
                        }
                    }
                } else {
                    Text(
                        stringResource(R.string.providers_add_requirements),
                        style = MaterialTheme.typography.bodySmall,
                        color = AidenTheme.palette.secondary,
                        modifier = Modifier.padding(horizontal = AidenSettingsDefaults.Gutter)
                    )
                }
            }
        }
    }
}

/**
 * Full-screen Add provider form. Save lives in the top app bar; the API key is never kept
 * in saved state, and leaving is blocked only while a save is on its way to the desktop.
 */
@Composable
fun AidenAddProviderScreen(
    store: AidenSettingsStore,
    onNavigateBack: () -> Unit
) {
    val scope = rememberCoroutineScope()
    var label by rememberSaveable { mutableStateOf("") }
    var baseUrl by rememberSaveable { mutableStateOf("") }
    var modelIds by rememberSaveable { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var needsKey by rememberSaveable { mutableStateOf(true) }
    var kind by rememberSaveable { mutableStateOf("openai") }
    var deployment by rememberSaveable { mutableStateOf("hosted") }
    var vision by rememberSaveable { mutableStateOf(false) }
    var reasoning by rememberSaveable { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var creationKey by remember { mutableStateOf(UUID.randomUUID()) }
    var submitted by remember { mutableStateOf<AidenProviderCreation?>(null) }
    val draft = AidenProviderCreation(
        label = label.trim(),
        baseUrl = baseUrl.trim(),
        kind = kind,
        deployment = deployment,
        needsKey = needsKey,
        apiKey = if (needsKey) apiKey.trim() else null,
        models = modelIds.split(',').map { AidenProviderCreationModel(it.trim(), vision, reasoning) }
    )
    val touched = listOf(label, baseUrl, modelIds, apiKey).any { it.isNotEmpty() }
    BackHandler(enabled = saving) {}

    fun save() {
        if (submitted != draft) {
            creationKey = UUID.randomUUID()
            submitted = draft
        }
        saving = true
        failed = false
        scope.launch {
            try {
                store.createProvider(draft, creationKey)
                apiKey = ""
                onNavigateBack()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                failed = true
            } finally {
                saving = false
            }
        }
    }

    AidenSettingsScaffold(
        title = stringResource(R.string.providers_add),
        onNavigateBack = { if (!saving) onNavigateBack() },
        navigationIcon = Icons.Outlined.Close,
        navigationContentDescription = stringResource(R.string.action_cancel),
        actions = {
            TextButton(onClick = ::save, enabled = !saving && draft.isValid, shape = AidenShape.Button) {
                Text(stringResource(if (saving) R.string.action_saving else R.string.action_save))
            }
        }
    ) {
        item(key = "connection") {
            AidenSettingsGroup(
                title = stringResource(R.string.providers_group_connection),
                error = when {
                    failed -> stringResource(R.string.providers_save_failed)
                    touched -> draft.validationMessage
                    else -> null
                }
            ) {
                row(dividerInset = 0.dp) {
                    Column(
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.padding(16.dp)
                    ) {
                        AidenProviderField(label, { label = it }, stringResource(R.string.providers_field_name), !saving)
                        AidenProviderField(
                            baseUrl, { baseUrl = it }, stringResource(R.string.providers_field_base_url), !saving,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, imeAction = ImeAction.Next)
                        )
                        if (needsKey) {
                            AidenProviderField(
                                apiKey, { apiKey = it }, stringResource(R.string.providers_field_api_key), !saving,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Next),
                                secret = true
                            )
                        }
                    }
                }
            }
        }
        item(key = "models") {
            AidenSettingsGroup(
                title = stringResource(R.string.providers_group_models),
                footer = stringResource(R.string.providers_models_footer)
            ) {
                row(dividerInset = 0.dp) {
                    AidenProviderField(
                        modelIds, { modelIds = it }, stringResource(R.string.providers_field_model_ids), !saving,
                        singleLine = false,
                        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
        item(key = "options") {
            AidenSettingsGroup(
                title = stringResource(R.string.providers_group_options),
                footer = stringResource(R.string.providers_options_footer)
            ) {
                row {
                    AidenSettingsSwitchRow(stringResource(R.string.providers_requires_key), needsKey, { needsKey = it }, enabled = !saving, leadingIcon = Icons.Outlined.Key)
                }
                row {
                    AidenSettingsSwitchRow(stringResource(R.string.providers_vision), vision, { vision = it }, enabled = !saving, leadingIcon = Icons.Outlined.Visibility)
                }
                row {
                    AidenSettingsSwitchRow(stringResource(R.string.providers_reasoning), reasoning, { reasoning = it }, enabled = !saving, leadingIcon = Icons.Outlined.Psychology)
                }
            }
        }
        item(key = "format") {
            AidenSettingsGroup(title = stringResource(R.string.providers_group_format), selectableGroup = true) {
                listOf("openai" to R.string.providers_format_openai, "anthropic" to R.string.providers_format_anthropic).forEach { (value, title) ->
                    row {
                        AidenSettingsRadioRow(stringResource(title), selected = kind == value, onClick = { if (!saving) kind = value })
                    }
                }
            }
        }
        item(key = "deployment") {
            AidenSettingsGroup(title = stringResource(R.string.providers_group_deployment), selectableGroup = true) {
                listOf("hosted" to R.string.providers_deployment_hosted, "local" to R.string.providers_deployment_local).forEach { (value, title) ->
                    row {
                        AidenSettingsRadioRow(stringResource(title), selected = deployment == value, onClick = { if (!saving) deployment = value })
                    }
                }
            }
        }
    }
}

@Composable
private fun AidenProviderField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    secret: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions(imeAction = ImeAction.Next)
) {
    TextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 2,
        enabled = enabled,
        colors = aidenTextFieldColors(),
        shape = MaterialTheme.shapes.medium,
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = keyboardOptions,
        modifier = modifier.fillMaxWidth()
    )
}
