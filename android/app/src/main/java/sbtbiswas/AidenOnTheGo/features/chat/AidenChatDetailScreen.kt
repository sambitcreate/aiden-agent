package sbtbiswas.AidenOnTheGo.features.chat

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sbtbiswas.AidenOnTheGo.features.remote.AidenAttachmentPreparation
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs.OrbSize
import sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs.OrbState
import sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs.ThinkingOrb
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.notifications.AidenRemoteLiveNotificationManager
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import java.io.File
import kotlin.math.abs

enum class MessageClusterPosition {
    SINGLE, FIRST, MIDDLE, LAST
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenChatDetailScreen(
    chatId: String,
    coordinator: AidenRemoteCoordinator,
    chatCache: AidenChatCache,
    draftStore: AidenChatDraftStore,
    voiceInputStore: AidenVoiceInputStore,
    liveNotificationManager: AidenRemoteLiveNotificationManager? = null,
    startVoiceOnOpen: Boolean = false,
    onNavigateBack: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val haptics = LocalHapticFeedback.current
    val uriHandler = LocalUriHandler.current

    val viewModel: AidenChatViewModel = viewModel(
        key = "chat:${coordinator.activeInstanceId}:${coordinator.installationStore.activeInstallation?.deviceId}:$chatId",
        factory = AidenChatViewModel.factory(
            chatId,
            coordinator,
            chatCache,
            draftStore,
            liveNotificationManager
        )
    )

    val connectionState by coordinator.connectionState.collectAsState()
    val chat by viewModel.chat.collectAsState()
    var workspaceFileReference by remember(chatId) { mutableStateOf<String?>(null) }
    val streamState by viewModel.streamState.collectAsState()
    val hasActiveStream by viewModel.hasActiveStream.collectAsState()
    val isStreaming = streamState != null && !streamState!!.isTerminal
    val liveText by viewModel.liveText.collectAsState()
    val reasoning by viewModel.reasoning.collectAsState()
    val tools by viewModel.tools.collectAsState()
    val activityTimeline by viewModel.activityTimeline.collectAsState()
    val pendingApproval by viewModel.pendingApproval.collectAsState()
    val isStopping by viewModel.isStopping.collectAsState()
    val isRespondingToApproval by viewModel.isRespondingToApproval.collectAsState()
    val pendingAttachments by viewModel.pendingAttachments.collectAsState()
    val draft by viewModel.draft.collectAsState()
    val presentedError by viewModel.presentedError.collectAsState()
    val voiceInputMode by voiceInputStore.mode.collectAsState()
    val taskProgress by viewModel.taskProgress.collectAsState()
    val currentAgentRoster by viewModel.agentRoster.collectAsState()
    val selectedAgentRoster by viewModel.selectedAgentRoster.collectAsState()
    val agentRosterHistory by viewModel.agentRosterHistory.collectAsState()
    val progressConnectionState by viewModel.progressConnectionState.collectAsState()
    // The coordinator updates /server after grant negotiation, which drives the
    // progress capability gate and makes the controls appear without a reload.
    val serverInfo by coordinator.serverInfo.collectAsState()
    val canReadTaskProgress = viewModel.canReadTaskProgress
    val canReadAgentRoster = viewModel.canReadAgentRoster

    val listState = rememberSaveable(chatId, saver = LazyListState.Saver) { LazyListState() }
    var followLatest by remember(listState) {
        mutableStateOf(
            AidenChatScroll.isFollowingLatest(
                listState.firstVisibleItemIndex,
                listState.firstVisibleItemScrollOffset
            )
        )
    }
    var consumedItemCount by remember(listState) { mutableIntStateOf(-1) }

    val readAloudClient by coordinator.client.collectAsState()
    val readAloud = remember(readAloudClient, chatId) {
        AidenReadAloudPlayback(context.applicationContext, scope, readAloudClient, chatId) {
            readAloudClient != null && coordinator.client.value === readAloudClient
        }
    }
    val voiceInput = remember(context) { ComposerVoiceInputController(context.applicationContext) }
    val lifecycleOwner = LocalLifecycleOwner.current
    var pendingVoiceStart by remember { mutableStateOf(false) }
    var requestedNotificationPermission by rememberSaveable { mutableStateOf(false) }
    var progressSheet by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedAgent by remember { mutableStateOf<AidenChatAgent?>(null) }
    val currentDraft by rememberUpdatedState(draft)
    val currentVoiceMode by rememberUpdatedState(voiceInputMode)
    val currentChat by rememberUpdatedState(chat)
    val currentlyStreaming by rememberUpdatedState(isStreaming)

    LaunchedEffect(isStreaming, chat?.messages?.lastOrNull()?.id) {
        if (isStreaming || (readAloud.activeMessageId != null && readAloud.activeMessageId != chat?.messages?.lastOrNull()?.id)) readAloud.stop()
    }
    DisposableEffect(readAloud, lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) readAloud.stop() }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer); readAloud.stop() }
    }

    DisposableEffect(voiceInput, lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) voiceInput.cancelDiscardingRecording()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            voiceInput.destroy()
        }
    }

    DisposableEffect(lifecycleOwner, viewModel) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> viewModel.startProgressObservation()
                Lifecycle.Event.ON_STOP -> viewModel.stopProgressObservation()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            viewModel.startProgressObservation()
        }
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            viewModel.stopProgressObservation()
        }
    }

    LaunchedEffect(serverInfo) {
        viewModel.reconcileProgressAccess()
        if (progressSheet == "tasks" && !viewModel.canReadTaskProgress) progressSheet = null
        if (progressSheet == "agents" && !viewModel.canReadAgentRoster) progressSheet = null
        if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
            (viewModel.canReadTaskProgress || viewModel.canReadAgentRoster)
        ) {
            viewModel.startProgressObservation()
        }
    }

    fun dismissComposerKeyboard() {
        focusManager.clearFocus(force = true)
        keyboardController?.hide()
    }

    val preparePickedUris: (List<Uri>) -> Unit = { selectedUris ->
        val remainingCapacity = (10 - pendingAttachments.size).coerceAtLeast(0)
        val uris = selectedUris.take(remainingCapacity)
        if (uris.isNotEmpty()) {
            scope.launch {
                for (uri in uris) {
                    try {
                        val displayName = getFileName(context, uri) ?: "Attachment"
                        val isImage = context.contentResolver.getType(uri)?.startsWith("image/") == true ||
                            isImageExtension(displayName)
                        val limit = if (isImage) {
                            AidenAttachmentPreparation.MAXIMUM_SOURCE_IMAGE_BYTES
                        } else {
                            AidenAttachmentPreparation.MAXIMUM_TEXT_BYTES
                        }
                        val bytes = readContentUriBounded(context, uri, limit) ?: continue
                        val upload = if (isImage) {
                            AidenAttachmentPreparation.imageUpload(bytes, displayName)
                        } else {
                            val mime = context.contentResolver.getType(uri) ?: "text/plain"
                            AidenAttachmentPreparation.textUpload(bytes, displayName, mime)
                        }
                        viewModel.upload(listOf(upload))
                    } catch (_: Exception) {
                        // A provider can return stale or misleading MIME metadata. Keep
                        // successfully prepared selections and skip only the invalid URI.
                    }
                }
            }
        }
    }

    fun startVoiceInput() {
        readAloud.stop()
        voiceInput.start(
            mode = currentVoiceMode,
            currentDraft = currentDraft,
            client = coordinator.client.value,
            updateDraft = viewModel::updateDraft
        )
    }

    val microphonePermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (pendingVoiceStart) {
            pendingVoiceStart = false
            if (granted) startVoiceInput() else voiceInput.reportPermissionDenied()
        }
    }

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
        onResult = { }
    )

    LaunchedEffect(isStreaming) {
        if (
            isStreaming &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !requestedNotificationPermission &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestedNotificationPermission = true
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    LaunchedEffect(startVoiceOnOpen) {
        if (!startVoiceOnOpen || voiceInput.isListening || voiceInput.isBusy) return@LaunchedEffect
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startVoiceInput()
        } else {
            pendingVoiceStart = true
            microphonePermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    val imagePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickMultipleVisualMedia(10),
        onResult = preparePickedUris
    )

    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenMultipleDocuments(),
        onResult = preparePickedUris
    )

    LaunchedEffect(listState) {
        var lastItemCount = -1
        var wasScrolling = false
        snapshotFlow {
            val itemCount = AidenChatScroll.reverseLayoutItemCount(
                currentChat?.messages?.size ?: 0,
                currentlyStreaming
            )
            Triple(
                listState.isScrollInProgress,
                listState.firstVisibleItemIndex,
                listState.firstVisibleItemScrollOffset
            ) to itemCount
        }.collect { (viewport, itemCount) ->
            val (scrolling, index, offset) = viewport
            val contentChanged = lastItemCount >= 0 && itemCount != lastItemCount
            lastItemCount = itemCount
            if (!AidenChatScroll.shouldUpdateFollowLatchFromViewport(
                    contentChanged,
                    itemCount,
                    consumedItemCount
                )
            ) {
                return@collect
            }
            if (scrolling) {
                wasScrolling = true
                followLatest = AidenChatScroll.isFollowingLatest(index, offset)
            } else if (wasScrolling) {
                wasScrolling = false
                followLatest = AidenChatScroll.isFollowingLatest(index, offset)
            }
        }
    }

    // Keyed by listState too: a chat switch with an equal item count must still
    // consume the new list's insertion epoch.
    LaunchedEffect(listState, chat?.messages?.size, isStreaming) {
        val itemCount = AidenChatScroll.reverseLayoutItemCount(
            chat?.messages?.size ?: 0,
            isStreaming
        )
        if (AidenChatScroll.shouldPinLatestAfterContentChange(followLatest)) {
            listState.scrollToItem(AidenChatScroll.latestItemIndex())
            followLatest = true
        }
        consumedItemCount = itemCount
    }

    workspaceFileReference?.let { reference ->
        val workspaceId = chat?.workspaceId
        if (workspaceId != null && chat?.isBotChat != true) {
            androidx.compose.ui.window.Dialog(onDismissRequest = { workspaceFileReference = null },
                properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
                sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceEnvironmentScreen(
                    workspaceId, coordinator, onNavigateBack = { workspaceFileReference = null }, initialReference = reference)
            }
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets.statusBars,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = chat?.title?.ifEmpty { "Chat" } ?: "Chat",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            maxLines = 1
                        )
                        chat?.modelId?.let { model ->
                            Text(
                                text = model,
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.secondary,
                                maxLines = 1
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = palette.foreground)
                    }
                },
                actions = {
                    if (isStreaming) {
                        IconButton(
                            onClick = { viewModel.cancelTurn() },
                            enabled = viewModel.canControlCurrentRun && !isStopping
                        ) {
                            Icon(Icons.Default.Stop, contentDescription = "Stop", tint = palette.danger)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = palette.canvas,
                    titleContentColor = palette.foreground
                )
            )
        },
        bottomBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .windowInsetsPadding(WindowInsets.navigationBars)
                    // MainActivity uses adjustNothing, so this is the one IME owner.
                    // Insets consumption contributes only the IME delta beyond the
                    // navigation bar and keeps the whole composer above the keyboard.
                    .imePadding()
                    .zIndex(1f)
            ) {
                // Pending Approval Banner
                AnimatedVisibility(
                    visible = pendingApproval != null,
                    enter = expandVertically() + fadeIn(),
                    exit = shrinkVertically() + fadeOut()
                ) {
                    pendingApproval?.let { approval ->
                        val isAutomation = AidenApprovalPresentation.isAutomation(approval.toolName)
                        val requiresDesktopConfirmation = AidenApprovalPresentation.requiresDesktopConfirmation(approval)
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 6.dp)
                                .shadow(elevation = 8.dp, shape = RoundedCornerShape(16.dp)),
                            colors = CardDefaults.cardColors(containerColor = palette.raised),
                            shape = RoundedCornerShape(16.dp)
                        ) {
                            Column(modifier = Modifier.padding(14.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        if (isAutomation) Icons.Default.Schedule else Icons.Default.Warning,
                                        contentDescription = null,
                                        tint = palette.warning,
                                        modifier = Modifier.size(18.dp)
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(
                                        text = AidenApprovalPresentation.title(approval.toolName),
                                        style = MaterialTheme.typography.titleSmall,
                                        fontWeight = FontWeight.Bold,
                                        color = palette.warning
                                    )
                                }
                                Spacer(modifier = Modifier.height(6.dp))
                                Text(
                                    text = AidenApprovalPresentation.oneLineSummary(approval.summary),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = palette.foreground
                                )
                                if (!approval.canRespond) {
                                    Spacer(modifier = Modifier.height(8.dp))
                                    Text(
                                        text = "This paired device can review approvals but cannot respond.",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = palette.secondary
                                    )
                                } else if (isAutomation && !approval.hasRequiredWriteCapability) {
                                    Spacer(modifier = Modifier.height(8.dp))
                                    Text(
                                        text = "Schedule write access is required to approve this task.",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = palette.secondary
                                    )
                                } else if (requiresDesktopConfirmation) {
                                    Spacer(modifier = Modifier.height(8.dp))
                                    Text(
                                        text = "Review the full unattended access scope and confirm in Aiden on your paired desktop. You can deny it here.",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = palette.secondary
                                    )
                                }
                                if (approval.canRespond) {
                                    Spacer(modifier = Modifier.height(10.dp))
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.End
                                    ) {
                                        Button(
                                            onClick = { viewModel.respondToApproval(AidenApprovalDecision.DENY, approval.id) },
                                            enabled = connectionState == AidenConnectionState.CONNECTED && !isRespondingToApproval && !isStopping,
                                            shape = RoundedCornerShape(10.dp)
                                        ) {
                                            Text(if (isAutomation) "Cancel" else "Deny", fontWeight = FontWeight.SemiBold)
                                        }
                                        if (approval.canAllow) {
                                            Spacer(modifier = Modifier.width(10.dp))
                                            Button(
                                                onClick = { viewModel.respondToApproval(AidenApprovalDecision.ALLOW, approval.id) },
                                                enabled = connectionState == AidenConnectionState.CONNECTED && !isRespondingToApproval && !isStopping,
                                                colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                                                shape = RoundedCornerShape(10.dp)
                                            ) {
                                                Text(if (isAutomation) "Approve task" else "Allow once", color = Color.White, fontWeight = FontWeight.Bold)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Error Banner
                AnimatedVisibility(
                    visible = presentedError != null || readAloud.error != null,
                    enter = expandVertically() + fadeIn(),
                    exit = shrinkVertically() + fadeOut()
                ) {
                    (presentedError ?: readAloud.error)?.let { err ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 4.dp),
                            colors = CardDefaults.cardColors(containerColor = palette.danger.copy(alpha = 0.12f)),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(10.dp)
                            ) {
                                Icon(Icons.Default.ErrorOutline, contentDescription = null, tint = palette.danger, modifier = Modifier.size(16.dp))
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(text = err, style = MaterialTheme.typography.bodySmall, color = palette.danger)
                            }
                        }
                    }
                }

                if (canReadTaskProgress || canReadAgentRoster) {
                    AidenChatProgressControls(
                        taskProgress = taskProgress.takeIf { canReadTaskProgress },
                        currentRoster = currentAgentRoster.takeIf { canReadAgentRoster },
                        rosterHistory = if (canReadAgentRoster) agentRosterHistory else emptyList(),
                        connectionState = progressConnectionState,
                        onTasksClick = { progressSheet = "tasks" },
                        onAgentsClick = { progressSheet = "agents" },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 4.dp)
                    )
                }

                // 1:1 Parity iOS Glass Composer
                AidenComposerView(
                    draft = draft,
                    onDraftChange = { viewModel.updateDraft(it) },
                    onSend = {
                        voiceInput.stopBeforeSubmittingDraft()
                        viewModel.send()
                    },
                    onStop = { viewModel.cancelTurn() },
                    canStop = viewModel.canControlCurrentRun && !isStopping,
                    canSend = viewModel.canSend && !hasActiveStream,
                    isStreaming = isStreaming,
                    isVoiceListening = voiceInput.isListening,
                    isVoiceBusy = voiceInput.isBusy,
                    onToggleVoice = {
                        dismissComposerKeyboard()
                        if (voiceInput.isListening) {
                            voiceInput.stopKeepingTranscript()
                        } else if (!voiceInput.isBusy) {
                            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                                startVoiceInput()
                            } else {
                                pendingVoiceStart = true
                                microphonePermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        }
                    },
                    pendingAttachments = pendingAttachments.map {
                        if (it.kind == AidenAttachmentKind.IMAGE) {
                            AidenAttachmentUpload.Image(name = it.name, mimeType = it.mimeType, data = "")
                        } else {
                            AidenAttachmentUpload.Text(name = it.name, mimeType = it.mimeType, text = "")
                        }
                    },
                    onRemoveAttachment = { att ->
                        val target = pendingAttachments.firstOrNull { it.name == att.name }
                        if (target != null) viewModel.removePendingAttachment(target.id)
                    },
                    onAddImage = {
                        dismissComposerKeyboard()
                        imagePickerLauncher.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                    },
                    onAddFile = {
                        dismissComposerKeyboard()
                        filePickerLauncher.launch(
                            arrayOf(
                                "image/*",
                                "text/*",
                                "application/json",
                                "application/xml",
                                "application/yaml",
                                "application/javascript"
                            )
                        )
                    },
                    selectedProvider = null,
                    selectedModel = null,
                    selectedThinkingLevel = null,
                    availableProviders = emptyList(),
                    onSelectModel = null,
                    placeholder = if (chat?.isBotChat == true) "Message ${chat?.title ?: "Bot"}" else "Message Aiden",
                    isReadOnly = false,
                    voiceErrorMessage = voiceInput.errorMessage,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        containerColor = palette.canvas
    ) { padding ->
        val rawMessages = chat?.messages ?: emptyList()
        val isBotChat = chat?.isBotChat == true

        Box(
            modifier = Modifier
                .fillMaxSize()
                // Keep the transcript beneath the floating composer. The list's
                // own bottom inset still makes the latest message fully reachable.
                .padding(top = padding.calculateTopPadding())
        ) {
            LazyColumn(
                reverseLayout = true,
                state = listState,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(
                    top = 16.dp,
                    bottom = padding.calculateBottomPadding() + 12.dp
                )
            ) {
                // When streaming, active generation is the latest item (index 0 in reverse layout)
                if (isStreaming) {
                    item(key = "live_stream") {
                        ActiveStreamingCard(
                            liveText = liveText,
                            reasoning = reasoning,
                            tools = tools,
                            activityTimeline = activityTimeline,
                            isBotChat = isBotChat,
                            palette = palette
                        )
                    }
                }

                val reversedMessages = rawMessages.asReversed()
                itemsIndexed(
                    items = reversedMessages,
                    key = { _, msg -> msg.id }
                ) { index, message ->
                    val pos = calculateClusterPosition(index, reversedMessages)
                    val isLastInCluster = pos == MessageClusterPosition.LAST || pos == MessageClusterPosition.SINGLE

                    if (message.role == AidenChatRole.USER) {
                        UserMessageRow(
                            message = message,
                            position = pos,
                            palette = palette,
                            loadAttachmentImage = viewModel::attachmentImageData,
                            onCopy = { text -> copyToClipboard(context, text) },
                            onShare = { text -> shareText(context, text) },
                            onReply = { text -> viewModel.updateDraft("> $text\n") }
                        )
                    } else {
                        AssistantMessageRow(
                            message = message,
                            position = pos,
                            isLastInCluster = isLastInCluster,
                            isBotChat = isBotChat,
                            palette = palette,
                            loadAttachmentImage = viewModel::attachmentImageData,
                            onCopy = { text -> copyToClipboard(context, text) },
                            onShare = { text -> shareText(context, text) },
                            onReply = { text -> viewModel.updateDraft("> $text\n") },
                            onReadAloud = if (!isStreaming && serverInfo?.features?.contains("tts-v1") == true &&
                                chat?.messages?.lastOrNull()?.id == message.id && message.isReadAloudEligible) {
                                { voiceInput.cancelDiscardingRecording(); readAloud.toggle(message.id) }
                            } else null,
                            readAloudActive = readAloud.activeMessageId == message.id,
                            onOpenUrl = { url ->
                                if (!isBotChat && AidenWorkspaceFileLink.path(url) != null) workspaceFileReference = url
                                else if (android.net.Uri.parse(url).scheme?.lowercase() in listOf("https", "http", "mailto")) {
                                    try { uriHandler.openUri(url) } catch (_: Exception) {}
                                }
                            }
                        )
                    }
                }
            }

            // Jump to Bottom Floating Capsule Button
            AidenJumpToBottom(
                visible = !followLatest,
                onClick = {
                    followLatest = true
                    scope.launch {
                        listState.scrollToItem(AidenChatScroll.latestItemIndex())
                        followLatest = true
                    }
                },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = padding.calculateBottomPadding() + 8.dp)
            )
        }
    }

    when (progressSheet) {
        "tasks" -> taskProgress
            ?.takeIf { canReadTaskProgress && it.availability == AidenChatProgressAvailability.READY }
            ?.let { progress ->
                AidenTaskProgressSheet(progress = progress, onDismiss = { progressSheet = null })
            }
        "agents" -> {
            // The sheet stays reachable for an unavailable current roster so
            // retained earlier turns remain inspectable, and for retained
            // history when no current roster was ever accepted.
            val selected = selectedAgentRoster ?: currentAgentRoster
                ?: agentRosterHistory.firstOrNull()
            if (canReadAgentRoster && selected != null) {
                AidenAgentRosterSheet(
                    currentRoster = currentAgentRoster ?: selected,
                    selectedRoster = selected,
                    history = agentRosterHistory,
                    onSelectTurn = { turnId ->
                        viewModel.selectAgentRosterTurn(turnId)
                    },
                    onAgentClick = { agent -> selectedAgent = agent },
                    onDismiss = { progressSheet = null }
                )
            }
        }
    }
    selectedAgent?.let { agent ->
        AidenAgentDetailSheet(agent = agent, onDismiss = { selectedAgent = null })
    }
}

