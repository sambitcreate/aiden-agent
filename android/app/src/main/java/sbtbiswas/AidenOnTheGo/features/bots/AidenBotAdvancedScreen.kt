package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.shared.AidenProviderIcon
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSegmentedPillRow
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors

/** The Custom access choices, seeded from the Mac's current catalog. */
data class AidenBotCustomAccessDraft(
    var providerID: String,
    var modelID: String,
    var fileScopeIDs: Set<String>,
    var shellEnabled: Boolean,
    var connectionIDs: Set<String>,
    var skillIDs: Set<String>,
    var otherCapabilityIDs: Set<String>
) {
    companion object {
        fun fromCatalog(catalog: AidenBotCapabilityCatalog): AidenBotCustomAccessDraft? {
            val provider = catalog.providers.firstOrNull { it.available && it.models.any { m -> m.available } } ?: return null
            val model = provider.models.firstOrNull { it.available } ?: return null
            return AidenBotCustomAccessDraft(
                providerID = provider.id,
                modelID = model.id,
                fileScopeIDs = catalog.fileScopes.filter { it.available }.map { it.id }.toSet(),
                shellEnabled = catalog.shellAvailable,
                connectionIDs = catalog.connections.filter { it.available }.map { it.id }.toSet(),
                skillIDs = catalog.skills.filter { it.available }.map { it.id }.toSet(),
                otherCapabilityIDs = catalog.otherCapabilities.filter { it.available }.map { it.id }.toSet()
            )
        }

        fun fromAccess(access: AidenBotAccessView, catalog: AidenBotCapabilityCatalog): AidenBotCustomAccessDraft? {
            val custom = access.custom ?: return fromCatalog(catalog)
            return AidenBotCustomAccessDraft(
                providerID = custom.providerId,
                modelID = custom.modelId,
                fileScopeIDs = custom.fileScopeIds.toSet(),
                shellEnabled = custom.shellEnabled,
                connectionIDs = custom.connectionIds.toSet(),
                skillIDs = custom.skillIds.toSet(),
                otherCapabilityIDs = custom.otherCapabilityIds.toSet()
            )
        }
    }

    fun selection(): AidenBotCustomSelection = AidenBotCustomSelection(
        fileScopeIds = fileScopeIDs.sorted(),
        shellEnabled = shellEnabled,
        connectionIds = connectionIDs.sorted(),
        skillIds = skillIDs.sorted(),
        otherCapabilityIds = otherCapabilityIDs.sorted(),
        providerId = providerID,
        modelId = modelID
    )

    fun isSaveable(catalog: AidenBotCapabilityCatalog): Boolean =
        try { catalog.containsAvailable(selection()) } catch (_: Exception) { false }
}

/** Builds the access update for Full or Custom with the chosen model, or throws when the Mac can't honour it. */
fun aidenBotAccessUpdate(
    usesFullAccess: Boolean,
    custom: AidenBotCustomAccessDraft,
    catalog: AidenBotCapabilityCatalog
): AidenBotAccessUpdate {
    val model = AidenBotModelSelection(providerId = custom.providerID, modelId = custom.modelID)
    if (!catalog.containsAvailable(model.providerId, model.modelId)) {
        throw AidenBotContractException.InvalidCombination("unavailable Bot model")
    }
    if (usesFullAccess) return AidenBotAccessUpdate.full(catalog.revision, model)
    val selection = custom.selection()
    if (!catalog.containsAvailable(selection)) {
        throw AidenBotContractException.InvalidCombination("unavailable custom access")
    }
    return AidenBotAccessUpdate.custom(catalog.revision, selection)
}

