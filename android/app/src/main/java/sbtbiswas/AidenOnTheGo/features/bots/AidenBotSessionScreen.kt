package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.outlined.EventRepeat
import androidx.compose.material.icons.outlined.SdStorage
import androidx.compose.material3.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.chat.AidenQuestionCard
import sbtbiswas.AidenOnTheGo.features.chat.AidenRunInputSplitButton
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonBlock
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors
import java.time.Instant

/** The glyph a connect card or preset chip shows for a host `iconId`. */
enum class AidenBotConnectionGlyph(val icon: ImageVector) {
    EMAIL(Icons.Default.Email),
    CALENDAR(Icons.Default.CalendarMonth),
    DOCUMENTS(Icons.Default.Description),
    CHAT(Icons.Default.Forum),
    APPS(Icons.Default.Apps),
    CODE(Icons.Default.Code),
    TASKS(Icons.Default.TaskAlt),
    /** Neutral fallback for any connection the phone has no icon for. */
    GENERIC(Icons.Default.Extension)
}

fun aidenBotConnectionGlyph(iconId: String): AidenBotConnectionGlyph = when (iconId.lowercase()) {
    "gmail", "outlook-email", "outlook", "email", "mail" -> AidenBotConnectionGlyph.EMAIL
    "google-calendar", "outlook-calendar", "calendar" -> AidenBotConnectionGlyph.CALENDAR
    "notion", "google-drive", "google-docs" -> AidenBotConnectionGlyph.DOCUMENTS
    "slack", "discord", "teams" -> AidenBotConnectionGlyph.CHAT
    "composio" -> AidenBotConnectionGlyph.APPS
    "github", "gitlab" -> AidenBotConnectionGlyph.CODE
    "linear", "jira", "asana", "todoist" -> AidenBotConnectionGlyph.TASKS
    else -> AidenBotConnectionGlyph.GENERIC
}

object AidenBotSessionTags {
    const val INTERRUPTED_CARD = "bot_session_interrupted_card"
    const val FAILED_TURN_CARD = "bot_session_failed_turn_card"
    const val NEEDS_MODEL_CARD = "bot_session_needs_model_card"
    const val COMPOSER = "bot_session_composer"
    const val MEMORY_CAPTION = "bot_session_memory_caption"
    const val PROPOSAL_CARD = "bot_session_proposal_card"
}

/** Neutral squircle tile with a connection glyph; no coloured border. */
@Composable
fun AidenBotConnectionIcon(iconId: String, name: String, size: androidx.compose.ui.unit.Dp = 36.dp) {
    val palette = AidenTheme.palette
    Box(
        Modifier
            .size(size)
            .clip(AidenShape.Button)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .semantics { contentDescription = name },
        contentAlignment = Alignment.Center
    ) {
        Icon(aidenBotConnectionGlyph(iconId).icon, contentDescription = null, tint = palette.foreground, modifier = Modifier.size(size * 0.55f))
    }
}

/**
 * A Bot's one durable chat (`bot-durable-session-v1`): loads the session, follows its live
 * feed, and sends through `POST /bots/{id}/messages`.
 */
