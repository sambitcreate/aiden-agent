package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairingIdentity
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Pairing-fenced transport: a reconnect may replace the client; another host cannot reuse a draft. */
private class AidenRemoteBotWatchTransport(val coordinator: AidenRemoteCoordinator, val instance: String?, val pairing: AidenPairingIdentity?, val botId: String) : AidenBotWatchTransport {
    private suspend fun <T> request(action: suspend (AidenRemoteClient) -> T): T {
        val client = coordinator.client.value ?: throw AidenRemoteClientException.Disconnected()
        if (!coordinator.holdsPairing(pairing) || !coordinator.holdsReadAuthority(client, instance)) throw AidenRemoteClientException.Disconnected()
        val result = action(client)
        if (!coordinator.holdsPairing(pairing) || !coordinator.holdsReadAuthority(client, instance)) throw AidenRemoteClientException.Disconnected()
        return result
    }
    override suspend fun list() = request { it.botWatches(botId) }
    override suspend fun sources() = request { it.botWatchSources(botId) }
    override suspend fun save(id: String?, request: AidenBotWatchSaveRequest) = request { it.saveBotWatch(botId, id, request) }
    override suspend fun enable(id: String, request: AidenBotWatchMutation) = request { it.enableBotWatch(botId, id, request) }
    override suspend fun remove(id: String, request: AidenBotWatchMutation) = request { it.deleteBotWatch(botId, id, request) }
    override suspend fun test(request: AidenBotWatchTestRequest) = request { it.testBotWatch(botId, request) }
    override suspend fun run(id: String, request: AidenBotWatchMutation) = request { it.runBotWatch(botId, id, request) }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun AidenBotWatchesScreen(botId: String, coordinator: AidenRemoteCoordinator, onNavigateBack: () -> Unit, onOpenBotChat: () -> Unit) {
    val palette = AidenTheme.palette
    val client by coordinator.client.collectAsStateWithLifecycle()
    val server by coordinator.serverInfo.collectAsStateWithLifecycle()
    val instance = coordinator.activeInstanceId
    val pairing = coordinator.activePairing
    fun readable() = coordinator.holdsPairing(pairing) && coordinator.serverInfo.value?.supportsBotWatches == true
    fun writable() = readable() && coordinator.serverInfo.value?.capabilities?.contains(AidenRemoteCapability.BOT_WRITE) == true &&
        coordinator.installationStore.activeInstallation?.canWriteBots == true
    // The coordinator's pairing memo retains drafts/frozen writes across navigation and reconnect.
    val controller = remember(pairing, botId) {
        coordinator.pairingMemo("bot-watches:$botId") {
            AidenBotWatchController(AidenRemoteBotWatchTransport(coordinator, instance, pairing, botId), ::readable, ::writable,
                journal = pairing?.let { identity -> coordinator.botWatchJournals.journal(identity.instanceId, identity.deviceId,
                    identity.pairedAt, botId) { coordinator.holdsPairing(identity) } })
        }
    }
    val ui by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    LifecycleResumeEffect(controller, client, server?.supportsBotWatches) {
        val refresh = scope.launch { controller.refreshWhileActive() }
        onPauseOrDispose { refresh.cancel() }
    }
    var deleting by remember(pairing, botId) { mutableStateOf<AidenBotWatch?>(null) }
    val canManage = writable() && !ui.busy && !ui.pending
    val draft = ui.draft
    Scaffold(containerColor = palette.canvas, topBar = {
        TopAppBar(title = { Text(stringResource(if (draft == null) R.string.bot_watches_title else if (draft.id == null) R.string.bot_watch_new else R.string.bot_watch_edit)) },
            navigationIcon = { IconButton(onClick = { if (draft != null && !ui.pending && !ui.busy) controller.closeDraft() else onNavigateBack() }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
            } }, colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas))
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).aidenReadableWidth().imePadding().verticalScroll(rememberScrollState())
            .padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(stringResource(R.string.bot_watches_description), style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
            if (!readable()) {
                Text(stringResource(if (client == null || server == null) R.string.bot_watches_offline else R.string.bot_watches_old_host), color = palette.secondary)
            } else if (ui.view == null && ui.loading) {
                AidenSkeletonBlock(height = 112.dp, shape = MaterialTheme.shapes.large)
                AidenSkeletonBlock(height = 112.dp, shape = MaterialTheme.shapes.large)
            } else {
                ui.error?.let { error ->
                    Surface(color = if (error == AidenBotWatchError.UNCERTAIN) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.errorContainer,
                        shape = MaterialTheme.shapes.large) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(when (error) {
                                AidenBotWatchError.FAILED -> R.string.bot_watch_failed
                                AidenBotWatchError.CONFLICT -> R.string.bot_watch_conflict
                                AidenBotWatchError.PERMISSION -> R.string.bot_watch_permission
                                AidenBotWatchError.UNCERTAIN -> R.string.bot_watch_uncertain
                                AidenBotWatchError.STORAGE -> R.string.bot_watch_storage_failed
                            }))
                            if (error == AidenBotWatchError.CONFLICT && draft?.id != null) {
                                ui.view?.watches?.find { it.id == draft.id }?.let { current ->
                                    Text(stringResource(R.string.bot_watch_current_config, current.name,
                                        current.source.accountLabel, current.source.resourceLabel, current.everyMinutes, current.prompt),
                                        style = MaterialTheme.typography.bodySmall)
                                }
                            }
                            if (error == AidenBotWatchError.CONFLICT && draft?.id != null) AidenTonalButton(
                                stringResource(R.string.bot_watch_review_revision), onClick = controller::useLatestRevision, enabled = canManage)
                        }
                    }
                }
                if (ui.pending) AidenTonalButton(stringResource(R.string.bot_watch_retry), enabled = writable() && !ui.busy,
                    onClick = { scope.launch { controller.retry() } })
                AidenTonalButton(stringResource(R.string.bot_watch_refresh), enabled = !ui.busy && !ui.loading,
                    onClick = { scope.launch { controller.load() } })
                val view = ui.view
                if (view != null && !view.supported) Text(view.unavailableReason ?: stringResource(R.string.bot_watches_old_host), color = palette.secondary)
                if (view?.supported == true) {
                    if (!writable()) Text(stringResource(R.string.bot_watch_permission), color = palette.secondary)
                    if (draft != null) {
                        AidenBotWatchEditor(draft, view, ui.sources, canManage, ui.discovering,
                            onChange = controller::edit, onDiscover = { scope.launch { controller.discover() } }, onChoose = controller::choose)
                        Text(stringResource(R.string.bot_watch_approval), style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AidenTonalButton(stringResource(if (draft.id == null) R.string.bot_watch_approve else R.string.action_save),
                                enabled = canManage && draft.valid, onClick = { scope.launch { controller.save() } })
                            val saved = view.watches.find { it.id == draft.id }
                            AidenTonalButton(stringResource(if (draft.sourceChoiceId == null && saved != null) R.string.bot_watch_test_saved else R.string.bot_watch_test),
                                enabled = canManage && (draft.sourceChoiceId != null || saved != null),
                                onClick = { scope.launch { controller.test(if (draft.sourceChoiceId == null) saved else null) } })
                            AidenTonalButton(stringResource(R.string.action_cancel), enabled = !ui.busy && !ui.pending, onClick = controller::closeDraft)
                        }
                    } else {
                        AidenTonalButton(stringResource(R.string.bot_watch_new), enabled = canManage && view.watches.size < 16, onClick = { controller.begin() })
                        if (view.watches.isEmpty()) Text(stringResource(R.string.bot_watches_empty), color = palette.secondary)
                        view.watches.forEach { watch ->
                            Surface(color = palette.raised, shape = MaterialTheme.shapes.large) {
                                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text(watch.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
                                    Text("${watch.source.providerLabel} · ${watch.source.accountLabel}\n${watch.source.resourceLabel}", style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                                    Text(stringResource(R.string.bot_watch_interval_state, watch.everyMinutes, watchStateLabel(watch.state)), style = MaterialTheme.typography.bodyMedium)
                                    Text(watch.lastCheckAt?.let { stringResource(R.string.bot_watch_last_check, watchTime(it)) } ?: stringResource(R.string.bot_watch_never_checked), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                                    watch.lastError?.let { Text(it, color = aidenBotErrorTextColor(), style = MaterialTheme.typography.bodySmall) }
                                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        AidenTonalButton(stringResource(R.string.action_edit), enabled = canManage, onClick = { controller.begin(watch) })
                                        AidenTonalButton(stringResource(if (watch.enabled) R.string.bot_watch_pause else R.string.bot_watch_resume), enabled = canManage,
                                            onClick = { scope.launch { controller.setEnabled(watch) } })
                                        AidenTonalButton(stringResource(R.string.bot_watch_test), enabled = canManage, onClick = { scope.launch { controller.test(watch) } })
                                        AidenTonalButton(stringResource(R.string.bot_watch_run), enabled = canManage, onClick = { scope.launch { controller.run(watch) } })
                                        AidenTonalButton(stringResource(R.string.action_delete), destructive = true, enabled = canManage, onClick = { deleting = watch })
                                    }
                                    if (watch.state == AidenBotWatchState.ERROR || watch.lastError != null) AidenTonalButton(stringResource(R.string.bot_watch_open_issue), onClick = onOpenBotChat)
                                }
                            }
                        }
                    }
                    ui.testResult?.let { result ->
                        Surface(color = palette.raised, shape = MaterialTheme.shapes.large) {
                            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(stringResource(R.string.bot_watch_test_result, watchCheckLabel(result.result), result.itemCount, result.changeCount))
                                Text(stringResource(R.string.bot_watch_test_no_run), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                                result.preview.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                            }
                        }
                    }
                    ui.runAdmitted?.let { Text(stringResource(if (it) R.string.bot_watch_run_accepted else R.string.bot_watch_run_suppressed), color = palette.secondary) }
                }
            }
        }
    }
    deleting?.let { watch -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text(stringResource(R.string.bot_watch_delete_title, watch.name)) },
        text = { Text(stringResource(R.string.bot_watch_delete_body)) },
        confirmButton = { AidenDialogConfirmButton(stringResource(R.string.action_delete), destructive = true, enabled = canManage,
            onClick = { deleting = null; scope.launch { controller.remove(watch) } }) },
        dismissButton = { AidenDialogDismissButton(onClick = { deleting = null }) }, shape = AidenShape.Dialog, containerColor = palette.raised) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AidenBotWatchEditor(draft: AidenBotWatchDraft, view: AidenBotWatchList, sources: AidenBotWatchSourceList?, enabled: Boolean,
    discovering: Boolean, onChange: ((AidenBotWatchDraft) -> AidenBotWatchDraft) -> Unit, onDiscover: () -> Unit, onChoose: (AidenBotWatchSourceChoice) -> Unit) {
    val palette = AidenTheme.palette
    Surface(color = palette.raised, shape = MaterialTheme.shapes.large) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            draft.sourceLabel?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            AidenTonalButton(stringResource(if (discovering) R.string.bot_watch_discovering else R.string.bot_watch_discover), enabled = enabled && !discovering, onClick = onDiscover)
            view.templates.filterNot { it.available }.forEach { Text("${it.title}: ${it.unavailableReason ?: it.description}", style = MaterialTheme.typography.bodySmall, color = palette.secondary) }
            sources?.unavailableReasons?.forEach { Text(it, color = palette.secondary, style = MaterialTheme.typography.bodySmall) }
            sources?.choices?.forEach { source ->
                val available = source.available && view.templates.find { it.id == source.templateId }?.available == true
                Surface(onClick = { onChoose(source) }, enabled = enabled && available,
                    color = if (source.id == draft.sourceChoiceId) MaterialTheme.colorScheme.surfaceContainerHigh else palette.canvas,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.semantics { role = Role.RadioButton; selected = source.id == draft.sourceChoiceId }) {
                    Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RadioButton(selected = source.id == draft.sourceChoiceId, onClick = null, enabled = enabled && available)
                        Column {
                            Text("${source.providerLabel} · ${source.accountLabel}", style = MaterialTheme.typography.bodyMedium)
                            Text(source.resourceLabel, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                            source.unavailableReason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = palette.secondary) }
                        }
                    }
                }
            }
            TextField(draft.name, { text -> onChange { it.copy(name = AidenBotWatchWire.clamp(text, AidenBotWatchWire.MAX_NAME)) } }, enabled = enabled,
                label = { Text(stringResource(R.string.bot_watch_name)) }, singleLine = true, colors = aidenTextFieldColors(), shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth())
            when (val condition = draft.condition) {
                is AidenBotWatchCondition.Email -> {
                    TextField(condition.sender.orEmpty(), { text -> onChange { it.copy(condition = condition.copy(sender = AidenBotWatchWire.clamp(text, 200).ifBlank { null })) } },
                        enabled = enabled, label = { Text(stringResource(R.string.bot_watch_sender)) }, singleLine = true, colors = aidenTextFieldColors(), shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth())
                    TextField(condition.subject.orEmpty(), { text -> onChange { it.copy(condition = condition.copy(subject = AidenBotWatchWire.clamp(text, 200).ifBlank { null })) } },
                        enabled = enabled, label = { Text(stringResource(R.string.bot_watch_subject)) }, singleLine = true, colors = aidenTextFieldColors(), shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth())
                    val unreadLabel = stringResource(R.string.bot_watch_unread)
                    ListItem(headlineContent = { Text(unreadLabel) }, trailingContent = {
                        Switch(condition.unreadOnly, { value -> onChange { it.copy(condition = condition.copy(unreadOnly = value)) } }, enabled = enabled, modifier = Modifier.semantics { contentDescription = unreadLabel })
                    }, colors = ListItemDefaults.colors(containerColor = palette.raised))
                }
                is AidenBotWatchCondition.Calendar -> {
                    TextField(draft.calendarTimezone ?: condition.timezone, { text -> onChange { it.copy(calendarTimezone = AidenBotWatchWire.clamp(text, 100)) } },
                        enabled = enabled, label = { Text(stringResource(R.string.bot_watch_timezone)) }, singleLine = true, colors = aidenTextFieldColors(), shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth())
                    val windowLabel = stringResource(R.string.bot_watch_window, condition.lookAheadMinutes)
                    Text(windowLabel, style = MaterialTheme.typography.bodyMedium)
                    Slider(value = condition.lookAheadMinutes.toFloat(), onValueChange = { minutes -> onChange { it.copy(condition = condition.copy(lookAheadMinutes = minutes.toInt())) } },
                        valueRange = 15f..1440f, enabled = enabled, modifier = Modifier.semantics { contentDescription = windowLabel })
                }
            }
            Text(stringResource(R.string.bot_watch_frequency), style = MaterialTheme.typography.labelLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                (view.templates.find { it.id == draft.condition.templateId }?.intervals ?: emptyList()).forEach { minutes ->
                    AidenTonalButton(stringResource(if (minutes == draft.everyMinutes) R.string.bot_watch_minutes_selected else R.string.bot_watch_minutes, minutes),
                        enabled = enabled, modifier = Modifier.semantics { selected = minutes == draft.everyMinutes }, onClick = { onChange { it.copy(everyMinutes = minutes) } })
                }
            }
            TextField(draft.prompt, { text -> onChange { it.copy(prompt = AidenBotWatchWire.clamp(text, AidenBotWatchWire.MAX_PROMPT)) } }, enabled = enabled,
                label = { Text(stringResource(R.string.bot_watch_prompt)) }, minLines = 3, colors = aidenTextFieldColors(), shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth())
        }
    }
}

private fun watchTime(time: Long): String = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(time))
@Composable private fun watchStateLabel(state: AidenBotWatchState): String = stringResource(when (state) {
    AidenBotWatchState.WAITING -> R.string.bot_watch_state_waiting; AidenBotWatchState.EMPTY -> R.string.bot_watch_state_empty
    AidenBotWatchState.UNCHANGED -> R.string.bot_watch_state_unchanged; AidenBotWatchState.CHANGED -> R.string.bot_watch_state_changed
    AidenBotWatchState.ERROR -> R.string.bot_watch_state_error; AidenBotWatchState.PAUSED -> R.string.bot_watch_state_paused
})
@Composable private fun watchCheckLabel(state: AidenBotWatchCheckResult): String = stringResource(when (state) {
    AidenBotWatchCheckResult.BASELINE -> R.string.bot_watch_state_baseline; AidenBotWatchCheckResult.EMPTY -> R.string.bot_watch_state_empty
    AidenBotWatchCheckResult.UNCHANGED -> R.string.bot_watch_state_unchanged; AidenBotWatchCheckResult.CHANGED -> R.string.bot_watch_state_changed
})
