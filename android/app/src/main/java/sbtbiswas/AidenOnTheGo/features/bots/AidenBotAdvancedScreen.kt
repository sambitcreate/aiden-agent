package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.annotation.StringRes
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelPickerField
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelRoute
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSegmentedPillRow
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonBlock
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth

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

/** Everything on the Advanced page: the model and what the Bot can use. */
data class AidenBotAdvancedDraft(
    val usesFullAccess: Boolean,
    val customAccess: AidenBotCustomAccessDraft
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
                customAccess = custom
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

    fun isSaveable(catalog: AidenBotCapabilityCatalog): Boolean =
        try { accessUpdate(catalog); true } catch (_: Exception) { false }
}

/**
 * The Bot as it will be once [this] draft saves (R15): the model and access show at once, until
 * the Mac's own Bot replaces it. A Bot that needed a model doesn't any more.
 */
fun AidenBotAdvancedDraft.optimistic(bot: AidenBotDetail, catalog: AidenBotCapabilityCatalog): AidenBotDetail {
    val update = accessUpdate(catalog)
    return bot.copy(
        access = bot.access.copy(accessMode = update.accessMode, custom = update.custom),
        modelSelection = AidenBotModelSelection(customAccess.providerID, customAccess.modelID),
        sessionState = if (bot.sessionState == AidenBotSessionState.NEEDS_MODEL) AidenBotSessionState.IDLE else bot.sessionState
    )
}

/**
 * Advanced's Save, applied at once (R15): [show] gets the optimistic Bot now, and the save runs
 * on [host] (outliving the sheet), waiting for the connection and bounded. The Mac's Bot then
 * replaces it through [settled]; a failure puts back what was there, unless something newer
 * replaced it, and says why through [failed]. Only the Mac's Bot is kept on disk: the
 * optimistic one and a rollback are shown, never written.
 */
fun aidenBotSaveAdvancedOptimistically(
    host: AidenBotSaveHost,
    bot: AidenBotDetail,
    draft: AidenBotAdvancedDraft,
    catalog: AidenBotCapabilityCatalog,
    show: (AidenBotDetail) -> Unit,
    settled: (AidenBotDetail) -> Unit,
    failed: (AidenBotChatActivityFailure) -> Unit
) {
    if (!draft.changesAccess(bot, catalog)) {
        show(bot)
        return
    }
    val optimistic = draft.optimistic(bot, catalog)
    host.show(optimistic)
    show(optimistic)
    host.launch {
        try {
            val saved = aidenBotHeldRequest(host.waitForConnection) { aidenBotSaveAdvanced(host.connected(), bot, draft, catalog) }
            host.cache(saved)
            settled(saved)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (host.cached(bot.id)?.let { it == optimistic } != false) host.show(bot)
            settled(bot)
            failed(aidenBotSaveFailure(error))
        }
    }
}

/** Saves an Advanced draft's access and returns the fresh Bot. */
suspend fun aidenBotSaveAdvanced(
    client: AidenRemoteClient,
    bot: AidenBotDetail,
    draft: AidenBotAdvancedDraft,
    catalog: AidenBotCapabilityCatalog
): AidenBotDetail {
    var current = bot
    if (draft.changesAccess(bot, catalog)) {
        client.updateBotAccess(current.id, current.access.revision, draft.accessUpdate(catalog))
        current = client.bot(current.id)
    }
    return current
}

enum class AidenBotAccessChoice(@StringRes val label: Int) {
    FULL(R.string.bot_access_choice_full),
    CUSTOM(R.string.bot_access_choice_custom)
}