@Composable
fun AidenBotSessionScreen(
    botId: String,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    botDeleter: AidenBotDeleter? = AidenRemoteBotDeleter,
    onBotDeleted: () -> Unit = onNavigateBack,
    /** The "Memory updated" caption opens Profile → Memory. */
    onNavigateToBotMemory: (String) -> Unit = onNavigateToBotProfile
) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsStateWithLifecycle()
    val serverInfo by coordinator.serverInfo.collectAsStateWithLifecycle()
    val identity = rememberAidenBotChatIdentity(coordinator, botId, "")
    val knownState = coordinator.botCache.botList.value?.bots?.firstOrNull { it.id == botId }?.sessionState
        ?: coordinator.botCache.getBotDetail(botId)?.sessionState
    val cl = client
    if (cl == null) {
        Box(Modifier.fillMaxSize().background(palette.canvas), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.bot_session_connect), color = palette.secondary)
        }
        return
    }
    val controller = remember(botId, cl) {
        // The pairing names the chat's cached transcript and its unsent messages (R14, R17).
        val sessionKey = coordinator.installationStore.activeInstallation?.let { AidenBotSessionKey(it.instanceId, it.deviceId, botId) }
        AidenBotSessionController(
            botId,
            AidenRemoteBotSessionTransport(cl),
            scope,
            knownState,
            activitySupported = serverInfo?.supportsBotActivity == true,
            sessionKey = sessionKey,
            store = coordinator.botSessionStore
        )
    }
    DisposableEffect(controller) {
        controller.start()
        onDispose { controller.stopFollowing() }
    }
    val ui by controller.state.collectAsStateWithLifecycle()
    val activitySupported = serverInfo?.supportsBotActivity == true
    LaunchedEffect(controller, activitySupported) { controller.setActivitySupported(activitySupported) }
    // The wording comes from the Bot's detail: cached first, then the Mac's. Only a Mac that
    // offers Chat activity now decides it, and the feed never waits for this read.
    val botDetails by coordinator.botCache.botDetails.collectAsStateWithLifecycle()
    val chatActivity = aidenBotChatActivity(serverInfo, botDetails[botId])
    LaunchedEffect(controller, chatActivity) {
        controller.setWording(chatActivity?.wording ?: AidenBotChatActivityWording.FOLLOWS)
    }
    LaunchedEffect(controller) {
        try {
            coordinator.botCache.putBotDetail(cl.bot(botId))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep the cached or default wording; the line still works.
        }
    }
    var draft by rememberSaveable(botId) { mutableStateOf("") }
    // Steer or Queue while the Bot works: Queue by default, and Queue again once the turn ends.
    var busyMode by remember(botId) { mutableStateOf(AidenStreamInputMode.QUEUE) }
    LaunchedEffect(ui.isRunning) { busyMode = aidenBotBusyMode(busyMode, ui.isRunning) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var isDeleting by remember { mutableStateOf(false) }
    // "Set up" (no AI model) and "Advanced" (access changed) open the Bot's Advanced settings.
    var advancedBot by remember { mutableStateOf<AidenBotDetail?>(null) }
    var openingAdvanced by remember { mutableStateOf(false) }
    fun openAdvanced() {
        if (openingAdvanced) return
        openingAdvanced = true
        scope.launch {
            try {
                val detail = cl.bot(botId)
                coordinator.botCache.putBotDetail(detail)
                advancedBot = detail
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Offline: Advanced still opens from the cached Bot, so Chat activity stays reachable.
                val cached = coordinator.botCache.getBotDetail(botId)
                if (cached != null) advancedBot = cached
                else coordinator.presentError(resources.getString(R.string.bot_session_unreachable))
            } finally {
                openingAdvanced = false
            }
        }
    }
    // Files live on the Bot's conversation chat; resolve it when the menu asks.
    var filesChatId by remember(botId) { mutableStateOf<String?>(null) }
    var openingFiles by remember { mutableStateOf(false) }
    fun openFiles() {
        if (openingFiles) return
        openingFiles = true
        scope.launch {
            try {
                val chatId = aidenBotFilesChatId(botId, cl.botConversations(botId = botId).conversations)
                if (chatId == null) {
                    coordinator.presentError(resources.getString(R.string.bot_files_unavailable))
                } else {
                    filesChatId = chatId
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                coordinator.presentError(resources.getString(R.string.bot_files_unavailable))
            } finally {
                openingFiles = false
            }
        }
    }
    val canDelete = aidenBotDeleteAvailable(serverInfo, botDeleter)
    val canRequestConnections = serverInfo?.supportsBotConnectionRequests == true
    val canAnswerProposals = serverInfo?.supportsBotProactive == true
    val canOpenMemory = serverInfo?.supportsBotMemory == true
    val listState = rememberLazyListState()
    // The Mac's transcript, or the cached one while connecting (R14).
    val entries = ui.entries
    val rows = remember(entries) { aidenBotSessionRows(entries) }
    val partial = ui.session?.partial
    val outgoing = ui.outgoing

    LaunchedEffect(
        entries.size, partial, ui.isInterrupted, ui.needsModel,
        ui.queued.size, outgoing.size, ui.session?.activity?.phase
    ) {
        val count = listState.layoutInfo.totalItemsCount
        if (count > 0) listState.animateScrollToItem(count - 1)
    }

    if (confirmingDelete) {
        AidenBotDeleteDialog(
            name = identity.name,
            isDeleting = isDeleting,
            onDismiss = { confirmingDelete = false },
            onConfirm = {
                val deleter = botDeleter ?: return@AidenBotDeleteDialog
                scope.launch {
                    isDeleting = true
                    try {
                        deleter.delete(cl, botId)
                        // The Bot and its feed are gone: stop following before leaving.
                        controller.stopFollowing()
                        confirmingDelete = false
                        onBotDeleted()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        confirmingDelete = false
                        coordinator.presentError(resources.getString(R.string.bot_delete_failed))
                    } finally {
                        isDeleting = false
                    }
                }
            }
        )
    }

    advancedBot?.let { bot ->
        val chatActivityHost = remember(cl) { coordinator.botChatActivityHost() }
        AidenBotAdvancedSheet(
            bot = bot,
            client = cl,
            onDismiss = { advancedBot = null },
            onSaved = { saved ->
                coordinator.botCache.putBotDetail(saved)
                advancedBot = null
                scope.launch { controller.refetch() }
            },
            chatActivityAvailable = aidenBotShowsChatActivity(serverInfo, hasBaseline = true),
            chatActivityHost = chatActivityHost,
            onChatActivitySaved = { saved ->
                coordinator.botCache.putBotDetail(saved)
                controller.setWording(saved.chatActivity?.wording ?: AidenBotChatActivityWording.FOLLOWS)
                scope.launch { controller.refetch() }
            }
        )
    }

    filesChatId?.let { chatId ->
        AidenBotFilesSheet(chatId = chatId, coordinator = coordinator, onDismiss = { filesChatId = null })
    }

    Scaffold(
        containerColor = palette.canvas,
        contentWindowInsets = WindowInsets.statusBars,
        topBar = {
            AidenBotChatTopBar(
                identity = identity,
                coordinator = coordinator,
                isStreaming = ui.canStopTurn,
                canStop = !ui.isStopping,
                onStop = { scope.launch { controller.stop() } },
                onBack = onNavigateBack,
                onOpenProfile = { onNavigateToBotProfile(botId) },
                onOpenFiles = ::openFiles,
                onOpenMemory = if (canOpenMemory) ({ onNavigateToBotMemory(botId) }) else null,
                onOpenAdvanced = ::openAdvanced,
                canDelete = canDelete,
                onDelete = { confirmingDelete = true }
            )
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).aidenReadableWidth().imePadding()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = AidenUi.ScreenGutter, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                // Skeletons while the first read is on its way; they hold still once it fails,
                // and the hint above the composer offers Try again.
                val skeleton = aidenBotSkeletonLook(ui)
                if (skeleton != AidenBotSkeletonLook.HIDDEN) {
                    item(key = "loading") { AidenBotSessionSkeleton(shimmer = skeleton == AidenBotSkeletonLook.SHIMMERING) }
                } else if (ui.botMissing && ui.session == null) {
                    item(key = "failed") {
                        Text(
                            stringResource(R.string.bot_session_missing),
                            color = palette.secondary,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(top = 48.dp)
                        )
                    }
                }
                items(rows, key = { it.key }) { row ->
                    if (row is AidenBotSessionRow.MemoryUpdated) {
                        AidenBotMemoryUpdatedCaption(
                            onOpen = if (canOpenMemory) ({ onNavigateToBotMemory(botId) }) else null
                        )
                    }
                    if (row is AidenBotSessionRow.Entry) when (val entry = row.entry) {
                        is AidenBotSessionEntry.Message -> AidenBotSessionMessageRow(entry)
                        is AidenBotSessionEntry.ConnectCard -> AidenBotConnectCard(
                            card = entry,
                            canRequest = canRequestConnections,
                            phase = ui.connectRequests[entry.pluginId] ?: AidenBotConnectRequestPhase.IDLE,
                            onRequest = { scope.launch { controller.requestConnection(entry.pluginId) } }
                        )
                        is AidenBotSessionEntry.Notice -> Text(
                            stringResource(R.string.bot_session_reset),
                            style = MaterialTheme.typography.labelMedium,
                            color = palette.secondary,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
                        )
                        is AidenBotSessionEntry.FailedTurn -> AidenBotFailedTurnCard(
                            canRetry = ui.retryableFailedTurn?.id == entry.id,
                            onRetry = { scope.launch { controller.retry() } }
                        )
                        // Folded into a caption row above; never rendered on its own.
                        is AidenBotSessionEntry.MemoryUpdate -> Unit
                        is AidenBotSessionEntry.RoutineProposal -> AidenBotRoutineProposalCard(
                            card = entry,
                            botName = identity.name,
                            canAnswer = canAnswerProposals,
                            phase = ui.proposalResponses[entry.proposalId],
                            onAnswer = { decision -> scope.launch { controller.respondToProposal(entry.proposalId, decision) } }
                        )
                    }
                }
                if (!partial.isNullOrEmpty()) {
                    item(key = "partial") {
                        AidenBotAssistantBubble(text = partial, streaming = ui.isRunning)
                    }
                }
                // The Mac's Queued bubbles, then this phone's own messages on their way (R14).
                items(ui.queued, key = { "queued-${it.submissionId}" }) { message -> AidenBotQueuedBubble(message) }
                items(outgoing, key = { it.id }) { message ->
                    AidenBotOutgoingBubble(
                        message = message,
                        look = ui.look(message),
                        canRetry = ui.canSend,
                        onRetry = { scope.launch { controller.retrySend(message.id) } },
                        onRemove = { controller.discardSend(message.id) }
                    )
                }
                item(key = "status") { AidenBotStatusLine(ui) }
                if (ui.isInterrupted) {
                    item(key = "interrupted") {
                        AidenBotInterruptedCard(
                            blocked = ui.session?.blocked,
                            busy = ui.isResuming || ui.isDismissing,
                            onResume = { scope.launch { controller.resume() } },
                            onDismiss = { scope.launch { controller.dismiss() } },
                            onOpenAdvanced = ::openAdvanced
                        )
                    }
                }
                ui.session?.question?.let { question ->
                    item(key = "question-${question.waitId}") {
                        // The Bot's A–E quick replies. A Bot question has no deadline.
                        AidenQuestionCard(
                            prompt = AidenPendingQuestion(
                                id = question.waitId,
                                questions = question.questions,
                                expiresAt = Instant.MAX,
                                canRespond = true
                            ),
                            enabled = !ui.isAnsweringQuestion && !ui.needsModel,
                            onSubmit = { request -> scope.launch { controller.answerQuestion(request) } }
                        )
                    }
                }
                ui.session?.approval?.let { approval ->
                    item(key = "approval-${approval.waitId}") {
                        AidenBotApprovalCard(approval, enabled = !ui.isRespondingToApproval) { decision ->
                            scope.launch { controller.respondToApproval(decision) }
                        }
                    }
                }
                if (ui.needsModel) {
                    item(key = "needs-model") { AidenBotNeedsModelCard(busy = openingAdvanced, onSetUp = ::openAdvanced) }
                }
                ui.actionError?.let { message ->
                    item(key = "error") {
                        Text(message, color = palette.danger, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            aidenBotConnectionHint(ui, System.currentTimeMillis())?.let { hint ->
                AidenBotConnectionHintRow(hint, onTryAgain = { scope.launch { controller.refetch() } })
            }
            AidenBotSessionComposer(
                draft = draft,
                onDraftChange = { draft = it.take(AidenBotSessionWire.MAX_MESSAGE_LENGTH) },
                placeholder = aidenBotChatPlaceholder(identity.name),
                enabled = ui.canSend,
                busy = ui.offersBusyModes,
                busyMode = busyMode,
                onPickBusyMode = { busyMode = it },
                onSend = {
                    // The draft clears at once and the bubble shows (R14); a refused message comes back.
                    val text = draft
                    val mode = if (ui.offersBusyModes) busyMode else null
                    draft = ""
                    scope.launch {
                        if (!controller.send(text, mode) && draft.isEmpty()) draft = text
                    }
                }
            )
        }
    }
}

/** The person's bubble: rounded on every corner but the one nearest the composer. */
internal val AidenBotUserBubbleShape = RoundedCornerShape(20.dp, 20.dp, 4.dp, 20.dp)

/** Transcript-shaped placeholders while a Bot chat's first read is on its way; still once it fails. */
@Composable
private fun AidenBotSessionSkeleton(shimmer: Boolean) {
    val animate = shimmer && aidenBotIsResumed()
    val loadingDescription = stringResource(R.string.bot_session_loading)
    Column(
        verticalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp)
            .clearAndSetSemantics { contentDescription = loadingDescription }
    ) {
        AidenSkeletonBlock(width = 220.dp, height = 44.dp, shape = MaterialTheme.shapes.large, animate = animate, modifier = Modifier.align(Alignment.End))
        AidenSkeletonBlock(height = 14.dp, animate = animate)
        AidenSkeletonBlock(width = 240.dp, height = 14.dp, animate = animate)
        AidenSkeletonBlock(width = 180.dp, height = 44.dp, shape = MaterialTheme.shapes.large, animate = animate, modifier = Modifier.align(Alignment.End))
        AidenSkeletonBlock(height = 14.dp, animate = animate)
    }
}

@Composable
private fun AidenBotSessionMessageRow(message: AidenBotSessionEntry.Message) {
    val palette = AidenTheme.palette
    when (message.role) {
        AidenBotMessageRole.USER -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
            message.label?.let { label ->
                Text(label, style = MaterialTheme.typography.labelSmall, color = palette.secondary, modifier = Modifier.padding(bottom = 4.dp, end = 4.dp))
            }
            Surface(color = palette.accent, shape = AidenBotUserBubbleShape, modifier = Modifier.widthIn(max = 320.dp)) {
                Text(
                    message.text,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)
                )
            }
        }
        AidenBotMessageRole.ASSISTANT -> Column(Modifier.fillMaxWidth()) {
            AidenBotAssistantBubble(text = message.text, streaming = false)
            if (message.interrupted == true) {
                Text(stringResource(R.string.bot_session_stopped), style = MaterialTheme.typography.labelSmall, color = palette.secondary, modifier = Modifier.padding(start = 4.dp, top = 2.dp))
            }
        }
    }
}

