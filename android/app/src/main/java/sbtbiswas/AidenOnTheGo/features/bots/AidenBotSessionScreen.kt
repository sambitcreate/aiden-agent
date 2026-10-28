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
import androidx.compose.material.icons.outlined.ErrorOutline
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
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.chat.AidenPowerSaveScope
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.chat.AidenQuestionCard
import sbtbiswas.AidenOnTheGo.features.chat.AidenSpendingNotice
import sbtbiswas.AidenOnTheGo.features.chat.AidenRunInputSplitButton
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.notifications.AidenScheduledRunNotifier
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonBlock
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenFilledIconButtonColors
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
    /** Revision 42: one "Needs you" card. */
    const val ISSUE_CARD = "bot_session_issue_card"
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
    // One battery-saver receiver for the chat's faces, marks and skeletons.
    AidenPowerSaveScope {
        AidenBotSessionContent(botId, coordinator, onNavigateBack, onNavigateToBotProfile, botDeleter, onBotDeleted, onNavigateToBotMemory)
    }
}

@Composable
private fun AidenBotSessionContent(
    botId: String,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    botDeleter: AidenBotDeleter?,
    onBotDeleted: () -> Unit,
    onNavigateToBotMemory: (String) -> Unit
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
    val activitySupportedNow = aidenBotActivitySupported(serverInfo, coordinator.cachedBotActivitySupported)
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
            activitySupported = activitySupportedNow,
            sessionKey = sessionKey,
            store = coordinator.botSessionStore
        )
    }
    DisposableEffect(controller) {
        controller.start()
        onDispose { controller.stopFollowing() }
    }
    // The Mac shapes the feed by the grants this phone holds when it opens (cards, Chat activity,
    // hand-offs and the paused state). This chat can open from the pairing's saved features while
    // it connects, before this connection has negotiated a grant (`bot:handoffs` after the Mac
    // updates); once `/server` has answered, every grant is negotiated and saved, and a feed that
    // opened without one opens again.
    val feedOpenedWith = remember(controller) { aidenBotSessionFeedGrants(coordinator.installationStore.activeInstallation) }
    val grantsSettled = serverInfo != null
    LaunchedEffect(controller, grantsSettled) {
        if (grantsSettled && aidenBotSessionFeedGrants(coordinator.installationStore.activeInstallation) != feedOpenedWith) {
            controller.reopenFeed()
        }
    }
    val ui by controller.state.collectAsStateWithLifecycle()
    // Revision 37 (G24): a hand-off that arrives while the app is in the background, with this
    // chat still open behind it, posts one local notification that opens the chat.
    val appContext = LocalContext.current.applicationContext
    val lifecycleOwner = LocalLifecycleOwner.current
    val handoffNotifier = remember(appContext) { AidenScheduledRunNotifier(appContext) }
    val botName by rememberUpdatedState(identity.name)
    DisposableEffect(controller, lifecycleOwner) {
        controller.onHandoffArrived = { handoff ->
            val instanceId = coordinator.activeInstanceId
            if (instanceId != null && !lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                handoffNotifier.postBotHandoff(instanceId, botId, botName, handoff)
            }
        }
        onDispose { controller.onHandoffArrived = null }
    }
    val activitySupported = activitySupportedNow
    LaunchedEffect(controller, activitySupported) { controller.setActivitySupported(activitySupported) }
    // The wording comes from the Bot's detail: cached first, then the Mac's. Only a Mac that
    // offers Chat activity now decides it, and the feed never waits for this read. Only this
    // Bot's detail is followed, so another Bot's save doesn't redraw the chat.
    val detailFlow = remember(botId) { coordinator.botCache.botDetails.map { it[botId] }.distinctUntilChanged() }
    val botDetail by detailFlow.collectAsStateWithLifecycle(coordinator.botCache.getBotDetail(botId))
    val chatActivity = aidenBotChatActivity(serverInfo, botDetail, coordinator.cachedBotActivitySupported)
    LaunchedEffect(controller, chatActivity) {
        controller.setWording(chatActivity?.wording ?: AidenBotChatActivityWording.FOLLOWS)
    }
    // One read of the Bot per visit; Advanced opens from it (or the cache) without another.
    LaunchedEffect(controller) {
        val pairing = coordinator.activePairing
        try {
            val fresh = cl.bot(botId)
            // A read that outlived its pairing never reaches another pairing's cache.
            if (coordinator.holdsReadAuthority(cl, pairing?.instanceId) && coordinator.holdsPairing(pairing)) {
                coordinator.botCache.putBotDetail(fresh)
            }
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
    // Revision 44: the Bot's month, re-read after each reply and send.
    val spending = remember(botId) { AidenSpendingNoticeState() }
    val spendingTransport = cl.takeIf { serverInfo?.supportsSpendingLimits == true }
    LaunchedEffect(botId, spendingTransport, ui.isRunning, ui.entries.size, ui.outgoing.size) {
        spending.refresh(AidenSpendingOwner.Bot(botId), spendingTransport)
    }
    var confirmingDelete by remember { mutableStateOf(false) }
    var isDeleting by remember { mutableStateOf(false) }
    // "Set up" (no AI model) and "Advanced" (access changed) open the Bot's Advanced settings.
    var advancedBot by remember { mutableStateOf<AidenBotDetail?>(null) }
    var openingAdvanced by remember { mutableStateOf(false) }
    // Advanced opens at once from the Bot this visit read (or the cache), never waiting on the
    // connection (R15). Only with nothing cached does it read the Bot first.
    fun openAdvanced() {
        botDetail?.let {
            advancedBot = it
            return
        }
        if (openingAdvanced) return
        openingAdvanced = true
        val pairing = coordinator.activePairing
        scope.launch {
            try {
                val detail = cl.bot(botId)
                if (!coordinator.holdsReadAuthority(cl, pairing?.instanceId) || !coordinator.holdsPairing(pairing)) return@launch
                coordinator.botCache.putBotDetail(detail)
                advancedBot = detail
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                coordinator.presentError(resources.getString(R.string.bot_session_unreachable))
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
    // Revision 42: issue cards come only from a Mac offering `bot:issues`; actions also need write.
    val canWriteBots = coordinator.installationStore.activeInstallation?.canWriteBots == true
    val listState = rememberLazyListState()
    // The Mac's transcript, or the cached one while connecting (R14).
    val entries = ui.entries
    val rows = remember(entries) { aidenBotSessionRows(entries) }
    val partial = ui.session?.partial
    val outgoing = ui.outgoing
    // Set by this person's own send, so their message scrolls into view even when they had scrolled up.
    var justSent by remember { mutableStateOf(false) }

    LaunchedEffect(
        entries.size, partial, ui.isInterrupted, ui.needsModel,
        ui.queued.size, outgoing.size, ui.session?.activity?.phase
    ) {
        val layout = listState.layoutInfo
        val count = layout.totalItemsCount
        val last = layout.visibleItemsInfo.lastOrNull()?.index ?: -1
        // Reading back stays put; only the end of the chat (or one's own send) follows new rows.
        if (count > 0 && aidenBotFollowsTranscriptEnd(last, count, justSent)) listState.animateScrollToItem(count - 1)
        justSent = false
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
        val saveHost = remember(cl) { coordinator.botSaveHost() }
        AidenBotAdvancedSheet(
            bot = bot,
            client = cl,
            onDismiss = { advancedBot = null },
            // Save applies at once (R15) and writes through the pinned cache, so a save that lands
            // after an unpair or re-pair never reaches the other pairing's cache.
            onSaved = {
                advancedBot = null
                scope.launch { controller.refetch() }
            },
            saveHost = saveHost,
            onSaveSettled = { scope.launch { controller.refetch() } },
            onSaveFailed = coordinator::presentError,
            chatActivityAvailable = aidenBotShowsChatActivity(serverInfo, hasBaseline = true, cachedSupport = coordinator.cachedBotActivitySupported),
            chatActivityHost = chatActivityHost,
            // The host has already cached the pick (pinned to its pairing); this only refreshes the chat.
            onChatActivitySaved = { saved ->
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
                // Revision 42 (`bot:issues`): the host's "Needs you" cards.
                items(ui.openIssues, key = { "issue-${it.id}" }) { issue ->
                    AidenBotIssueCard(
                        issue = issue,
                        canAct = canWriteBots,
                        busy = ui.isActingOn(issue),
                        onAct = { action -> scope.launch { controller.actOnIssue(issue, action) } }
                    )
                }
                item(key = "status") { AidenBotStatusLine(ui) }
                // Revision 37: a Bot the person paused. Resume lifts it; a reply it cut short then
                // shows the interrupted card below.
                spending.spending?.takeIf { !ui.isPaused }?.let { current ->
                    item(key = "spending") {
                        AidenSpendingNotice(
                            spending = current,
                            botName = identity.name,
                            isAllowing = spending.isAllowing,
                            canAllow = coordinator.installationStore.activeInstallation?.canWriteBots == true,
                            errorMessage = spending.errorMessage,
                            onAllowMore = { scope.launch { spending.allowMore(spendingTransport) } }
                        )
                    }
                }
                if (ui.isPaused) {
                    item(key = "paused") {
                        AidenBotPausedCard(
                            botName = identity.name,
                            busy = ui.isUnpausing,
                            canResume = aidenBotPausedChatOffersResume(
                                canWriteBots = coordinator.installationStore.activeInstallation?.canWriteBots == true,
                                ui = ui
                            ),
                            onResume = { scope.launch { controller.unpause() } }
                        )
                    }
                }
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
                ui.handoff?.let { handoff ->
                    item(key = "handoff-${handoff.waitId}") {
                        AidenBotHandoffCard(
                            handoff = handoff,
                            canAnswer = !ui.isAnsweringHandoff,
                            isFinishing = ui.isFinishingHandoffOnMac,
                            macOpened = ui.handoffMacPrompt?.takeIf { it.waitId == handoff.waitId }?.opened,
                            // Done without a note; the composer's Send is Done with one (iOS parity).
                            onDone = { scope.launch { controller.answerHandoff(AidenBotHandoffOutcome.DONE) } },
                            onSkip = { scope.launch { controller.answerHandoff(AidenBotHandoffOutcome.SKIPPED) } },
                            onFinishOnMac = { scope.launch { controller.finishHandoffOnMac() } }
                        )
                    }
                }
                if (ui.needsModel) {
                    item(key = "needs-model") { AidenBotNeedsModelCard(busy = openingAdvanced, onSetUp = ::openAdvanced) }
                }
                // A notice about unsent messages (copy shared with iOS), else the last action's error.
                (ui.notice?.let { resources.getString(it.text) } ?: ui.actionError)?.let { message ->
                    item(key = "error") {
                        Text(message, color = aidenBotErrorTextColor(), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            AidenBotConnectionHintRow(aidenBotConnectionHint(ui, System.currentTimeMillis()), onTryAgain = { scope.launch { controller.refetch() } })
            val composerMode = ui.composerMode
            AidenBotSessionComposer(
                draft = draft,
                onDraftChange = { draft = it.take(AidenBotSessionWire.MAX_MESSAGE_LENGTH) },
                placeholder = when (composerMode) {
                    AidenBotComposerMode.MESSAGE -> aidenBotChatPlaceholder(identity.name)
                    AidenBotComposerMode.HANDOFF_NOTE -> stringResource(R.string.bot_handoff_note_placeholder)
                    AidenBotComposerMode.HELD_FOR_SIGN_IN -> stringResource(R.string.bot_handoff_sign_in_placeholder)
                    AidenBotComposerMode.HELD_FOR_NO_NOTE -> stringResource(R.string.bot_handoff_no_note_placeholder)
                    AidenBotComposerMode.PAUSED -> stringResource(R.string.bot_paused_placeholder, identity.name)
                },
                enabled = ui.composerEnabled,
                // A hand-off note is one answer, never Steer or Queue.
                busy = ui.offersBusyModes && composerMode == AidenBotComposerMode.MESSAGE,
                busyMode = busyMode,
                onPickBusyMode = { busyMode = it },
                onSend = {
                    // The draft clears at once and the bubble shows (R14); a refused message comes back.
                    val text = draft
                    draft = ""
                    if (composerMode == AidenBotComposerMode.HANDOFF_NOTE) {
                        scope.launch {
                            if (!controller.answerHandoff(AidenBotHandoffOutcome.DONE, text) && draft.isEmpty()) draft = text
                        }
                    } else {
                        val mode = if (ui.offersBusyModes) busyMode else null
                        justSent = true
                        scope.launch {
                            if (!controller.send(text, mode) && draft.isEmpty()) draft = text
                        }
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
            val colors = aidenBotUserBubbleColors(MaterialTheme.colorScheme, palette.accentFill, faded = false)
            Surface(color = colors.container, shape = AidenBotUserBubbleShape, modifier = Modifier.widthIn(max = 320.dp)) {
                Text(
                    message.text,
                    style = MaterialTheme.typography.bodyLarge,
                    color = colors.content,
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
                        Text(stringResource(R.string.bot_session_unreachable), style = MaterialTheme.typography.bodySmall, color = aidenBotErrorTextColor())
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
                        Text(stringResource(R.string.bot_proposal_failed), style = MaterialTheme.typography.bodySmall, color = aidenBotErrorTextColor())
                    }
                }
            }
        }
    }
}

/**
 * Revision 42 (`bot:issues`): a "Needs you" card the host raised, with up to two actions. A card
 * that offers nothing a phone can do (the Mac's own settings opened it) says "Open on your Mac".
 */
@Composable
fun AidenBotIssueCard(
    issue: AidenBotIssue,
    canAct: Boolean,
    busy: Boolean,
    onAct: (AidenBotIssueAction) -> Unit
) {
    val palette = AidenTheme.palette
    Surface(
        color = palette.raised,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().testTag(AidenBotSessionTags.ISSUE_CARD)
    ) {
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier.size(36.dp).clip(AidenShape.Button).background(MaterialTheme.colorScheme.surfaceContainerHigh),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    Icons.Outlined.ErrorOutline,
                    contentDescription = null,
                    tint = palette.foreground,
                    modifier = Modifier.size(20.dp)
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    stringResource(R.string.bot_issue_needs_you),
                    style = MaterialTheme.typography.labelMedium,
                    color = palette.secondary
                )
                Text(
                    issue.title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground
                )
                if (issue.body.isNotEmpty()) {
                    Text(issue.body, style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                }
                when {
                    issue.actions.isEmpty() -> Text(
                        stringResource(R.string.bot_issue_open_on_mac),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.secondary
                    )
                    canAct -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        issue.actions.forEachIndexed { index, action ->
                            val primary = index == issue.actions.lastIndex
                            val text = aidenBotIssueActionLabel(action)
                            if (primary) {
                                AidenPrimaryButton(text = text, enabled = !busy, onClick = { onAct(action) })
                            } else {
                                AidenTonalButton(text = text, enabled = !busy, onClick = { onAct(action) })
                            }
                        }
                    }
                    else -> Text(
                        stringResource(R.string.bot_session_finish_on_mac),
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary
                    )
                }
            }
        }
    }
}

/** The label for one card action, shared with iOS. */
@Composable
fun aidenBotIssueActionLabel(action: AidenBotIssueAction): String = when (action.kind) {
    AidenBotIssueActionKind.OPEN_CHAT -> stringResource(R.string.bot_issue_open_chat)
    AidenBotIssueActionKind.RESUME_ROUTINE -> stringResource(R.string.bot_issue_resume_routine)
    AidenBotIssueActionKind.STOP_RUN -> stringResource(R.string.bot_issue_stop)
    AidenBotIssueActionKind.KEEP_WAITING -> stringResource(R.string.bot_issue_keep_waiting)
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
                colors = aidenFilledIconButtonColors(),
                modifier = Modifier.size(AidenUi.MinimumTouchTarget)
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.bot_session_send))
            }
        }
    }
}