/** Connected choice between Full and Custom access. */
@Composable
fun AidenBotAccessChoiceSelector(
    usesFullAccess: Boolean,
    onUsesFullAccessChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier
) {
    val labels = AidenBotAccessChoice.entries.associateWith { stringResource(it.label) }
    AidenSegmentedPillRow(
        options = AidenBotAccessChoice.entries,
        selected = if (usesFullAccess) AidenBotAccessChoice.FULL else AidenBotAccessChoice.CUSTOM,
        onSelect = { onUsesFullAccessChange(it == AidenBotAccessChoice.FULL) },
        label = { labels.getValue(it) },
        modifier = modifier
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotAdvancedSheet(
    bot: AidenBotDetail,
    client: AidenRemoteClient?,
    onDismiss: () -> Unit,
    onSaved: (AidenBotDetail) -> Unit,
    /** Chat activity needs the Mac's `bot-activity-v1` and the phone's grant: see [aidenBotShowsChatActivity]. */
    chatActivityAvailable: Boolean = false,
    /** What Chat activity saves with; the row is offered only when this is set too. */
    chatActivityHost: AidenBotChatActivityHost? = null,
    /** The newest Bot after Chat activity picks: once when Advanced closes, or at once for a pick that finishes later. */
    onChatActivitySaved: (AidenBotDetail) -> Unit = {},
    /**
     * Where Save runs (R15). With it, Save applies at once: [onSaved] gets the optimistic Bot and
     * the sheet's caller closes it; the Mac's Bot (or, after a failure, the Bot as it was) follows
     * through [onSaveSettled], and a failure is said through [onSaveFailed].
     */
    saveHost: AidenBotSaveHost? = null,
    onSaveSettled: (AidenBotDetail) -> Unit = {},
    onSaveFailed: (String) -> Unit = {}
) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    // A Chat activity save moves the Bot's revision; Advanced's own Save uses the newest.
    var latestBot by remember(bot.id) { mutableStateOf(bot) }
    var chatActivityController by remember(bot.id) { mutableStateOf<AidenBotChatActivityController?>(null) }
    var showingChatActivity by remember(bot.id) { mutableStateOf(false) }
    val currentOnChatActivitySaved by rememberUpdatedState(onChatActivitySaved)
    val reporter = remember(bot.id) { AidenBotChatActivityReporter { currentOnChatActivitySaved(it) } }
    // The screens behind hear about picks when Advanced goes away, however it goes.
    DisposableEffect(reporter) { onDispose { reporter.close() } }
    val close = {
        reporter.close()
        onDismiss()
    }
    val showsChatActivityRow = chatActivityAvailable && chatActivityHost != null
    var catalog by remember { mutableStateOf<AidenBotCapabilityCatalog?>(null) }
    var draft by remember { mutableStateOf<AidenBotAdvancedDraft?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var isSaving by remember { mutableStateOf(false) }

    // While the Mac connects, the sections show their placeholders; they fill in once it does (R15).
    LaunchedEffect(bot.id, client) {
        val cl = client ?: return@LaunchedEffect
        loadError = null
        try {
            val cat = cl.botCapabilityCatalog(bot.id)
            catalog = cat
            draft = AidenBotAdvancedDraft.fromDetail(bot, cat)
            if (draft == null) loadError = resources.getString(R.string.bot_advanced_needs_model)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            loadError = resources.getString(R.string.bot_advanced_load_failed)
        }
    }

    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Scaffold(
            containerColor = palette.canvas,
            topBar = {
                TopAppBar(
                    title = { Text(stringResource(R.string.bot_advanced_title), fontWeight = FontWeight.SemiBold) },
                    navigationIcon = {
                        IconButton(onClick = close) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back), tint = palette.foreground)
                        }
                    },
                    actions = {
                        val cat = catalog
                        val current = draft
                        AidenPrimaryButton(
                            text = if (isSaving) stringResource(R.string.action_saving) else stringResource(R.string.action_save),
                            enabled = !isSaving && cat != null && current != null && current.isSaveable(cat),
                            onClick = {
                                if (cat == null || current == null) return@AidenPrimaryButton
                                val host = saveHost
                                if (host != null) {
                                    // The screen behind gets this Bot, which already holds any Chat activity pick.
                                    reporter.settle()
                                    aidenBotSaveAdvancedOptimistically(
                                        host, latestBot, current, cat,
                                        show = onSaved,
                                        settled = onSaveSettled,
                                        failed = { onSaveFailed(resources.getString(aidenBotSaveFailureText(it))) }
                                    )
                                    return@AidenPrimaryButton
                                }
                                val cl = client ?: return@AidenPrimaryButton
                                scope.launch {
                                    isSaving = true
                                    saveError = null
                                    try {
                                        val saved = aidenBotSaveAdvanced(cl, latestBot, current, cat)
                                        // The screen behind gets this Bot, which already holds any Chat activity pick.
                                        reporter.settle()
                                        onSaved(saved)
                                    } catch (error: CancellationException) {
                                        throw error
                                    } catch (_: Exception) {
                                        saveError = resources.getString(R.string.bot_save_failed)
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
                    .aidenReadableWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = AidenUi.ScreenGutter, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(AidenUi.SectionGap)
            ) {
                when {
                    loadError != null -> Text(loadError.orEmpty(), color = palette.secondary)
                    cat == null || current == null -> AidenBotAdvancedPlaceholder(stringResource(R.string.bot_advanced_loading))
                    else -> {
                        AidenBotAdvancedSection(title = stringResource(R.string.bot_advanced_model)) {
                            AidenModelPickerField(
                                title = stringResource(R.string.bot_advanced_model),
                                providers = remember(cat) { aidenBotModelPickerProviders(cat) },
                                selection = AidenModelRoute(current.customAccess.providerID, current.customAccess.modelID),
                                onSelect = { entry ->
                                    draft = current.copy(
                                        customAccess = current.customAccess.copy(
                                            providerID = entry.route.providerId,
                                            modelID = entry.route.modelId
                                        )
                                    )
                                }
                            )
                            TextButton(onClick = { draft = current.withRecommendedModel(cat) }) {
                                Text(stringResource(R.string.bot_advanced_use_recommended), color = palette.accent)
                            }
                        }

                        AidenBotAdvancedSection(
                            title = stringResource(R.string.bot_advanced_access),
                            footer = if (current.usesFullAccess)
                                stringResource(R.string.bot_advanced_access_full_footer)
                            else
                                stringResource(R.string.bot_advanced_access_custom_footer)
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
                    }
                }

                // Chat activity opens from the cached Bot: it doesn't wait for the catalog, a
                // connection, or a clean Advanced form, so it stays reachable offline.
                if (showsChatActivityRow) {
                    AidenConnectedColumn {
                        AidenGroupCard(
                            index = 0,
                            count = 1,
                            onClick = {
                                chatActivityController = chatActivityHost?.controller(latestBot) { saved ->
                                    latestBot = saved
                                    reporter.saved(saved)
                                }
                                showingChatActivity = true
                            }
                        ) {
                            Text(stringResource(R.string.bot_chat_activity_title), color = palette.foreground, modifier = Modifier.weight(1f))
                            Text(aidenBotChatActivitySummary(latestBot.chatActivity), color = palette.secondary, style = MaterialTheme.typography.bodyMedium)
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = palette.secondary)
                        }
                    }
                }

                saveError?.let { Text(it, color = aidenBotErrorTextColor(), style = MaterialTheme.typography.bodySmall) }
            }
        }
    }

    val controller = chatActivityController
    if (showsChatActivityRow && showingChatActivity && controller != null && chatActivityHost != null) {
        // The host lets go of this page's listener when it closes (once a running save has reported).
        DisposableEffect(controller) { onDispose { chatActivityHost.release(latestBot.id, controller) } }
        AidenBotChatActivityDialog(
            botName = latestBot.name,
            controller = controller,
            launch = chatActivityHost.launch,
            onDismiss = { showingChatActivity = false }
        )
    }
}

/**
 * Model and Access placeholders while the capability catalog arrives, sized like the real
 * sections (label, picker and its "Use recommended" button; label, the access choice and its
 * footer) so the page doesn't jump when they land.
 */
@Composable
private fun AidenBotAdvancedPlaceholder(loadingDescription: String) {
    Column(
        verticalArrangement = Arrangement.spacedBy(AidenUi.SectionGap),
        modifier = Modifier.clearAndSetSemantics { contentDescription = loadingDescription }
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            AidenSkeletonBlock(width = 96.dp, height = 12.dp)
            AidenSkeletonBlock(height = 56.dp, shape = MaterialTheme.shapes.large)
            AidenSkeletonBlock(width = 160.dp, height = 40.dp, shape = MaterialTheme.shapes.large)
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            AidenSkeletonBlock(width = 96.dp, height = 12.dp)
            AidenSkeletonBlock(height = 48.dp, shape = MaterialTheme.shapes.extraLarge)
            AidenSkeletonBlock(height = 32.dp)
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
                title = stringResource(R.string.bot_advanced_folders),
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
                Text(stringResource(R.string.bot_advanced_run_commands), color = palette.foreground, modifier = Modifier.weight(1f))
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
                title = stringResource(R.string.bot_advanced_connected_apps),
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