@Composable
private fun AidenBotAssistantBubble(text: String, streaming: Boolean) {
    val palette = AidenTheme.palette
    Text(
        text = if (streaming) "$text ▍" else text,
        style = MaterialTheme.typography.bodyLarge,
        color = palette.foreground,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp)
    )
}

/** "I got interrupted while working on this." with Resume and Dismiss. */
@Composable
fun AidenBotInterruptedCard(
    blocked: AidenBotSessionBlock?,
    busy: Boolean,
    onResume: () -> Unit,
    onDismiss: () -> Unit,
    onOpenAdvanced: () -> Unit = {}
) {
    val palette = AidenTheme.palette
    Surface(color = palette.raised, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().testTag(AidenBotSessionTags.INTERRUPTED_CARD)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.bot_session_interrupted), style = MaterialTheme.typography.bodyLarge, color = palette.foreground)
            if (blocked == AidenBotSessionBlock.ACCESS_CHANGED) {
                Text(stringResource(R.string.bot_session_access_changed), style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (blocked == AidenBotSessionBlock.ACCESS_CHANGED) {
                    AidenPrimaryButton(text = stringResource(R.string.bot_advanced_title), enabled = !busy, onClick = onOpenAdvanced)
                } else {
                    AidenPrimaryButton(text = stringResource(R.string.bot_session_resume), enabled = !busy, onClick = onResume)
                }
                AidenTonalButton(text = stringResource(R.string.bot_session_dismiss), enabled = !busy, onClick = onDismiss)
            }
        }
    }
}