/** Everything on the Advanced page: model, what the Bot can use, and its opening greeting. */
data class AidenBotAdvancedDraft(
    val usesFullAccess: Boolean,
    val customAccess: AidenBotCustomAccessDraft,
    val openingGreeting: String
) {
    companion object {
        fun fromDetail(detail: AidenBotDetail, catalog: AidenBotCapabilityCatalog): AidenBotAdvancedDraft? {
            val custom = AidenBotCustomAccessDraft.fromAccess(detail.access, catalog) ?: return null
            detail.modelSelection?.let { saved ->
                if (catalog.providers.firstOrNull { it.id == saved.providerId }?.models?.any { it.id == saved.modelId } == true) {
                    custom.providerID = saved.providerId
                    custom.modelID = saved.modelId
                }
            }
            return AidenBotAdvancedDraft(
                usesFullAccess = detail.access.accessMode == AidenBotAccessMode.FULL,
                customAccess = custom,
                openingGreeting = detail.openingGreeting.orEmpty()
            )
        }
    }

    /** The first model the Mac can run right now. */
    fun withRecommendedModel(catalog: AidenBotCapabilityCatalog): AidenBotAdvancedDraft {
        val recommended = AidenBotCustomAccessDraft.fromCatalog(catalog) ?: return this
        return copy(customAccess = customAccess.copy(providerID = recommended.providerID, modelID = recommended.modelID))
    }

    fun accessUpdate(catalog: AidenBotCapabilityCatalog): AidenBotAccessUpdate =
        aidenBotAccessUpdate(usesFullAccess, customAccess, catalog)

    fun changesAccess(bot: AidenBotDetail, catalog: AidenBotCapabilityCatalog): Boolean {
        val next = accessUpdate(catalog)
        return when (next.accessMode) {
            AidenBotAccessMode.FULL -> bot.access.accessMode != AidenBotAccessMode.FULL ||
                bot.modelSelection?.providerId != next.providerId || bot.modelSelection?.modelId != next.modelId
            AidenBotAccessMode.CUSTOM -> bot.access.accessMode != AidenBotAccessMode.CUSTOM || bot.access.custom != next.custom
        }
    }

    fun greetingPatch(bot: AidenBotDetail): AidenBotIdentityPatch? {
        val next = openingGreeting.trim().ifEmpty { null }
        if (next == bot.openingGreeting?.trim()?.ifEmpty { null }) return null
        // An empty greeting clears it on the Mac.
        return AidenBotIdentityPatch(openingGreeting = next ?: "")
    }

    fun isSaveable(catalog: AidenBotCapabilityCatalog): Boolean =
        try { accessUpdate(catalog); true } catch (_: Exception) { false }
}

/** Saves an Advanced draft: the greeting first, then access, and returns the fresh Bot. */
suspend fun aidenBotSaveAdvanced(
    client: AidenRemoteClient,
    bot: AidenBotDetail,
    draft: AidenBotAdvancedDraft,
    catalog: AidenBotCapabilityCatalog
): AidenBotDetail {
    var current = bot
    draft.greetingPatch(current)?.let { current = client.updateBotIdentity(current.id, current.revision, it) }
    if (draft.changesAccess(bot, catalog)) {
        client.updateBotAccess(current.id, current.access.revision, draft.accessUpdate(catalog))
        current = client.bot(current.id)
    }
    return current
}

enum class AidenBotAccessChoice(val label: String) {
    FULL("Everything"),
    CUSTOM("Only what I pick")
}

