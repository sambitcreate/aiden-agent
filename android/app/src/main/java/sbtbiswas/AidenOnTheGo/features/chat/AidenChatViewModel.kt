package sbtbiswas.AidenOnTheGo.features.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteEvent
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteStreamEvent
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.notifications.AidenRemoteLiveNotificationManager
import sbtbiswas.AidenOnTheGo.notifications.AgentRunActivityStatus
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteEventType
import java.time.Instant
import java.util.Base64
import java.util.UUID

@OptIn(FlowPreview::class)
class AidenChatViewModel(
    val chatId: String,
    private val coordinator: AidenRemoteCoordinator,
    private val chatCache: AidenChatCache,
    private val draftStore: AidenChatDraftStore,
    val initialChat: AidenChat? = null,
    private val liveNotificationManager: AidenRemoteLiveNotificationManager? = null
) : ViewModel() {
    private val _chat = MutableStateFlow<AidenChat?>(initialChat ?: chatCache.getChat(chatId))
    val chat: StateFlow<AidenChat?> = _chat.asStateFlow()

    private val _catalog = MutableStateFlow<AidenModelCatalog?>(null)
    val catalog: StateFlow<AidenModelCatalog?> = _catalog.asStateFlow()

    private val _selectedProviderId = MutableStateFlow<String?>(null)
    val selectedProviderId: StateFlow<String?> = _selectedProviderId.asStateFlow()

    private val _selectedModelId = MutableStateFlow<String?>(null)
    val selectedModelId: StateFlow<String?> = _selectedModelId.asStateFlow()

    private val _selectedThinkingLevel = MutableStateFlow<String?>(null)
    val selectedThinkingLevel: StateFlow<String?> = _selectedThinkingLevel.asStateFlow()

    private val _streamState = MutableStateFlow<AidenStreamState?>(null)
    val streamState: StateFlow<AidenStreamState?> = _streamState.asStateFlow()

    val isStreaming: StateFlow<Boolean>
        get() = MutableStateFlow(_streamState.value != null && !_streamState.value!!.isTerminal).asStateFlow()

    private val _liveText = MutableStateFlow("")
    val liveText: StateFlow<String> = _liveText.asStateFlow()

    private val _reasoning = MutableStateFlow("")
    val reasoning: StateFlow<String> = _reasoning.asStateFlow()

    private val _tools = MutableStateFlow<List<AidenLiveTool>>(emptyList())
    val tools: StateFlow<List<AidenLiveTool>> = _tools.asStateFlow()

    private val _activityTimeline = MutableStateFlow<AidenGenerationTimeline?>(null)
    val activityTimeline: StateFlow<AidenGenerationTimeline?> = _activityTimeline.asStateFlow()

    private val _pendingApproval = MutableStateFlow<AidenPendingApproval?>(null)
    val pendingApproval: StateFlow<AidenPendingApproval?> = _pendingApproval.asStateFlow()

    private val _pendingAttachments = MutableStateFlow<List<AidenAttachmentReference>>(emptyList())
    val pendingAttachments: StateFlow<List<AidenAttachmentReference>> = _pendingAttachments.asStateFlow()

    private val _isUploadingAttachment = MutableStateFlow(false)
    val isUploadingAttachment: StateFlow<Boolean> = _isUploadingAttachment.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _isStarting = MutableStateFlow(false)
    val isStarting: StateFlow<Boolean> = _isStarting.asStateFlow()

    private val _presentedError = MutableStateFlow<String?>(null)
    val presentedError: StateFlow<String?> = _presentedError.asStateFlow()

    private val _draft = MutableStateFlow("")
    val draft: StateFlow<String> = _draft.asStateFlow()

    private var draftSession: AidenChatDraftStore.Session? = null
    private var activeStreamId: String? = null
    private var streamJob: Job? = null
    private var titleRefreshJob: Job? = null
    private var terminalReconciliationJob: Job? = null
    private val turnAttempts = AidenTurnAttemptTracker()
    private val attachmentImageLoadMutex = Mutex()
    private val attachmentImageLoads = mutableMapOf<String, Deferred<ByteArray?>>()
    private val boundClient = coordinator.client.value
    private val instanceId: String = coordinator.installationStore.activeInstallation?.instanceId ?: ""
    private val deviceId: String = coordinator.installationStore.activeInstallation?.deviceId ?: ""

    private fun activeClient(): AidenRemoteClient? =
        boundClient?.takeIf { coordinator.client.value === it }

    val isReadOnlyPresentation: Boolean
        get() = coordinator.installationStore.activeInstallation == null

    val isConnected: Boolean
        get() = activeClient() != null

    val canSend: Boolean
        get() = !isReadOnlyPresentation && isConnected && !_isStarting.value &&
                (_streamState.value == null || _streamState.value!!.isTerminal) &&
                (_draft.value.trim().isNotEmpty() || _pendingAttachments.value.isNotEmpty())

    init {
        val currentInstanceId = instanceId
        if (currentInstanceId.isNotEmpty()) {
            draftSession = draftStore.beginSession(currentInstanceId, chatId)
            draftSession?.let { session ->
                val savedText = draftStore.load(session)
                if (!savedText.isNullOrEmpty()) {
                    _draft.value = savedText
                }
            }
            val cachedChat = chatCache.loadChat(currentInstanceId, chatId)
            if (cachedChat != null) {
                _chat.value = cachedChat
            }
        }
        loadChat()
        loadCatalog()
        resumeActiveStreamIfNeeded()
        viewModelScope.launch {
            combine(_streamState, _liveText, _activityTimeline) { state, text, timeline ->
                Triple(state, text, timeline)
            }.debounce(400).collect { (state, text, timeline) ->
                publishLiveNotification(state, text, timeline)
            }
        }
    }

    private fun publishLiveNotification(
        state: AidenStreamState?,
        responseText: String,
        timeline: AidenGenerationTimeline?
    ) {
        if (state == null || instanceId.isEmpty()) return
        val activeStep = timeline?.steps?.lastOrNull { it.isActive }
        val status = when {
            state == AidenStreamState.WAITING_FOR_APPROVAL -> AgentRunActivityStatus.WAITING_FOR_APPROVAL
            state == AidenStreamState.DONE -> AgentRunActivityStatus.COMPLETE
            state == AidenStreamState.ERROR || state == AidenStreamState.INTERRUPTED -> AgentRunActivityStatus.FAILED
            state == AidenStreamState.CANCELLED -> AgentRunActivityStatus.CANCELLED
            responseText.isNotBlank() -> AgentRunActivityStatus.RESPONDING
            activeStep?.kind == AidenAgentStep.Kind.TOOL -> AgentRunActivityStatus.USING_TOOL
            state == AidenStreamState.QUEUED -> AgentRunActivityStatus.STARTING
            else -> AgentRunActivityStatus.THINKING
        }
        val activity = when {
            state == AidenStreamState.WAITING_FOR_APPROVAL -> "Waiting for your approval"
            activeStep?.label?.isNotBlank() == true -> activeStep.label
            activeStep?.toolName?.isNotBlank() == true -> activeStep.toolName
            responseText.isNotBlank() -> "Writing a response"
            else -> status.title
        } ?: status.title
        liveNotificationManager?.showAgentProgressNotification(
            instanceId = instanceId,
            sessionId = chatId,
            sessionTitle = _chat.value?.title.orEmpty(),
            status = status,
            currentActivity = activity,
            responseExcerpt = responseText
        )
    }

    fun updateDraft(text: String) {
        _draft.value = text
        draftSession?.let { session ->
            draftStore.save(text, session)
        }
    }

    fun selectProvider(providerId: String) {
        val currentChat = _chat.value
        if (currentChat != null && currentChat.isBotChat) return
        _selectedProviderId.value = providerId
        val catalog = _catalog.value
        val provider = catalog?.providers?.firstOrNull { it.id == providerId }
        val firstModel = provider?.visibleModels?.firstOrNull()
        _selectedModelId.value = firstModel?.id
        _selectedThinkingLevel.value = firstModel?.effectiveThinkingLevel
    }

    fun selectModel(modelId: String) {
        val currentChat = _chat.value
        if (currentChat != null && currentChat.isBotChat) return
        _selectedModelId.value = modelId
        val catalog = _catalog.value
        val provider = catalog?.providers?.firstOrNull { it.id == _selectedProviderId.value }
        val model = provider?.models?.firstOrNull { it.id == modelId }
        _selectedThinkingLevel.value = model?.effectiveThinkingLevel
    }

    fun selectThinkingLevel(level: String?) {
        _selectedThinkingLevel.value = level
    }

    fun loadChat() {
        val client = activeClient() ?: return
        viewModelScope.launch {
            _isLoading.value = true
            try {
                val remote = client.chat(chatId)
                acceptRemoteChat(remote)
            } catch (e: Exception) {
                if (e !is CancellationException) {
                    _presentedError.value = e.localizedMessage
                }
            } finally {
                _isLoading.value = false
            }
        }
    }

    fun loadCatalog() {
        val client = activeClient() ?: return
        viewModelScope.launch {
            try {
                val catalog = client.modelCatalog()
                _catalog.value = catalog
                resolveModelSelection()
            } catch (_: Exception) {}
        }
    }

    private fun resolveModelSelection() {
        val currentChat = _chat.value ?: return
        val selection = AidenChatModelAuthority.resolvedSelection(
            chat = currentChat,
            catalog = _catalog.value,
            selectedProviderId = _selectedProviderId.value,
            selectedModelId = _selectedModelId.value,
            selectedThinkingLevel = _selectedThinkingLevel.value
        )
        _selectedProviderId.value = selection.providerId
        _selectedModelId.value = selection.modelId
        _selectedThinkingLevel.value = selection.thinkingLevel
    }

    private fun resumeActiveStreamIfNeeded() {
        val currentInstanceId = instanceId
        if (currentInstanceId.isEmpty()) return
        val activeStream = chatCache.loadActiveStream(currentInstanceId, chatId) ?: return
        if (activeStream.deviceId != deviceId) {
            chatCache.removeActiveStream(currentInstanceId, chatId, ifStreamId = activeStream.streamId)
            return
        }
        startStreaming(activeStream)
    }

    fun send() {
        if (!canSend) return
        val client = activeClient() ?: return
        val currentChat = _chat.value ?: return

        val text = _draft.value.trim()
        val submittedAttachments = _pendingAttachments.value
        val turnModel = AidenChatModelAuthority.turnSelection(
            chat = currentChat,
            selectedProviderId = _selectedProviderId.value,
            selectedModelId = _selectedModelId.value,
            selectedThinkingLevel = _selectedThinkingLevel.value
        )

        val request = AidenTurnRequestBuilder.make(
            text = text,
            providerId = turnModel.providerId,
            modelId = turnModel.modelId,
            thinkingLevel = turnModel.thinkingLevel,
            attachments = submittedAttachments
        )

        val previousUpdatedAt = currentChat.updatedAt
        val optimisticId = "local-${UUID.randomUUID().toString().lowercase()}"
        val now = Instant.now()
        val optimisticMessage = AidenChatMessage(
            id = optimisticId,
            role = AidenChatRole.USER,
            text = text,
            attachments = submittedAttachments.map {
                AidenMessageAttachment(
                    id = it.id,
                    name = it.name,
                    mimeType = it.mimeType,
                    kind = it.kind,
                    size = it.size
                )
            },
            createdAt = now
        )

        _isStarting.value = true
        _presentedError.value = null
        _draft.value = ""
        draftSession?.let { draftStore.save("", it) }
        _pendingAttachments.value = emptyList()

        val updatedMessages = currentChat.messages + optimisticMessage
        val updatedChat = currentChat.copy(messages = updatedMessages, updatedAt = now)
        _chat.value = updatedChat
        _streamState.value = AidenStreamState.QUEUED

        val idempotencyKey = turnAttempts.key(request)

        viewModelScope.launch {
            try {
                val response = client.startTurn(chatId, request, idempotencyKey)
                val stream = AidenChatCache.ActiveStream(
                    deviceId = deviceId,
                    streamId = response.streamId,
                    turnId = response.turnId,
                    lastSequence = 0
                )

                val cleanMessages = updatedChat.messages.filter { it.id != optimisticId }.toMutableList()
                if (cleanMessages.none { it.id == response.message.id }) {
                    cleanMessages.add(response.message)
                }
                val acceptedChat = updatedChat.copy(messages = cleanMessages)
                _chat.value = acceptedChat
                if (instanceId.isNotEmpty()) {
                    chatCache.saveChat(acceptedChat, instanceId)
                    chatCache.saveActiveStream(stream, instanceId, chatId)
                }
                turnAttempts.reset()

                _liveText.value = ""
                _reasoning.value = ""
                _tools.value = emptyList()
                _activityTimeline.value = null
                _pendingApproval.value = null
                _streamState.value = AidenStreamState.QUEUED

                startStreaming(stream)
            } catch (e: Exception) {
                if (e !is CancellationException) {
                    val fallbackMessages = _chat.value?.messages?.filter { it.id != optimisticId } ?: emptyList()
                    _chat.value = _chat.value?.copy(messages = fallbackMessages, updatedAt = previousUpdatedAt)
                    _draft.value = AidenDraftSendReconciliation.failedDraft(text, _draft.value)
                    _pendingAttachments.value = AidenDraftSendReconciliation.failedAttachments(submittedAttachments, _pendingAttachments.value)
                    _streamState.value = null
                    _presentedError.value = e.localizedMessage
                }
            } finally {
                _isStarting.value = false
            }
        }
    }

    suspend fun upload(uploads: List<AidenAttachmentUpload>): Int {
        if (isReadOnlyPresentation || !isConnected || _isUploadingAttachment.value ||
            (_streamState.value != null && !_streamState.value!!.isTerminal) ||
            _pendingAttachments.value.size >= 10
        ) {
            return uploads.size
        }
        val client = activeClient() ?: return uploads.size
        _isUploadingAttachment.value = true
        _presentedError.value = null
        var failedCount = 0
        val acceptedReferences = mutableListOf<AidenAttachmentReference>()

        try {
            val availableSlots = 10 - _pendingAttachments.value.size
            for (upload in uploads.take(availableSlots)) {
                try {
                    val reference = client.uploadAttachment(chatId, upload)
                    if (!reference.isValid()) {
                        failedCount++
                        continue
                    }
                    _pendingAttachments.value = _pendingAttachments.value + reference
                    acceptedReferences.add(reference)

                    if (upload is AidenAttachmentUpload.Image && instanceId.isNotEmpty() && deviceId.isNotEmpty()) {
                        val attachment = AidenMessageAttachment(
                            id = reference.id,
                            name = reference.name,
                            mimeType = upload.mimeType,
                            kind = AidenAttachmentKind.IMAGE,
                            size = reference.size
                        )
                        val rawBytes = Base64.getDecoder().decode(upload.data)
                        try {
                            chatCache.saveAttachmentImage(rawBytes, instanceId, deviceId, chatId, attachment)
                        } catch (_: Exception) {}
                    }
                } catch (_: Exception) {
                    failedCount++
                }
            }
        } finally {
            _isUploadingAttachment.value = false
        }
        return failedCount
    }

    fun removePendingAttachment(attachmentId: String) {
        val client = activeClient()
        val toRemove = _pendingAttachments.value.firstOrNull { it.id == attachmentId } ?: return
        _pendingAttachments.value = _pendingAttachments.value.filter { it.id != attachmentId }
        if (instanceId.isNotEmpty() && deviceId.isNotEmpty()) {
            viewModelScope.launch(kotlinx.coroutines.Dispatchers.IO) {
                chatCache.removeAttachmentImage(instanceId, deviceId, chatId, attachmentId)
            }
        }
        if (client != null) {
            viewModelScope.launch {
                try { client.removeAttachment(chatId, toRemove.id) } catch (_: Exception) {}
            }
        }
    }

    suspend fun attachmentImageData(attachment: AidenMessageAttachment): ByteArray? {
        if (instanceId.isEmpty() || deviceId.isEmpty() ||
            attachment.kind != AidenAttachmentKind.IMAGE
        ) return null

        val loadKey = "$instanceId\u001f$deviceId\u001f$chatId\u001f${attachment.id}"
        val request = attachmentImageLoadMutex.withLock {
            attachmentImageLoads[loadKey] ?: viewModelScope.async {
                loadAttachmentImageData(attachment)
            }.also { attachmentImageLoads[loadKey] = it }
        }
        return try {
            request.await()
        } finally {
            attachmentImageLoadMutex.withLock {
                if (attachmentImageLoads[loadKey] === request && request.isCompleted) {
                    attachmentImageLoads.remove(loadKey)
                }
            }
        }
    }

    private suspend fun loadAttachmentImageData(attachment: AidenMessageAttachment): ByteArray? {

        withContext(kotlinx.coroutines.Dispatchers.IO) {
            chatCache.attachmentImage(instanceId, deviceId, chatId, attachment)
        }?.let { return it }
        val client = activeClient() ?: return null
        return try {
            val content = client.attachmentContent(chatId, attachment.id)
            if (activeClient() !== client || coordinator.activeInstanceId != instanceId ||
                coordinator.installationStore.activeInstallation?.deviceId != deviceId
            ) return null
            if (!content.mimeType.equals(attachment.mimeType, ignoreCase = true)) return null
            val validated = AidenAttachmentImageValidation.validatedData(
                content.data,
                attachment.mimeType,
                attachment.size
            ) ?: return null
            withContext(kotlinx.coroutines.Dispatchers.IO) {
                chatCache.saveAttachmentImage(validated, instanceId, deviceId, chatId, attachment)
            }
            validated
        } catch (_: Exception) {
            null
        }
    }

    private fun startStreaming(originalStream: AidenChatCache.ActiveStream) {
        val client = activeClient() ?: return
        activeStreamId = originalStream.streamId
        streamJob?.cancel()
        streamJob = viewModelScope.launch {
            var stream = originalStream
            val terminalReplayGate = AidenTerminalReplayGate()
            var retryAttempt = 0

            while (activeStreamId == stream.streamId) {
                try {
                    client.openStream(chatId, stream.streamId, lastEventId = stream.lastSequence).collect { event ->
                        if (activeStreamId != stream.streamId) return@collect
                        if (event.streamId != stream.streamId) return@collect
                        if (event.sequence <= stream.lastSequence) return@collect
                        if (event.sequence != stream.lastSequence + 1) {
                            reconcileChat()
                        }
                        apply(event)
                        if (activeStreamId != stream.streamId) return@collect
                        stream.lastSequence = event.sequence
                        if (event.terminal) return@collect
                        if (instanceId.isNotEmpty()) {
                            chatCache.saveActiveStream(stream, instanceId, chatId)
                        }
                    }

                    val status = client.streamStatus(chatId, stream.streamId)
                    if (activeStreamId != stream.streamId) return@launch
                    retryAttempt = 0
                    apply(status, stream.streamId)
                    if (status.state.isTerminal) {
                        if (terminalReplayGate.shouldReplay(status.state)) continue
                        finishStream(stream.streamId)
                        return@launch
                    }
                    delay(500)
                } catch (e: Exception) {
                    if (e is CancellationException) return@launch
                    try {
                        val status = client.streamStatus(chatId, stream.streamId)
                        if (activeStreamId != stream.streamId) return@launch
                        apply(status, stream.streamId)
                        if (status.state.isTerminal) {
                            if (terminalReplayGate.shouldReplay(status.state)) continue
                            finishStream(stream.streamId)
                            return@launch
                        }
                        delay(1000)
                    } catch (inner: Exception) {
                        if (inner is CancellationException) return@launch
                        if (AidenTerminalReconciliation.isDefinitiveMissingStream(inner)) {
                            if (reconcileMissingStream(stream)) return@launch
                        }
                        _presentedError.value = inner.localizedMessage
                        val retryDelay = AidenTerminalReconciliation.retryDelayMilliseconds(retryAttempt)
                        retryAttempt++
                        delay(retryDelay)
                        continue
                    }
                }
            }
        }
    }

    private suspend fun apply(event: AidenRemoteStreamEvent) {
        if (activeStreamId != event.streamId) return
        when (event.type) {
            AidenRemoteEventType.SNAPSHOT -> {
                _streamState.value = AidenStreamState.RECONCILING
                if (_chat.value?.isBotChat == true) {
                    _liveText.value = ""
                    _reasoning.value = ""
                }
                reconcileChat()
            }
            AidenRemoteEventType.STATUS -> {
                val stateStr = event.payload?.state
                val state = stateStr?.let { s ->
                    try { AidenStreamState.valueOf(s.uppercase()) } catch (_: Exception) { null }
                }
                if (state != null) {
                    if (state == AidenStreamState.WAITING_FOR_APPROVAL) {
                        restorePendingApproval(event.streamId)
                    } else {
                        _streamState.value = state
                        _pendingApproval.value = null
                    }
                }
            }
            AidenRemoteEventType.TEXT_DELTA -> {
                val delta = event.payload?.text ?: ""
                _liveText.value += delta
                _streamState.value = AidenStreamState.RUNNING
            }
            AidenRemoteEventType.REASONING_DELTA -> {
                val delta = event.payload?.text ?: ""
                _reasoning.value += delta
            }
            AidenRemoteEventType.TOOL_STARTED -> {
                val id = event.payload?.toolId
                val name = event.payload?.name
                if (id != null && name != null) {
                    _tools.value = _tools.value + AidenLiveTool(id = id, name = name, status = null)
                }
            }
            AidenRemoteEventType.TOOL_FINISHED -> {
                val id = event.payload?.toolId
                val status = event.payload?.status
                if (id != null) {
                    _tools.value = _tools.value.map { if (it.id == id) it.copy(status = status) else it }
                }
            }
            AidenRemoteEventType.TIMELINE -> {
                event.payload?.timeline?.let { timeline ->
                    _activityTimeline.value = timeline
                }
            }
            AidenRemoteEventType.APPROVAL_REQUIRED -> {
                restorePendingApproval(event.streamId)
            }
            AidenRemoteEventType.ERROR -> {
                _pendingApproval.value = null
                _presentedError.value = null
                _streamState.value = AidenStreamState.ERROR
                finishStream(event.streamId)
            }
            AidenRemoteEventType.CANCELLED -> {
                _pendingApproval.value = null
                _streamState.value = AidenStreamState.CANCELLED
                finishStream(event.streamId)
            }
            AidenRemoteEventType.DONE -> {
                _pendingApproval.value = null
                _streamState.value = AidenStreamState.DONE
                finishStream(event.streamId)
            }
            AidenRemoteEventType.HEARTBEAT -> {}
            else -> {}
        }
    }

    private suspend fun apply(status: AidenStreamStatus, streamId: String) {
        if (activeStreamId != streamId || status.streamId != streamId || status.chatId != chatId) return
        if (status.state == AidenStreamState.WAITING_FOR_APPROVAL) {
            restorePendingApproval(streamId)
            return
        }
        _pendingApproval.value = null
        _streamState.value = status.state
    }

    private suspend fun restorePendingApproval(streamId: String) {
        val client = activeClient() ?: return
        try {
            val snapshot = client.streamApproval(streamId)
            if (activeStreamId != streamId) return
            val approval = AidenPendingApprovalResolution.resolve(
                snapshot.approval,
                streamId = streamId,
                chatId = chatId
            )
            if (approval != null) {
                _pendingApproval.value = approval
                _streamState.value = AidenStreamState.WAITING_FOR_APPROVAL
            } else {
                _pendingApproval.value = null
                _streamState.value = AidenStreamState.RECONCILING
            }
        } catch (_: Exception) {
            _pendingApproval.value = null
            _streamState.value = AidenStreamState.RECONCILING
        }
    }

    fun cancelTurn() {
        val client = activeClient() ?: return
        val streamId = activeStreamId ?: return
        viewModelScope.launch {
            try {
                client.cancelTurn(chatId, streamId)
            } catch (_: Exception) {}
        }
    }

    fun stop() {
        cancelTurn()
    }

    fun respondToApproval(decision: AidenApprovalDecision) {
        if (isReadOnlyPresentation) return
        val approval = _pendingApproval.value
        if (approval == null || !approval.expiresAt.isAfter(Instant.now())) {
            _pendingApproval.value = null
            return
        }
        val client = activeClient() ?: return
        val streamId = activeStreamId ?: return
        val previousState = _streamState.value

        _pendingApproval.value = null
        _streamState.value = AidenStreamState.RUNNING

        viewModelScope.launch {
            try {
                client.respondToApproval(chatId, approval.id, decision, UUID.randomUUID())
            } catch (e: Exception) {
                if (e !is CancellationException && activeStreamId == streamId) {
                    _pendingApproval.value = approval
                    _streamState.value = previousState
                    _presentedError.value = e.localizedMessage
                }
            }
        }
    }

    private suspend fun reconcileChat(): Boolean {
        val client = activeClient() ?: return false
        return try {
            val remote = client.chat(chatId)
            acceptRemoteChat(remote)
            true
        } catch (e: Exception) {
            if (e !is CancellationException) {
                _presentedError.value = e.localizedMessage
            }
            false
        }
    }

    private fun acceptRemoteChat(remote: AidenChat, scheduleTitleRefresh: Boolean = true) {
        _chat.value = remote
        resolveModelSelection()
        if (instanceId.isNotEmpty()) {
            chatCache.saveChat(remote, instanceId)
        }
        if (scheduleTitleRefresh && remote.isTitlePending) {
            schedulePendingTitleRefresh()
        }
    }

    private fun schedulePendingTitleRefresh() {
        if (titleRefreshJob != null && titleRefreshJob!!.isActive) return
        titleRefreshJob = viewModelScope.launch {
            val client = activeClient() ?: return@launch
            for (delayMs in AidenChatTitleReconciliation.retryMilliseconds) {
                try {
                    delay(delayMs)
                    val remote = client.chat(chatId)
                    acceptRemoteChat(remote, scheduleTitleRefresh = false)
                    if (!remote.isTitlePending) return@launch
                } catch (e: Exception) {
                    if (e is CancellationException) return@launch
                }
            }
        }
    }

    private suspend fun finishStream(expectedStreamId: String) {
        if (activeStreamId != expectedStreamId) return
        if (!reconcileChat()) {
            scheduleTerminalReconciliation(expectedStreamId)
            return
        }
        clearFinishedStream(expectedStreamId)
    }

    private fun clearFinishedStream(expectedStreamId: String) {
        if (activeStreamId == expectedStreamId) {
            activeStreamId = null
            if (instanceId.isNotEmpty()) {
                chatCache.removeActiveStream(instanceId, chatId, ifStreamId = expectedStreamId)
            }
        }
    }

    private suspend fun reconcileMissingStream(stream: AidenChatCache.ActiveStream): Boolean {
        if (activeStreamId != stream.streamId) return false
        if (!reconcileChat()) return false
        if (activeStreamId != stream.streamId) return false
        val currentChat = _chat.value ?: return false
        when (AidenMissingStreamResolution.resolve(currentChat.messages)) {
            AidenMissingStreamResolutionState.CANCELLED -> _streamState.value = AidenStreamState.CANCELLED
            AidenMissingStreamResolutionState.FAILED -> _streamState.value = AidenStreamState.ERROR
            AidenMissingStreamResolutionState.COMPLETE -> _streamState.value = AidenStreamState.DONE
            AidenMissingStreamResolutionState.INTERRUPTED -> _streamState.value = AidenStreamState.INTERRUPTED
        }
        clearFinishedStream(stream.streamId)
        return true
    }

    private fun scheduleTerminalReconciliation(expectedStreamId: String) {
        if (terminalReconciliationJob != null && terminalReconciliationJob!!.isActive) return
        terminalReconciliationJob = viewModelScope.launch {
            var attempt = 0
            while (activeStreamId == expectedStreamId) {
                try {
                    val delayMs = AidenTerminalReconciliation.retryDelayMilliseconds(attempt)
                    delay(delayMs)
                    if (activeStreamId != expectedStreamId) return@launch
                    if (reconcileChat()) {
                        clearFinishedStream(expectedStreamId)
                        return@launch
                    }
                } catch (e: Exception) {
                    if (e is CancellationException) return@launch
                }
                attempt++
            }
        }
    }

    // Compatibility sendTurn
    fun sendTurn(text: String, thinkingLevel: String? = null, attachmentIds: List<String>? = null) {
        updateDraft(text)
        send()
    }

    companion object {
        fun factory(
            chatId: String,
            coordinator: AidenRemoteCoordinator,
            chatCache: AidenChatCache,
            draftStore: AidenChatDraftStore,
            liveNotificationManager: AidenRemoteLiveNotificationManager? = null
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return AidenChatViewModel(
                    chatId,
                    coordinator,
                    chatCache,
                    draftStore,
                    liveNotificationManager = liveNotificationManager
                ) as T
            }
        }
    }
}