/** "I couldn't finish that reply." Retry shows only on the newest failed turn with text to resend. */
@Composable
fun AidenBotFailedTurnCard(canRetry: Boolean, onRetry: () -> Unit) {
    val palette = AidenTheme.palette
    Surface(color = palette.raised, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().testTag(AidenBotSessionTags.FAILED_TURN_CARD)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.bot_session_failed_turn), style = MaterialTheme.typography.bodyLarge, color = palette.foreground)
            if (canRetry) {
                AidenPrimaryButton(text = stringResource(R.string.action_retry), onClick = onRetry)
            }
        }
    }
}

/** Shown instead of sending while the Bot has no AI model; Set up opens Advanced. */
@Composable
fun AidenBotNeedsModelCard(busy: Boolean = false, onSetUp: () -> Unit = {}) {
    val palette = AidenTheme.palette
    Surface(color = palette.raised, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().testTag(AidenBotSessionTags.NEEDS_MODEL_CARD)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(36.dp).clip(AidenShape.Button).background(palette.warning.copy(alpha = 0.14f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Default.Memory, contentDescription = null, tint = palette.warning, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(12.dp))
            Text(
                stringResource(R.string.bot_session_needs_model),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = palette.foreground,
                modifier = Modifier.weight(1f)
            )
            Spacer(Modifier.width(12.dp))
            AidenPrimaryButton(text = stringResource(R.string.bot_session_set_up), enabled = !busy, onClick = onSetUp)
        }
    }
}