private fun calculateClusterPosition(
    index: Int,
    messages: List<AidenChatMessage>
): MessageClusterPosition {
    val prevMsg = messages.getOrNull(index - 1)
    val nextMsg = messages.getOrNull(index + 1)
    val currRole = messages[index].role

    val isSameAsPrev = prevMsg?.role == currRole
    val isSameAsNext = nextMsg?.role == currRole

    return when {
        !isSameAsPrev && !isSameAsNext -> MessageClusterPosition.SINGLE
        !isSameAsPrev && isSameAsNext -> MessageClusterPosition.LAST
        isSameAsPrev && isSameAsNext -> MessageClusterPosition.MIDDLE
        else -> MessageClusterPosition.FIRST
    }
}

@Composable
private fun UserMessageRow(
    message: AidenChatMessage,
    position: MessageClusterPosition,
    palette: sbtbiswas.AidenOnTheGo.config.AidenPalette,
    loadAttachmentImage: suspend (AidenMessageAttachment) -> ByteArray?,
    onCopy: (String) -> Unit,
    onShare: (String) -> Unit,
    onReply: (String) -> Unit
) {
    val shape = when (position) {
        MessageClusterPosition.SINGLE -> RoundedCornerShape(20.dp, 20.dp, 4.dp, 20.dp)
        MessageClusterPosition.FIRST -> RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp)
        MessageClusterPosition.MIDDLE -> RoundedCornerShape(20.dp, 6.dp, 6.dp, 20.dp)
        MessageClusterPosition.LAST -> RoundedCornerShape(20.dp, 6.dp, 20.dp, 20.dp)
    }

    val attachments = message.attachments.orEmpty()
    val imageAttachments = aidenEligibleImageAttachments(attachments)
    val imageIds = imageAttachments.mapTo(mutableSetOf()) { it.id }
    val fallbackAttachments = attachments.filterNot { it.id in imageIds }

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        if (message.text.isNotEmpty() || fallbackAttachments.isNotEmpty()) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                AidenMessageActionContainer(
                    onCopy = { onCopy(message.text) },
                    onShare = { onShare(message.text) },
                    onReply = { onReply(message.text) }
                ) {
                    Surface(
                        color = palette.accent,
                        shape = shape,
                        modifier = Modifier.widthIn(max = 320.dp)
                    ) {
                        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                            if (message.text.isNotEmpty()) {
                                Text(
                                    text = message.text,
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = Color.White
                                )
                            }
                            fallbackAttachments.forEach { att ->
                                if (message.text.isNotEmpty()) Spacer(modifier = Modifier.height(6.dp))
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        Icons.Default.Attachment,
                                        contentDescription = null,
                                        tint = Color.White,
                                        modifier = Modifier.size(14.dp)
                                    )
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text(
                                        text = att.name,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = Color.White,
                                        maxLines = 1
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        if (imageAttachments.isNotEmpty()) {
            AidenMessageImageAttachments(
                attachments = imageAttachments,
                edge = AidenMessageMediaEdge.TRAILING,
                loadData = loadAttachmentImage
            )
        }
    }
}

@Composable
private fun AssistantMessageRow(
    message: AidenChatMessage,
    position: MessageClusterPosition,
    isLastInCluster: Boolean,
    isBotChat: Boolean,
    palette: sbtbiswas.AidenOnTheGo.config.AidenPalette,
    loadAttachmentImage: suspend (AidenMessageAttachment) -> ByteArray?,
    onCopy: (String) -> Unit,
    onShare: (String) -> Unit,
    onReply: (String) -> Unit,
    onReadAloud: (() -> Unit)? = null,
    readAloudActive: Boolean = false,
    onOpenUrl: (String) -> Unit
) {
    val projection = if (isBotChat) {
        AidenBotReplyProjection.resolve(message.text, message.timeline, isActive = false)
    } else null

    val displayText = projection?.finalText ?: message.text
    val chronologicalRows = if (isBotChat) null else
        AidenChronologicalProjection.rows(message.text, message.reasoning.orEmpty(), message.timeline)
    val progressText = projection?.progressText ?: ""
    val attachments = message.attachments.orEmpty()
    val imageAttachments = aidenEligibleImageAttachments(attachments)
    val imageIds = imageAttachments.mapTo(mutableSetOf()) { it.id }
    val fallbackAttachments = attachments.filterNot { it.id in imageIds }

    Column(modifier = Modifier.fillMaxWidth()) {
        if (chronologicalRows != null) {
            AidenMessageActionContainer(
                onCopy = { onCopy(displayText) },
                onShare = { onShare(displayText) },
                onReply = { onReply(displayText) }
            ) {
                AidenChronologicalTranscript(
                    rows = chronologicalRows,
                    active = false,
                    palette = palette,
                    onCopy = onCopy,
                    onOpenUrl = onOpenUrl
                )
            }
        } else {
        if (!message.reasoning.isNullOrEmpty()) {
            AidenChronologicalReasoningCard(
                row = AidenChronologicalRow("legacy-reasoning-${message.id}",
                    AidenChronologicalRow.Kind.REASONING, message.reasoning),
                active = false,
                palette = palette
            )
            Spacer(modifier = Modifier.height(4.dp))
        }
        // Step Timeline items if present
        message.timeline?.let { timeline ->
            if (timeline.steps.isNotEmpty()) {
                AidenTimelineCollapsibleCard(timeline = timeline, palette = palette)
                Spacer(modifier = Modifier.height(4.dp))
            }
        }

        // Progress disclosure for bot chats
        if (progressText.isNotEmpty()) {
            var showProgress by remember { mutableStateOf(false) }
            Text(
                text = if (showProgress) "Hide progress" else "Show progress",
                style = MaterialTheme.typography.labelSmall,
                color = palette.accent,
                modifier = Modifier
                    .clickable { showProgress = !showProgress }
                    .padding(vertical = 2.dp)
            )
            if (showProgress) {
                Surface(
                    color = palette.raised.copy(alpha = 0.5f),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp)
                ) {
                    Text(
                        text = progressText,
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary,
                        modifier = Modifier.padding(8.dp)
                    )
                }
            }
        }

        // Assistant output reads as editorial content; only user messages are bubbled.
        if (displayText.isNotEmpty()) {
            AidenMessageActionContainer(
                onCopy = { onCopy(displayText) },
                onShare = { onShare(displayText) },
                onReply = { onReply(displayText) }
            ) {
                Surface(
                    color = Color.Transparent,
                    shape = RoundedCornerShape(0.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(horizontal = 2.dp, vertical = 8.dp)) {
                        RichFormattedMessage(
                            text = displayText,
                            palette = palette,
                            onCopy = onCopy,
                            onOpenUrl = onOpenUrl
                        )
                    }
                }
            }
        }
        }
        if (imageAttachments.isNotEmpty()) {
            Spacer(modifier = Modifier.height(10.dp))
            AidenMessageImageAttachments(
                attachments = imageAttachments,
                edge = AidenMessageMediaEdge.LEADING,
                loadData = loadAttachmentImage
            )
        }
        fallbackAttachments.forEach { attachment ->
            Spacer(modifier = Modifier.height(8.dp))
            Surface(
                color = palette.raised,
                shape = RoundedCornerShape(14.dp)
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp)
                ) {
                    Icon(
                        Icons.Default.Attachment,
                        contentDescription = null,
                        tint = palette.secondary,
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = attachment.name,
                        style = MaterialTheme.typography.labelMedium,
                        color = palette.foreground,
                        maxLines = 1
                    )
                }
            }
        }
        message.htmlArtifacts.orEmpty().forEach { artifact ->
            Spacer(modifier = Modifier.height(8.dp))
            Surface(
                color = palette.raised,
                shape = RoundedCornerShape(14.dp)
            ) {
                Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                    Text(
                        text = artifact.title,
                        style = MaterialTheme.typography.labelLarge,
                        color = palette.foreground,
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Can't view on this device. View in Aiden Agent.",
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary,
                    )
                }
            }
        }
        if (onReadAloud != null) {
            Row {
                IconButton(onClick = { onCopy(displayText) }) {
                    Icon(Icons.Default.ContentCopy, contentDescription = "Copy response", tint = palette.secondary)
                }
                IconButton(onClick = onReadAloud) {
                    Icon(if (readAloudActive) Icons.Default.Stop else Icons.Default.VolumeUp,
                        contentDescription = if (readAloudActive) "Stop reading aloud" else "Read response aloud",
                        tint = palette.secondary)
                }
            }
        }

    }
}

