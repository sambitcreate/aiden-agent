package sbtbiswas.AidenOnTheGo.features.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlin.coroutines.coroutineContext
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
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteEvent
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteStreamEvent
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.notifications.AidenRemoteLiveNotificationManager
import sbtbiswas.AidenOnTheGo.notifications.AgentRunActivityStatus
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteEventType
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
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
    enum class ProgressConnectionState {
        IDLE, CONNECTING, LIVE, LAST_KNOWN, UNAVAILABLE
    }

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
    private val _isStopping = MutableStateFlow(false)
    val isStopping: StateFlow<Boolean> = _isStopping.asStateFlow()

    private val _isSubmittingRunInput = MutableStateFlow(false)
    val isSubmittingRunInput: StateFlow<Boolean> = _isSubmittingRunInput.asStateFlow()

    private val _runInputReceipt = MutableStateFlow<String?>(null)
    val runInputReceipt: StateFlow<String?> = _runInputReceipt.asStateFlow()

    private var runInputReceiptToken = 0L
    private var lastRunInputAttempt: AidenRunInputPresentation.Attempt? = null
    private val _isRespondingToApproval = MutableStateFlow(false)
    val isRespondingToApproval: StateFlow<Boolean> = _isRespondingToApproval.asStateFlow()

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

    private val _taskProgress = MutableStateFlow<AidenChatTaskProgress?>(null)
    val taskProgress: StateFlow<AidenChatTaskProgress?> = _taskProgress.asStateFlow()

    private val _agentRoster = MutableStateFlow<AidenChatAgentRoster?>(null)
    val agentRoster: StateFlow<AidenChatAgentRoster?> = _agentRoster.asStateFlow()

    private val _selectedAgentRoster = MutableStateFlow<AidenChatAgentRoster?>(null)
    val selectedAgentRoster: StateFlow<AidenChatAgentRoster?> = _selectedAgentRoster.asStateFlow()

    private val _agentRosterHistory = MutableStateFlow<List<AidenChatAgentRoster>>(emptyList())
    /** Current plus a small number of prior turn rosters for the progress sheet. */
    val agentRosterHistory: StateFlow<List<AidenChatAgentRoster>> = _agentRosterHistory.asStateFlow()

    private val _progressConnectionState = MutableStateFlow(ProgressConnectionState.IDLE)
    val progressConnectionState: StateFlow<ProgressConnectionState> = _progressConnectionState.asStateFlow()

    private val _draft = MutableStateFlow("")
    val draft: StateFlow<String> = _draft.asStateFlow()

    private var draftSession: AidenChatDraftStore.Session? = null
    private var activeStreamId: String? = null
    private var streamJob: Job? = null
    private var titleRefreshJob: Job? = null
    private var terminalReconciliationJob: Job? = null
    private var progressObservationJob: Job? = null
    private var progressForeground = false
    private var progressObservationToken = 0L
    private var taskEpoch: String? = null
    private var taskRevision = 0L
    private var agentEpoch: String? = null
    private var agentRevision = 0L
    private var currentRosterTurnId: String? = null
    private var selectedRosterTurnId: String? = null
    private var agentRosterSelectionTicket = 0L
    private var taskCapabilityDeniedObservationToken: Long? = null
    private var agentCapabilityDeniedObservationToken: Long? = null
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

    val canReadTaskProgress: Boolean
        get() = coordinator.serverInfo.value?.let { server ->
            // Progress grants are fail-closed. `capabilities` can be the
            // legacy aggregate on /server; only the explicit server grant is
            // authoritative for the new projection.
            server.supportsChatTasks &&
                server.serverCapabilities?.contains(AidenRemoteCapability.TASKS_READ) == true &&
                installationForProgress()?.deviceCapabilities?.contains(AidenRemoteCapability.TASKS_READ) == true
        } == true

    val canReadAgentRoster: Boolean
        get() = coordinator.serverInfo.value?.let { server ->
            server.supportsChatAgents &&
                server.serverCapabilities?.contains(AidenRemoteCapability.AGENTS_READ) == true &&
                installationForProgress()?.deviceCapabilities?.contains(AidenRemoteCapability.AGENTS_READ) == true
        } == true

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

    private fun installationForProgress(): AidenInstallation? {
        val installation = coordinator.installationStore.activeInstallation
        return installation?.takeIf {
            it.instanceId == instanceId && it.deviceId == deviceId && activeClient() != null
        }
    }

    /** Attach the standalone chat progress stream while the detail screen is foregrounded. */
    fun startProgressObservation() {
        progressForeground = true
        reconcileProgressAccess()
        if (progressObservationJob?.isActive == true) return
        progressObservationToken += 1
        if (coordinator.serverInfo.value != null && !canReadTaskProgress && !canReadAgentRoster) {
            _progressConnectionState.value = ProgressConnectionState.UNAVAILABLE
            return
        }
        val observationToken = progressObservationToken
        progressObservationJob = viewModelScope.launch {
            observeProgressUntilBackground(observationToken)
        }
    }

    /** Stop SSE work in the background but preserve the last authoritative snapshot. */
    fun stopProgressObservation() {
        progressForeground = false
        progressObservationToken += 1
        progressObservationJob?.cancel()
        progressObservationJob = null
        _progressConnectionState.value = when {
            _taskProgress.value != null || _agentRoster.value != null -> ProgressConnectionState.LAST_KNOWN
            canReadTaskProgress || canReadAgentRoster -> ProgressConnectionState.IDLE
            else -> ProgressConnectionState.UNAVAILABLE
        }
    }

    private suspend fun observeProgressUntilBackground(observationToken: Long) {
        var retryAttempt = 0
        while (progressForeground && progressObservationToken == observationToken && coroutineContext.isActive) {
            val client = activeClient()
            if (client == null || (!canReadTaskProgress && !canReadAgentRoster)) {
                _progressConnectionState.value = if (_taskProgress.value != null || _agentRoster.value != null) {
                    ProgressConnectionState.LAST_KNOWN
                } else {
                    ProgressConnectionState.UNAVAILABLE
                }
                return
            }

            _progressConnectionState.value = ProgressConnectionState.CONNECTING
            try {
                // Hydrate authoritative snapshots before opening the journal.
                // The server sends a fresh snapshot on subscribe as well, so an
                // update between these reads and the connection cannot be lost.
                if (canReadTaskProgress && taskCapabilityDeniedObservationToken != observationToken) {
                    try {
                        val snapshot = client.chatTasks(chatId)
                        if (!isProgressContextCurrent(client, observationToken) || !canReadTaskProgress) return
                        acceptTaskProgress(snapshot)
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        if (isProgressCredentialRevoked(error)) throw error
                        if (isProgressCapabilityDenied(error)) {
                            clearTaskProgressState()
                            taskCapabilityDeniedObservationToken = observationToken
                        }
                        // Keep a last-known task snapshot while a transient read fails.
                    }
                }
                if (canReadAgentRoster && agentCapabilityDeniedObservationToken != observationToken) {
                    try {
                        val snapshot = client.chatAgents(chatId)
                        if (!isProgressContextCurrent(client, observationToken) || !canReadAgentRoster) return
                        acceptAgentRoster(snapshot)
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        if (isProgressCredentialRevoked(error)) throw error
                        if (isProgressCapabilityDenied(error)) {
                            clearAgentRosterState()
                            agentCapabilityDeniedObservationToken = observationToken
                        }
                        // Keep a last-known roster while a transient read fails.
                    }
                }

                // Event sequence numbers are process-local on the Mac. A
                // reconnect therefore starts a new subscription at zero.
                val canObserveTasks = canReadTaskProgress && taskCapabilityDeniedObservationToken != observationToken
                val canObserveAgents = canReadAgentRoster && agentCapabilityDeniedObservationToken != observationToken
                if (!canObserveTasks && !canObserveAgents) {
                    _progressConnectionState.value = if (_taskProgress.value != null || _agentRoster.value != null) {
                        ProgressConnectionState.LAST_KNOWN
                    } else {
                        ProgressConnectionState.UNAVAILABLE
                    }
                    return
                }
                client.progressEvents(chatId, after = 0).collect { event ->
                    if (!isProgressContextCurrent(client, observationToken) || event.streamId != chatId) return@collect
                    var accepted = false
                    when (event.type) {
                        AidenRemoteEventType.TASK_UPDATE -> if (
                            canReadTaskProgress && taskCapabilityDeniedObservationToken != observationToken
                        ) {
                            event.payload?.taskProgress?.let {
                                acceptTaskProgress(it)
                                accepted = true
                            }
                        }
                        AidenRemoteEventType.AGENTS_UPDATE -> if (
                            canReadAgentRoster && agentCapabilityDeniedObservationToken != observationToken
                        ) {
                            event.payload?.agentRoster?.let {
                                acceptAgentRoster(it)
                                accepted = true
                            }
                        }
                        else -> Unit
                    }
                    if (accepted) {
                        _progressConnectionState.value = ProgressConnectionState.LIVE
                    }
                }
                retryAttempt = 0
                if (progressForeground && progressObservationToken == observationToken) {
                    _progressConnectionState.value = if (_taskProgress.value != null || _agentRoster.value != null) {
                        ProgressConnectionState.LAST_KNOWN
                    } else {
                        ProgressConnectionState.UNAVAILABLE
                    }
                    delay(progressRetryDelay(0))
                }
            } catch (error: Exception) {
                if (error is CancellationException) return
                if (isProgressCredentialRevoked(error)) {
                    clearProgressState()
                    if (coordinator.installationStore.activeInstallation?.instanceId == instanceId) {
                        coordinator.removeInstallation(instanceId)
                    }
                    return
                }
                if (isProgressCapabilityDenied(error)) {
                    clearProgressState()
                    return
                }
                _progressConnectionState.value = if (_taskProgress.value != null || _agentRoster.value != null) {
                    ProgressConnectionState.LAST_KNOWN
                } else {
                    ProgressConnectionState.UNAVAILABLE
                }
                delay(progressRetryDelay(retryAttempt))
                retryAttempt = (retryAttempt + 1).coerceAtMost(5)
            }
        }
    }

    private fun isProgressContextCurrent(client: AidenRemoteClient, observationToken: Long): Boolean =
        progressForeground && progressObservationToken == observationToken &&
            activeClient() === client && coordinator.activeInstanceId == instanceId &&
            coordinator.installationStore.activeInstallation?.deviceId == deviceId

    private fun isProgressCredentialRevoked(error: Throwable): Boolean {
        val serverError = error as? sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException.Server ?: return false
        return serverError.statusCode == 401 ||
            serverError.body.code == sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode.CREDENTIAL_REVOKED
    }

    private fun isProgressCapabilityDenied(error: Throwable): Boolean {
        val serverError = error as? sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException.Server ?: return false
        return serverError.statusCode == 403 &&
            serverError.body.code == sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode.CAPABILITY_DENIED
    }

    private fun clearProgressState() {
        agentRosterSelectionTicket += 1
        _taskProgress.value = null
        _agentRoster.value = null
        _selectedAgentRoster.value = null
        _agentRosterHistory.value = emptyList()
        taskEpoch = null
        taskRevision = 0L
        agentEpoch = null
        agentRevision = 0L
        currentRosterTurnId = null
        selectedRosterTurnId = null
        taskCapabilityDeniedObservationToken = null
        agentCapabilityDeniedObservationToken = null
        _progressConnectionState.value = ProgressConnectionState.UNAVAILABLE
    }

    private fun clearTaskProgressState() {
        _taskProgress.value = null
        taskEpoch = null
        taskRevision = 0L
        if (_agentRoster.value == null) _progressConnectionState.value = ProgressConnectionState.UNAVAILABLE
    }

    private fun clearAgentRosterState() {
        agentRosterSelectionTicket += 1
        _agentRoster.value = null
        _selectedAgentRoster.value = null
        _agentRosterHistory.value = emptyList()
        agentEpoch = null
        agentRevision = 0L
        currentRosterTurnId = null
        selectedRosterTurnId = null
        if (_taskProgress.value == null) _progressConnectionState.value = ProgressConnectionState.UNAVAILABLE
    }

    /** Drop cached projections as soon as the negotiated read gate disappears. */
    fun reconcileProgressAccess() {
        // A fresh /server response starts a new negotiation view. A prior
        // capability denial is scoped to the old observation and may be
        // retried after the server confirms the grant again.
        taskCapabilityDeniedObservationToken = null
        agentCapabilityDeniedObservationToken = null
        val keepTasks = canReadTaskProgress
        val keepAgents = canReadAgentRoster
        if (!keepTasks && !keepAgents) {
            clearProgressState()
            return
        }
        if (!keepTasks) {
            _taskProgress.value = null
            taskEpoch = null
            taskRevision = 0L
        }
        if (!keepAgents) {
            agentRosterSelectionTicket += 1
            _agentRoster.value = null
            _selectedAgentRoster.value = null
            _agentRosterHistory.value = emptyList()
            agentEpoch = null
            agentRevision = 0L
            currentRosterTurnId = null
            selectedRosterTurnId = null
        }
        _progressConnectionState.value = if (keepTasks || keepAgents) {
            ProgressConnectionState.IDLE
        } else {
            ProgressConnectionState.UNAVAILABLE
        }
    }

    private fun progressRetryDelay(attempt: Int): Long =
        (500L * (1L shl attempt.coerceIn(0, 5))).coerceAtMost(8_000L)

    private fun acceptTaskProgress(snapshot: AidenChatTaskProgress) {
        if (snapshot.chatId != chatId) return
        if (!AidenProgressFencing.accepts(taskEpoch, taskRevision, snapshot.epoch, snapshot.revision)) return
        if (taskEpoch != snapshot.epoch) taskRevision = 0L
        taskEpoch = snapshot.epoch
        taskRevision = snapshot.revision
        _taskProgress.value = snapshot
    }

    private fun acceptAgentRoster(snapshot: AidenChatAgentRoster, historical: Boolean = false): Boolean {
        if (snapshot.chatId != chatId) return false
        val key = AidenProgressFencing.rosterKey(snapshot.epoch, snapshot.turnId)
        if (!historical) {
            if (!AidenProgressFencing.accepts(agentEpoch, agentRevision, snapshot.epoch, snapshot.revision)) return false
            if (agentEpoch != null && agentEpoch != snapshot.epoch) {
                agentRosterSelectionTicket += 1
                _agentRosterHistory.value = emptyList()
                selectedRosterTurnId = null
                _selectedAgentRoster.value = null
                agentRevision = 0L
            }
            agentEpoch = snapshot.epoch
            agentRevision = snapshot.revision
            val previousTurnId = currentRosterTurnId
            currentRosterTurnId = snapshot.turnId
            _agentRoster.value = snapshot
            if (selectedRosterTurnId == null || selectedRosterTurnId == previousTurnId || selectedRosterTurnId == snapshot.turnId) {
                selectedRosterTurnId = snapshot.turnId
                _selectedAgentRoster.value = snapshot
            }
        } else {
            if (snapshot.epoch != agentEpoch) return false
            // A retained-turn fetch can resolve after a fresher snapshot for the
            // same turn was already applied. Revisions are ordered within an
            // epoch:turn key, so never let a late response move history or the
            // user's selected roster backwards.
            val existing = _agentRosterHistory.value.firstOrNull {
                AidenProgressFencing.rosterKey(it.epoch, it.turnId) == key
            }
            if (existing != null && !AidenProgressFencing.accepts(
                    existing.epoch, existing.revision, snapshot.epoch, snapshot.revision
                )
            ) return false
        }
        val updated = buildList {
            add(snapshot)
            addAll(_agentRosterHistory.value.filter {
                AidenProgressFencing.rosterKey(it.epoch, it.turnId) != key
            })
        }.take(MAX_AGENT_ROSTER_HISTORY)
        _agentRosterHistory.value = updated
        if (historical && selectedRosterTurnId == snapshot.turnId) {
            _selectedAgentRoster.value = snapshot
        }
        return true
    }

    /** Select a current or retained turn; an absent retained turn is fetched by opaque ID. */
    fun selectAgentRosterTurn(turnId: String?) {
        val selectionTicket = ++agentRosterSelectionTicket
        if (!canReadAgentRoster) {
            selectedRosterTurnId = null
            _selectedAgentRoster.value = null
            return
        }
        if (turnId == null) {
            selectedRosterTurnId = null
            _selectedAgentRoster.value = _agentRoster.value
            return
        }
        val cached = AidenProgressFencing.retainedRoster(
            _agentRosterHistory.value,
            agentEpoch,
            turnId
        )
        // Fence a current-turn refresh immediately, even while the selected
        // historical roster is being fetched. Otherwise its late response can
        // briefly replace the user's chosen turn in the sheet.
        selectedRosterTurnId = turnId
        _selectedAgentRoster.value = cached
        val client = activeClient() ?: return
        viewModelScope.launch {
            try {
                val roster = client.chatAgents(chatId, turnId)
                if (activeClient() !== client || coordinator.activeInstanceId != instanceId ||
                    coordinator.installationStore.activeInstallation?.deviceId != deviceId ||
                    agentRosterSelectionTicket != selectionTicket
                ) return@launch
                if (acceptAgentRoster(roster, historical = true)) {
                    selectedRosterTurnId = turnId
                    _selectedAgentRoster.value = roster
                } else {
                    // The fetch resolved to a stale snapshot: keep the newer
                    // cached roster for this turn instead of regressing it.
                    selectedRosterTurnId = turnId
                    _selectedAgentRoster.value = AidenProgressFencing.retainedRoster(
                        _agentRosterHistory.value,
                        agentEpoch,
                        turnId
                    )
                }
            } catch (error: Exception) {
                if (isProgressCredentialRevoked(error)) {
                    clearProgressState()
                    if (coordinator.installationStore.activeInstallation?.instanceId == instanceId) {
                        coordinator.removeInstallation(instanceId)
                    }
                } else if (isProgressCapabilityDenied(error)) {
                    clearAgentRosterState()
                    agentCapabilityDeniedObservationToken = progressObservationToken
                } else if (error !is CancellationException && agentRosterSelectionTicket == selectionTicket) {
                    _presentedError.value = "That agent session is no longer available."
                }
            }
        }
    }

    override fun onCleared() {
        progressForeground = false
        progressObservationToken += 1
        progressObservationJob?.cancel()
        streamJob?.cancel()
        titleRefreshJob?.cancel()
        terminalReconciliationJob?.cancel()
        super.onCleared()
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
        }
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
                    updateDraft(AidenDraftSendReconciliation.failedDraft(text, _draft.value))
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

    private var approvalSnapshotGeneration = 0L
    private data class ApprovalSnapshotRead(
        val streamId: String, val client: AidenRemoteClient,
        val approval: AidenPendingApproval?, val state: AidenStreamState?
    )
    private var approvalSnapshotInFlight: ApprovalSnapshotRead? = null

    internal suspend fun restorePendingApproval(streamId: String, isFallback: Boolean = false) {
        val client = activeClient() ?: return
        if (activeStreamId != streamId || _streamState.value?.isTerminal == true) return
        if (isFallback && approvalSnapshotInFlight?.let { it.streamId == streamId && it.client === client &&
                it.approval == _pendingApproval.value && it.state == _streamState.value } == true) return
        val snapshotGeneration = ++approvalSnapshotGeneration
        approvalSnapshotInFlight = ApprovalSnapshotRead(streamId, client, _pendingApproval.value, _streamState.value)
        val expectedApproval = _pendingApproval.value
        val expectedState = _streamState.value
        try {
            val snapshot = client.streamApproval(streamId)
            if (activeClient() !== client || activeStreamId != streamId ||
                snapshotGeneration != approvalSnapshotGeneration ||
                _pendingApproval.value != expectedApproval || _streamState.value != expectedState) return
            val approval = AidenPendingApprovalResolution.resolve(
                snapshot.approval,
                streamId = streamId,
                chatId = chatId,
                capabilities = approvalCapabilities()
            )
            if (approval != null) {
                _pendingApproval.value = approval
                _streamState.value = AidenStreamState.WAITING_FOR_APPROVAL
            } else {
                _pendingApproval.value = null
                _streamState.value = AidenStreamState.RECONCILING
            }
        } catch (_: Exception) {
            if (activeClient() !== client || activeStreamId != streamId ||
                snapshotGeneration != approvalSnapshotGeneration ||
                _pendingApproval.value != expectedApproval || _streamState.value != expectedState) return
            _pendingApproval.value = null
            _streamState.value = AidenStreamState.RECONCILING
        } finally {
            if (snapshotGeneration == approvalSnapshotGeneration) approvalSnapshotInFlight = null
        }
    }

    val canControlCurrentRun: Boolean
        get() {
            val installation = installationForProgress() ?: return false
            val currentChat = _chat.value ?: return false
            return coordinator.connectionState.value == AidenConnectionState.CONNECTED &&
                activeStreamId != null && _streamState.value?.isTerminal == false &&
                installation.hasNegotiatedAccess(AidenRemoteCapability.CHAT_WRITE) &&
                (currentChat.botId == null ||
                    (installation.hasNegotiatedAccess(AidenRemoteCapability.BOT_READ) &&
                     installation.hasNegotiatedAccess(AidenRemoteCapability.BOT_WRITE)))
        }

    fun cancelTurn() {
        if (!canControlCurrentRun || _isStopping.value) return
        val client = activeClient() ?: return
        val streamId = activeStreamId ?: return
        _isStopping.value = true
        viewModelScope.launch {
            try {
                cancelStreamOnce(client, streamId)
            } finally {
                _isStopping.value = false
            }
        }
    }

    /** Suspends until the cancel request resolves. True when the server
     * accepted the cancel for the displayed stream; false leaves the draft
     * and stream untouched so callers like Redirect can bail safely. */
    private suspend fun cancelStreamOnce(client: AidenRemoteClient, streamId: String): Boolean {
        return try {
            val status = client.cancelStream(streamId)
            if (activeClient() !== client || activeStreamId != streamId ||
                _streamState.value?.isTerminal == true) return false
            if (status.streamId != streamId || status.chatId != chatId) {
                _presentedError.value = "Stop was not confirmed. Check the current run before trying again."
                return false
            }
            apply(status, streamId)
            true
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            if (activeClient() === client && activeStreamId == streamId &&
                _streamState.value?.isTerminal != true) {
                _presentedError.value = "Stop was not confirmed. Check the current run before trying again."
            }
            false
        }
    }

    val supportsRunInput: Boolean
        get() = coordinator.serverInfo.value?.supportsChatRunInput == true

    private val isStreamingNow: Boolean
        get() = _streamState.value != null && !_streamState.value!!.isTerminal

    /** The busy composer shows Steer/Queue/Redirect only when the server
     * negotiated the feature and the composer holds text. Old servers keep
     * the Stop-only control. */
    val showsRunInputOptions: Boolean
        get() = AidenRunInputPresentation.offersRunInput(
            isStreaming = isStreamingNow,
            canControl = canControlCurrentRun,
            supports = supportsRunInput,
            hasDraft = _draft.value.trim().isNotEmpty()
        )

    val canSubmitRunInput: Boolean
        get() = showsRunInputOptions && !_isSubmittingRunInput.value && !_isStopping.value

    fun submitRunInput(mode: AidenStreamInputMode) {
        val text = _draft.value.trim()
        if (!canSubmitRunInput || text.isEmpty()) return
        val client = activeClient() ?: return
        val streamId = activeStreamId ?: return
        val key = if (AidenRunInputPresentation.reusesIdempotencyKey(
                lastRunInputAttempt, streamId, mode, text
            )) lastRunInputAttempt!!.key else UUID.randomUUID()
        val attempt = AidenRunInputPresentation.Attempt(key, streamId, mode, text)
        lastRunInputAttempt = attempt
        _isSubmittingRunInput.value = true
        viewModelScope.launch {
            try {
                val result = client.submitStreamInput(
                    id = streamId,
                    input = AidenStreamInputRequest(mode = mode, text = text),
                    idempotencyKey = key
                )
                if (activeClient() !== client) return@launch
                // The response must bind to the stream that was displayed when
                // the submission left; a mismatched receipt is never trusted.
                if (result.streamId != streamId || result.chatId != chatId) {
                    _presentedError.value =
                        "The run input was not confirmed. Your draft is unchanged — check the chat before trying again."
                    return@launch
                }
                if (lastRunInputAttempt == attempt) lastRunInputAttempt = null
                if (AidenRunInputPresentation.consumesDraft(result)) {
                    consumeRunInputDraft(text)
                    AidenRunInputPresentation.receipt(result)?.let { showRunInputReceipt(it) }
                    // The Mac persisted the message before queue admission;
                    // pull it into the transcript without waiting for the
                    // next turn.
                    reconcileChat()
                } else {
                    _presentedError.value = AidenRunInputPresentation.rejectionMessage(result.reason)
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (activeClient() === client) {
                    _presentedError.value =
                        "The run input was not confirmed. Your draft is unchanged — check the chat before trying again."
                }
            } finally {
                _isSubmittingRunInput.value = false
            }
        }
    }

    /** Destructive: stop the current run, then send the composer contents as
     * a new turn once the stream is confirmed terminal. The draft is only
     * consumed by the new send; a failed cancel leaves it untouched. */
    fun redirectRun() {
        if (!canControlCurrentRun || _isStopping.value || _isSubmittingRunInput.value) return
        val client = activeClient() ?: return
        val streamId = activeStreamId ?: return
        _isStopping.value = true
        viewModelScope.launch {
            try {
                if (!cancelStreamOnce(client, streamId)) return@launch
                var waited = 0
                while (isStreamingNow && activeStreamId == streamId && waited < 50) {
                    delay(100)
                    waited++
                }
                if (activeClient() !== client) return@launch
                if (isStreamingNow) {
                    _presentedError.value =
                        "The run is still stopping. Send your message once it finishes."
                    return@launch
                }
                send()
            } finally {
                _isStopping.value = false
            }
        }
    }

    private fun consumeRunInputDraft(text: String) {
        val remaining = AidenRunInputPresentation.consumedDraft(text, _draft.value)
        if (remaining != _draft.value) {
            _draft.value = remaining
            draftSession?.let { draftStore.save(remaining, it) }
        }
    }

    private fun showRunInputReceipt(text: String) {
        runInputReceiptToken++
        val token = runInputReceiptToken
        _runInputReceipt.value = text
        viewModelScope.launch {
            delay(4000)
            if (runInputReceiptToken == token) _runInputReceipt.value = null
        }
    }

    fun stop() {
        cancelTurn()
    }

    fun respondToApproval(decision: AidenApprovalDecision, approvalId: String) {
        if (isReadOnlyPresentation || coordinator.connectionState.value != AidenConnectionState.CONNECTED ||
            _isRespondingToApproval.value || _isStopping.value) return
        val approval = _pendingApproval.value ?: return
        if (approval.id != approvalId) return
        if (!approval.expiresAt.isAfter(Instant.now())) {
            _pendingApproval.value = null
            return
        }
        val capabilities = approvalCapabilities()
        if (!capabilities.canRespond) {
            _presentedError.value = "This paired device can review approvals but cannot respond."
            refreshApprovalAccess()
            return
        }
        val canCurrentlyAllow = approval.hostCanAllow &&
                (!AidenApprovalPresentation.isAutomation(approval.toolName) || capabilities.canWriteSchedules)
        if (decision == AidenApprovalDecision.ALLOW && !canCurrentlyAllow) {
            _presentedError.value = if (AidenApprovalPresentation.isAutomation(approval.toolName)) {
                if (!capabilities.canWriteSchedules) {
                    "Schedule write access is required to approve this task."
                } else {
                    "Confirm this automation in Aiden on your Mac after reviewing its full access scope."
                }
            } else {
                "This action must be confirmed in Aiden on your Mac."
            }
            refreshApprovalAccess()
            return
        }
        val client = activeClient() ?: return
        val streamId = activeStreamId ?: return
        _isRespondingToApproval.value = true
        _pendingApproval.value = null
        _streamState.value = AidenStreamState.RUNNING

        viewModelScope.launch {
            try {
                val response = client.respondToApproval(approval.id, decision)
                if (activeClient() !== client || activeStreamId != streamId ||
                    _streamState.value?.isTerminal == true) return@launch
                if (response.approvalId != approval.id || response.decision != decision) {
                    _presentedError.value = "The approval response was not confirmed. Refreshing the current request from your Mac."
                    if (_pendingApproval.value == null) restorePendingApproval(streamId, isFallback = true)
                }
            } catch (e: Exception) {
                if (e !is CancellationException && activeClient() === client && activeStreamId == streamId &&
                    _streamState.value?.isTerminal != true) {
                    _presentedError.value = "The approval response was not confirmed. Refreshing the current request from your Mac."
                    // An ambiguous write may have succeeded; only the Mac can restore a card.
                    if (_pendingApproval.value == null) restorePendingApproval(streamId, isFallback = true)
                }
            } finally {
                _isRespondingToApproval.value = false
            }
        }
    }

    private fun refreshApprovalAccess() {
        val streamId = activeStreamId ?: return
        _isRespondingToApproval.value = true
        _pendingApproval.value = null
        _streamState.value = AidenStreamState.RECONCILING
        viewModelScope.launch {
            try { restorePendingApproval(streamId) }
            finally { _isRespondingToApproval.value = false }
        }
    }

    private fun approvalCapabilities(): AidenApprovalCapabilities {
        val installation = coordinator.installationStore.activeInstallation
        if (_chat.value == null || coordinator.activeInstanceId != instanceId ||
            installation?.instanceId != instanceId || installation.deviceId != deviceId
        ) {
            return AidenApprovalCapabilities(canRespond = false, canWriteSchedules = false)
        }
        return AidenApprovalCapabilities(
            canRespond = installation.hasNegotiatedAccess(AidenRemoteCapability.APPROVAL_RESPOND) &&
                (_chat.value?.botId == null ||
                    (installation.hasNegotiatedAccess(AidenRemoteCapability.BOT_READ) &&
                     installation.hasNegotiatedAccess(AidenRemoteCapability.BOT_WRITE))),
            canWriteSchedules = installation.hasNegotiatedAccess(AidenRemoteCapability.SCHEDULE_WRITE)
        )
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
        private const val MAX_AGENT_ROSTER_HISTORY = 8

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