@Composable
fun AidenBotConnectCard(
    card: AidenBotSessionEntry.ConnectCard,
    canRequest: Boolean,
    phase: AidenBotConnectRequestPhase,
    onRequest: () -> Unit
) {
    if (card.status == AidenBotConnectCardStatus.DISMISSED) return
    val palette = AidenTheme.palette
    Surface(color = palette.raised, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AidenBotConnectionIcon(card.iconId, card.name)
                Spacer(Modifier.width(12.dp))
                Text(
                    stringResource(R.string.bot_session_connect_title, card.name),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground
                )
            }
            if (card.reason.isNotBlank()) {
                Text(card.reason, style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
            }
            when {
                card.status == AidenBotConnectCardStatus.CONNECTED ->
                    Text(stringResource(R.string.bot_session_connected), style = MaterialTheme.typography.labelLarge, color = palette.success)
                !canRequest ->
                    Text(stringResource(R.string.bot_session_finish_read_only), style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                phase == AidenBotConnectRequestPhase.SENT ->
                    AidenTonalButton(text = stringResource(R.string.bot_session_check_mac), enabled = false, onClick = {})
                else -> {
                    AidenPrimaryButton(
                        text = stringResource(R.string.bot_session_finish_on_mac),
                        enabled = phase != AidenBotConnectRequestPhase.SENDING,
                        onClick = onRequest
                    )
                    if (phase == AidenBotConnectRequestPhase.FAILED) {
                        Text(stringResource(R.string.bot_session_unreachable), style = MaterialTheme.typography.bodySmall, color = palette.danger)
                    }
                }
            }
        }
    }
}