@Composable
private fun ActiveStreamingCard(
    liveText: String,
    reasoning: String,
    tools: List<AidenLiveTool>,
    activityTimeline: AidenGenerationTimeline?,
    isBotChat: Boolean,
    palette: sbtbiswas.AidenOnTheGo.config.AidenPalette
) {
    val reasoningActive = reasoning.isNotEmpty() && (
        AidenAgentActivityPresentation.hasActiveThinkingStep(activityTimeline) ||
            (activityTimeline == null && liveText.isEmpty())
        )
    val visualizingLabel = AidenAgentActivityPresentation.visualizingLabel(activityTimeline)
    val chronologicalRows = if (isBotChat) null else
        AidenChronologicalProjection.rows(liveText, reasoning, activityTimeline)

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier
            .fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            if (chronologicalRows != null) {
                AidenChronologicalTranscript(
                    rows = chronologicalRows,
                    active = true,
                    palette = palette,
                    onCopy = {},
                    onOpenUrl = {}
                )
                if (visualizingLabel != null && chronologicalRows.none { row ->
                    row.kind == AidenChronologicalRow.Kind.TOOL &&
                        row.steps.any { it.toolName == "render_artifact" && it.isActive }
                }) {
                    Spacer(modifier = Modifier.height(8.dp))
                    AidenActivityShimmerLabel(
                        label = visualizingLabel,
                        active = true,
                        style = MaterialTheme.typography.labelMedium,
                        color = palette.secondary
                    )
                }
            } else {
            // Reasoning
            if (reasoning.isNotEmpty()) {
                AidenActivityShimmerLabel(
                    label = AidenAgentActivityPresentation.reasoningLabel(
                        activityTimeline,
                        active = reasoningActive
                    ),
                    active = reasoningActive,
                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = palette.secondary
                )
                Spacer(modifier = Modifier.height(6.dp))
                Surface(
                    color = palette.canvas.copy(alpha = 0.7f),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = reasoning,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = palette.secondary,
                        modifier = Modifier.padding(10.dp)
                    )
                }
                Spacer(modifier = Modifier.height(10.dp))
            }

            // Live Tools
            if (tools.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (tool in tools) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ThinkingOrb(state = OrbState.WORKING, size = OrbSize.PX16)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = tool.name,
                                style = MaterialTheme.typography.bodySmall,
                                fontWeight = FontWeight.Medium,
                                color = palette.foreground
                            )
                        }
                    }
                }
                Spacer(modifier = Modifier.height(8.dp))
            }

            if (visualizingLabel != null) {
                Surface(
                    color = palette.raised,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    AidenActivityShimmerLabel(
                        label = visualizingLabel,
                        active = true,
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = palette.secondary,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))
            }

            // Live streaming text with blinking cursor
            if (liveText.isNotEmpty()) {
                val projection = if (isBotChat) {
                    AidenBotReplyProjection.resolve(liveText, activityTimeline, isActive = true)
                } else null

                val textToShow = projection?.progressText?.ifEmpty { liveText } ?: liveText

                Row(verticalAlignment = Alignment.Bottom) {
                    Text(
                        text = textToShow,
                        style = MaterialTheme.typography.bodyLarge,
                        color = palette.foreground,
                        modifier = Modifier.weight(1f, fill = false)
                    )
                    AidenStreamingCursor(palette = palette)
                }
            } else if (reasoning.isEmpty() && tools.isEmpty() && visualizingLabel == null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ThinkingOrb(state = OrbState.WORKING, size = OrbSize.PX24)
                    Spacer(modifier = Modifier.width(10.dp))
                    Text(
                        text = "Aiden is working...",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        color = palette.secondary
                    )
                }
            }
            }
        }
    }
}