/** Connected choice between Full and Custom access. */
@Composable
fun AidenBotAccessChoiceSelector(
    usesFullAccess: Boolean,
    onUsesFullAccessChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier
) {
    AidenSegmentedPillRow(
        options = AidenBotAccessChoice.entries,
        selected = if (usesFullAccess) AidenBotAccessChoice.FULL else AidenBotAccessChoice.CUSTOM,
        onSelect = { onUsesFullAccessChange(it == AidenBotAccessChoice.FULL) },
        label = { it.label },
        modifier = modifier
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotAdvancedSheet(
    bot: AidenBotDetail,
    client: AidenRemoteClient?,
    onDismiss: () -> Unit,
    onSaved: (AidenBotDetail) -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    var catalog by remember { mutableStateOf<AidenBotCapabilityCatalog?>(null) }
    var draft by remember { mutableStateOf<AidenBotAdvancedDraft?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var isSaving by remember { mutableStateOf(false) }

    LaunchedEffect(bot.id, client) {
        val cl = client ?: run {
            loadError = "Connect to your Mac to change these settings."
            return@LaunchedEffect
        }
        try {
            val cat = cl.botCapabilityCatalog(bot.id)
            catalog = cat
            draft = AidenBotAdvancedDraft.fromDetail(bot, cat)
            if (draft == null) loadError = "Set up an AI model on your Mac first."
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            loadError = "Aiden couldn’t load these settings. Try again."
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Scaffold(
            containerColor = palette.canvas,
            topBar = {
                TopAppBar(
                    title = { Text("Advanced", fontWeight = FontWeight.SemiBold) },
                    navigationIcon = {
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = palette.foreground)
                        }
                    },
                    actions = {
                        val cat = catalog
                        val current = draft
                        AidenPrimaryButton(
                            text = if (isSaving) "Saving…" else "Save",
                            enabled = !isSaving && cat != null && current != null && current.isSaveable(cat),
                            onClick = {
                                val cl = client ?: return@AidenPrimaryButton
                                if (cat == null || current == null) return@AidenPrimaryButton
                                scope.launch {
                                    isSaving = true
                                    saveError = null
                                    try {
                                        onSaved(aidenBotSaveAdvanced(cl, bot, current, cat))
                                    } catch (error: CancellationException) {
                                        throw error
                                    } catch (_: Exception) {
                                        saveError = "Aiden couldn’t save. Try again."
                                    } finally {
                                        isSaving = false
                                    }
                                }
                            },
                            modifier = Modifier.padding(end = 12.dp)
                        )
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas, titleContentColor = palette.foreground)
                )
            }
        ) { padding ->
            val cat = catalog
            val current = draft
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = AidenUi.ScreenGutter, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(AidenUi.SectionGap)
            ) {
                when {
                    loadError != null -> Text(loadError.orEmpty(), color = palette.secondary)
                    cat == null || current == null -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = palette.accent)
                    }
                    else -> {
                        AidenBotAdvancedSection(title = "AI model") {
                            AidenConnectedColumn {
                                val models = cat.providers.flatMap { provider ->
                                    provider.models.filter { it.available }.map { provider to it }
                                }
                                models.forEachIndexed { index, (provider, model) ->
                                    val selected = current.customAccess.providerID == provider.id && current.customAccess.modelID == model.id
                                    AidenGroupCard(
                                        index = index,
                                        count = models.size,
                                        selected = selected,
                                        role = Role.RadioButton,
                                        onClick = {
                                            draft = current.copy(customAccess = current.customAccess.copy(providerID = provider.id, modelID = model.id))
                                        }
                                    ) {
                                        RadioButton(selected = selected, onClick = null, colors = RadioButtonDefaults.colors(selectedColor = palette.accent))
                                        AidenProviderIcon(providerId = provider.id, providerLabel = provider.label, size = 20.dp)
                                        Text(model.label, color = palette.foreground, modifier = Modifier.weight(1f))
                                    }
                                }
                            }
                            TextButton(onClick = { draft = current.withRecommendedModel(cat) }) {
                                Text("Use recommended", color = palette.accent)
                            }
                        }

                        AidenBotAdvancedSection(
                            title = "What it can use",
                            footer = if (current.usesFullAccess)
                                "It can use everything Aiden can on your Mac. It still asks before anything risky."
                            else
                                "It can only use what you turn on here."
                        ) {
                            AidenBotAccessChoiceSelector(
                                usesFullAccess = current.usesFullAccess,
                                onUsesFullAccessChange = { draft = current.copy(usesFullAccess = it) }
                            )
                            AnimatedVisibility(visible = !current.usesFullAccess) {
                                AidenBotCustomAccessSections(
                                    catalog = cat,
                                    draft = current.customAccess,
                                    onChange = { draft = current.copy(customAccess = it) }
                                )
                            }
                        }

                        AidenBotAdvancedSection(
                            title = "Opening greeting",
                            footer = "The first thing it says in a new chat. Leave empty for none."
                        ) {
                            TextField(
                                value = current.openingGreeting,
                                onValueChange = { draft = current.copy(openingGreeting = it.take(AidenBotWire.MAX_GREETING_LENGTH)) },
                                colors = aidenTextFieldColors(),
                                minLines = 2,
                                maxLines = 5,
                                shape = RoundedCornerShape(16.dp),
                                modifier = Modifier.fillMaxWidth()
                            )
                        }

                        saveError?.let { Text(it, color = palette.danger, style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }
    }
}

@Composable
private fun AidenBotAdvancedSection(
    title: String,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    val palette = AidenTheme.palette
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = palette.secondary, modifier = Modifier.padding(horizontal = 4.dp))
        content()
        footer?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = palette.secondary, modifier = Modifier.padding(horizontal = 4.dp))
        }
    }
}