/** A quiet centred "Memory updated" line; tapping it opens Profile → Memory when the Mac offers it. */
@Composable
fun AidenBotMemoryUpdatedCaption(onOpen: (() -> Unit)?) {
    val palette = AidenTheme.palette
    val label = stringResource(R.string.bot_memory_updated)
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        val content: @Composable () -> Unit = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
            ) {
                Icon(Icons.Outlined.SdStorage, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(label, style = MaterialTheme.typography.labelMedium, color = palette.secondary)
            }
        }
        if (onOpen != null) {
            Surface(
                onClick = onOpen,
                color = androidx.compose.ui.graphics.Color.Transparent,
                shape = AidenShape.Button,
                modifier = Modifier.heightIn(min = AidenUi.MinimumTouchTarget).testTag(AidenBotSessionTags.MEMORY_CAPTION)
            ) {
                Box(contentAlignment = Alignment.Center) { content() }
            }
        } else {
            Box(Modifier.testTag(AidenBotSessionTags.MEMORY_CAPTION)) { content() }
        }
    }
}

/**
 * "Add a routine?" — a routine the Bot suggested. Pending cards offer Add routine and Not now
 * when the Mac takes answers from phones; a settled card reads "Added ✓ · {label}" or "Not added".
 */
@Composable
fun AidenBotRoutineProposalCard(
    card: AidenBotSessionEntry.RoutineProposal,
    botName: String,
    canAnswer: Boolean,
    phase: AidenBotProposalPhase?,
    onAnswer: (AidenBotRoutineProposalDecision) -> Unit
) {
    val palette = AidenTheme.palette
    Surface(
        color = palette.raised,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().testTag(AidenBotSessionTags.PROPOSAL_CARD)
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(36.dp).clip(AidenShape.Button).background(MaterialTheme.colorScheme.surfaceContainerHigh),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Outlined.EventRepeat, contentDescription = null, tint = palette.foreground, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        stringResource(R.string.bot_proposal_title),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.foreground
                    )
                    Text(
                        stringResource(R.string.bot_proposal_subtitle, botName, card.label),
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary
                    )
                }
            }
            Text(
                card.prompt,
                style = MaterialTheme.typography.bodyMedium,
                color = palette.secondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            when (card.status) {
                AidenBotRoutineProposalStatus.ACCEPTED -> Text(
                    stringResource(R.string.bot_proposal_added, card.label),
                    style = MaterialTheme.typography.labelLarge,
                    color = palette.success
                )
                AidenBotRoutineProposalStatus.DISMISSED -> Text(
                    stringResource(R.string.bot_proposal_not_added),
                    style = MaterialTheme.typography.labelLarge,
                    color = palette.secondary
                )
                AidenBotRoutineProposalStatus.PENDING -> if (canAnswer) {
                    val busy = phase == AidenBotProposalPhase.SENDING
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AidenPrimaryButton(
                            text = stringResource(R.string.bot_proposal_add),
                            enabled = !busy,
                            onClick = { onAnswer(AidenBotRoutineProposalDecision.ACCEPT) }
                        )
                        AidenTonalButton(
                            text = stringResource(R.string.bot_proposal_not_now),
                            enabled = !busy,
                            onClick = { onAnswer(AidenBotRoutineProposalDecision.DISMISS) }
                        )
                    }
                    if (phase == AidenBotProposalPhase.FAILED) {
                        Text(stringResource(R.string.bot_proposal_failed), style = MaterialTheme.typography.bodySmall, color = palette.danger)
                    }
                }
            }
        }
    }
}