@Composable
private fun AidenChronologicalTranscript(
    rows: List<AidenChronologicalRow>,
    active: Boolean,
    palette: sbtbiswas.AidenOnTheGo.config.AidenPalette,
    onCopy: (String) -> Unit,
    onOpenUrl: (String) -> Unit
) {
    val lastTextId = rows.lastOrNull { it.kind == AidenChronologicalRow.Kind.TEXT }?.id
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rows.forEach { row ->
            key(row.id) {
                when (row.kind) {
                    AidenChronologicalRow.Kind.TEXT -> {
                        if (active) {
                            Row(verticalAlignment = Alignment.Bottom) {
                                Text(
                                    text = row.text,
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = palette.foreground,
                                    modifier = Modifier.weight(1f, fill = false)
                                )
                                if (row.id == lastTextId) AidenStreamingCursor(palette = palette)
                            }
                        } else {
                            RichFormattedMessage(row.text, palette, onCopy, onOpenUrl)
                        }
                    }
                    AidenChronologicalRow.Kind.REASONING -> {
                        val step = row.steps.firstOrNull()
                        AidenChronologicalReasoningCard(
                            row = row,
                            active = active && step?.finishedAt == null,
                            palette = palette
                        )
                    }
                    AidenChronologicalRow.Kind.TOOL -> {
                        Surface(color = palette.raised, shape = RoundedCornerShape(12.dp)) {
                            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                                row.steps.forEach { step ->
                                    AidenActivityShimmerLabel(
                                        label = AidenAgentActivityPresentation.line(step),
                                        active = active && step.isActive,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = palette.secondary
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AidenChronologicalReasoningCard(
    row: AidenChronologicalRow,
    active: Boolean,
    palette: sbtbiswas.AidenOnTheGo.config.AidenPalette
) {
    if (row.text.isBlank()) {
        Surface(color = palette.raised, shape = RoundedCornerShape(12.dp)) {
            AidenActivityShimmerLabel(
                label = row.steps.firstOrNull()?.let(AidenAgentActivityPresentation::line) ?: "Thinking",
                active = active,
                style = MaterialTheme.typography.labelMedium,
                color = palette.secondary,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
            )
        }
        return
    }
    var expanded by rememberSaveable(row.id) { mutableStateOf(active) }
    var userControlled by rememberSaveable(row.id) { mutableStateOf(false) }
    LaunchedEffect(row.id, active) {
        if (active && !userControlled) {
            kotlinx.coroutines.delay(1_000)
            if (!userControlled) expanded = false
        }
    }
    Surface(color = palette.raised, shape = RoundedCornerShape(12.dp)) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().clickable {
                    userControlled = true
                    expanded = !expanded
                }
            ) {
                AidenActivityShimmerLabel(
                    label = if (active) "Thinking" else row.steps.firstOrNull()?.let(AidenAgentActivityPresentation::line) ?: "Thought",
                    active = active,
                    style = MaterialTheme.typography.labelMedium,
                    color = palette.secondary,
                    modifier = Modifier.weight(1f)
                )
                Icon(
                    imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = if (expanded) "Collapse reasoning" else "Expand reasoning",
                    tint = palette.secondary
                )
            }
            if (expanded) {
                Text(
                    text = row.text,
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary,
                    modifier = Modifier.heightIn(max = 144.dp).verticalScroll(rememberScrollState()).padding(top = 6.dp)
                )
            }
        }
    }
}

@Composable
private fun AidenActivityShimmerLabel(
    label: String,
    active: Boolean,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier
) {
    if (active && !AidenTheme.config.reduceMotion) {
        val transition = rememberInfiniteTransition(label = "ActivityLabelShimmer")
        val offset by transition.animateFloat(
            initialValue = -220f,
            targetValue = 620f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 1_800, easing = LinearEasing),
                repeatMode = RepeatMode.Restart
            ),
            label = "ActivityLabelShimmerOffset"
        )
        Text(
            text = label,
            style = style.copy(
                brush = Brush.linearGradient(
                    colors = listOf(color, color.copy(alpha = 0.35f), color),
                    start = Offset(offset, 0f),
                    end = Offset(offset + 180f, 0f)
                )
            ),
            modifier = modifier
        )
    } else {
        Text(text = label, style = style, color = color, modifier = modifier)
    }
}

@Composable
private fun AidenTimelineCollapsibleCard(
    timeline: AidenGenerationTimeline,
    palette: sbtbiswas.AidenOnTheGo.config.AidenPalette
) {
    var isExpanded by rememberSaveable { mutableStateOf(false) }
    val compactOnly = AidenAgentActivityPresentation.isCompactContextOnly(timeline.steps)
    val allowsDisclosure = !compactOnly || timeline.issueCount > 0
    val headline = if (compactOnly && !allowsDisclosure) {
        timeline.steps.lastOrNull()?.let { AidenAgentActivityPresentation.line(it) }
            ?: AidenAgentActivityPresentation.summary(timeline)
    } else {
        AidenAgentActivityPresentation.summary(timeline)
    }

    Surface(
        color = palette.raised.copy(alpha = 0.7f),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize(AidenMotion.spatialExpressiveSpring<IntSize>())
    ) {
        Column(modifier = Modifier.padding(10.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .then(
                        if (allowsDisclosure) Modifier.clickable { isExpanded = !isExpanded }
                        else Modifier
                    )
            ) {
                Icon(
                    imageVector = if (timeline.issueCount > 0) Icons.Default.Warning else Icons.Default.CheckCircle,
                    contentDescription = null,
                    tint = if (timeline.issueCount > 0) palette.warning else palette.success,
                    modifier = Modifier.size(16.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = headline,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground,
                    modifier = Modifier.weight(1f)
                )
                if (allowsDisclosure) {
                    Icon(
                        imageVector = if (isExpanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                        contentDescription = if (isExpanded) "Collapse" else "Expand",
                        tint = palette.secondary,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }

            if (allowsDisclosure && isExpanded) {
                Spacer(modifier = Modifier.height(8.dp))
                HorizontalDivider(color = palette.secondary.copy(alpha = 0.12f))
                Spacer(modifier = Modifier.height(6.dp))

                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (step in timeline.steps) {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                            Icon(
                                imageVector = if (step.status?.isIssue == true) Icons.Default.ErrorOutline else Icons.Default.Check,
                                contentDescription = null,
                                tint = if (step.status?.isIssue == true) palette.danger else palette.success,
                                modifier = Modifier.size(12.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = AidenAgentActivityPresentation.line(step),
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.foreground,
                                modifier = Modifier.weight(1f)
                            )
                            step.producedFile?.let { file ->
                                Text("File ${file.operation} · ${file.relativePath.substringAfterLast('/')}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = palette.foreground, maxLines = 1)
                            }
                            step.lineChanges?.let { lines ->
                                Surface(
                                    color = palette.canvas,
                                    shape = RoundedCornerShape(4.dp),
                                    modifier = Modifier.padding(start = 4.dp)
                                ) {
                                    Row(modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp)) {
                                        Text("+${lines.additions}", style = MaterialTheme.typography.labelSmall, color = palette.success)
                                        Spacer(modifier = Modifier.width(3.dp))
                                        Text("-${lines.deletions}", style = MaterialTheme.typography.labelSmall, color = palette.danger)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RichFormattedMessage(
    text: String,
    palette: sbtbiswas.AidenOnTheGo.config.AidenPalette,
    onCopy: (String) -> Unit,
    onOpenUrl: (String) -> Unit
) {
    val codeBlockRegex = Regex("```([a-zA-Z0-9_-]*)\\n?([\\s\\S]*?)```")
    val matches = codeBlockRegex.findAll(text).toList()

    if (matches.isEmpty()) {
        val formatted = buildAidenFormattedMessage(text = text, palette = palette, isUser = false)
        ClickableText(
            text = formatted,
            style = MaterialTheme.typography.bodyLarge.copy(color = palette.foreground, lineHeight = 22.sp),
            onClick = { offset ->
                formatted.getStringAnnotations(tag = AidenAnnotationTag.LINK.name, start = offset, end = offset)
                    .firstOrNull()?.let { onOpenUrl(it.item) }
            }
        )
    } else {
        var lastIndex = 0
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (match in matches) {
                val start = match.range.first
                val end = match.range.last + 1

                if (start > lastIndex) {
                    val leading = text.substring(lastIndex, start).trim()
                    if (leading.isNotEmpty()) {
                        val formatted = buildAidenFormattedMessage(text = leading, palette = palette, isUser = false)
                        ClickableText(
                            text = formatted,
                            style = MaterialTheme.typography.bodyLarge.copy(color = palette.foreground, lineHeight = 22.sp),
                            onClick = { offset ->
                                formatted.getStringAnnotations(tag = AidenAnnotationTag.LINK.name, start = offset, end = offset)
                                    .firstOrNull()?.let { onOpenUrl(it.item) }
                            }
                        )
                    }
                }

                val language = match.groupValues[1].trim()
                val codeContent = match.groupValues[2].trim()

                AidenCodeBlock(
                    code = codeContent,
                    language = language.ifEmpty { null },
                    palette = palette,
                    onCopy = onCopy
                )

                lastIndex = end
            }

            if (lastIndex < text.length) {
                val trailing = text.substring(lastIndex).trim()
                if (trailing.isNotEmpty()) {
                    val formatted = buildAidenFormattedMessage(text = trailing, palette = palette, isUser = false)
                    ClickableText(
                        text = formatted,
                        style = MaterialTheme.typography.bodyLarge.copy(color = palette.foreground, lineHeight = 22.sp),
                        onClick = { offset ->
                            formatted.getStringAnnotations(tag = AidenAnnotationTag.LINK.name, start = offset, end = offset)
                                .firstOrNull()?.let { onOpenUrl(it.item) }
                        }
                    )
                }
            }
        }
    }
}

private fun copyToClipboard(context: android.content.Context, text: String) {
    val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as? android.content.ClipboardManager
    val clip = android.content.ClipData.newPlainText("Aiden", text)
    clipboard?.setPrimaryClip(clip)
}

private fun shareText(context: android.content.Context, text: String) {
    val sendIntent = Intent().apply {
        action = Intent.ACTION_SEND
        putExtra(Intent.EXTRA_TEXT, text)
        type = "text/plain"
    }
    val shareIntent = Intent.createChooser(sendIntent, null)
    context.startActivity(shareIntent)
}

private fun getFileName(context: android.content.Context, uri: Uri): String? {
    var name: String? = null
    if (uri.scheme == "content") {
        context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) {
                    name = cursor.getString(index)
                }
            }
        }
    }
    if (name == null) {
        name = uri.path?.let { File(it).name }
    }
    return name
}

private fun isImageExtension(name: String): Boolean {
    val ext = File(name).extension.lowercase()
    return ext in setOf("png", "jpg", "jpeg", "heic", "heif", "webp")
}

private suspend fun readContentUriBounded(
    context: android.content.Context,
    uri: Uri,
    maximumBytes: Int
): ByteArray? = withContext(Dispatchers.IO) {
    context.contentResolver.openInputStream(uri)?.use { input ->
        val output = java.io.ByteArrayOutputStream(minOf(maximumBytes, 64 * 1024))
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > maximumBytes) return@withContext null
            output.write(buffer, 0, read)
        }
        output.toByteArray()
    }
}