/** The Custom choices, shown once: folders, terminal, and connected apps. */
@Composable
private fun AidenBotCustomAccessSections(
    catalog: AidenBotCapabilityCatalog,
    draft: AidenBotCustomAccessDraft,
    onChange: (AidenBotCustomAccessDraft) -> Unit
) {
    val palette = AidenTheme.palette
    Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        val folders = catalog.fileScopes.filter { it.available || draft.fileScopeIDs.contains(it.id) }
        if (folders.isNotEmpty()) {
            AidenBotToggleGroup(
                title = "Folders",
                items = folders.map { it.id to it.label },
                checked = draft.fileScopeIDs,
                onToggle = { id, on -> onChange(draft.copy(fileScopeIDs = if (on) draft.fileScopeIDs + id else draft.fileScopeIDs - id)) }
            )
        }
        AidenConnectedColumn {
            AidenGroupCard(
                index = 0,
                count = 1,
                role = Role.Switch,
                enabled = catalog.shellAvailable,
                onClick = { onChange(draft.copy(shellEnabled = !draft.shellEnabled)) }
            ) {
                Text("Run commands on your Mac", color = palette.foreground, modifier = Modifier.weight(1f))
                Switch(
                    checked = draft.shellEnabled,
                    onCheckedChange = null,
                    enabled = catalog.shellAvailable,
                    colors = SwitchDefaults.colors(checkedTrackColor = palette.accent)
                )
            }
        }
        val apps = catalog.connections.filter { it.available || draft.connectionIDs.contains(it.id) }
        if (apps.isNotEmpty()) {
            AidenBotToggleGroup(
                title = "Connected apps",
                items = apps.map { it.id to it.label },
                checked = draft.connectionIDs,
                onToggle = { id, on -> onChange(draft.copy(connectionIDs = if (on) draft.connectionIDs + id else draft.connectionIDs - id)) }
            )
        }
    }
}

@Composable
private fun AidenBotToggleGroup(
    title: String,
    items: List<Pair<String, String>>,
    checked: Set<String>,
    onToggle: (String, Boolean) -> Unit
) {
    val palette = AidenTheme.palette
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.labelMedium, color = palette.secondary, modifier = Modifier.padding(horizontal = 4.dp))
        AidenConnectedColumn {
            items.forEachIndexed { index, (id, label) ->
                val on = checked.contains(id)
                AidenGroupCard(index = index, count = items.size, role = Role.Checkbox, onClick = { onToggle(id, !on) }) {
                    Text(label, color = palette.foreground, modifier = Modifier.weight(1f))
                    Checkbox(checked = on, onCheckedChange = null, colors = CheckboxDefaults.colors(checkedColor = palette.accent))
                }
            }
        }
    }
}