@Composable
private fun AidenBotSessionComposer(
    draft: String,
    onDraftChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    busy: Boolean,
    busyMode: AidenStreamInputMode,
    onPickBusyMode: (AidenStreamInputMode) -> Unit,
    onSend: () -> Unit
) {
    val palette = AidenTheme.palette
    Row(
        verticalAlignment = Alignment.Bottom,
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .testTag(AidenBotSessionTags.COMPOSER)
    ) {
        TextField(
            value = draft,
            onValueChange = onDraftChange,
            enabled = enabled,
            placeholder = { Text(placeholder) },
            colors = aidenTextFieldColors(),
            shape = RoundedCornerShape(AidenUi.ComposerRadius),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            maxLines = 6,
            modifier = Modifier.weight(1f)
        )
        Spacer(Modifier.width(8.dp))
        if (busy) {
            // While the Bot works: Steer joins the reply, Queue sends after it (desktop and iOS
            // parity). The menu opens with an empty draft too, so a mode can be picked first.
            AidenRunInputSplitButton(
                mode = busyMode,
                canSubmit = enabled && draft.isNotBlank(),
                canChooseMode = enabled,
                onSubmit = onSend,
                onPickMode = onPickBusyMode
            )
        } else {
            FilledIconButton(
                onClick = onSend,
                enabled = enabled && draft.isNotBlank(),
                shape = AidenShape.Button,
                colors = IconButtonDefaults.filledIconButtonColors(containerColor = palette.accent, contentColor = MaterialTheme.colorScheme.onPrimary),
                modifier = Modifier.size(AidenUi.MinimumTouchTarget)
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.bot_session_send))
            }
        }
    }
}
