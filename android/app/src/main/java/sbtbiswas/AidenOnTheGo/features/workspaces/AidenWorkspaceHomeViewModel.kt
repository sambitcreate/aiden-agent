package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.combine
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.scheduled.AidenScheduledRunIdempotencyKeys
import sbtbiswas.AidenOnTheGo.features.shared.AidenRevalidation
import sbtbiswas.AidenOnTheGo.models.AidenChat
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageChange
import sbtbiswas.AidenOnTheGo.models.AidenScheduledTask
import sbtbiswas.AidenOnTheGo.models.AidenModelCatalog
import sbtbiswas.AidenOnTheGo.models.AidenUsageSummary
import sbtbiswas.AidenOnTheGo.models.AidenWorkspace
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenUsageCache
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import java.time.Duration
import java.time.Instant

enum class AidenChatListLoadState {
    UNRESOLVED,
    LOADING,
    LOADED,
    FAILED
}

class AidenWorkspaceHomeViewModel(
    private val coordinator: AidenRemoteCoordinator,
    private val chatCache: AidenChatCache,
    private val usageCache: AidenUsageCache = coordinator.usageCache,
    private val cacheWriteDispatcher: CoroutineDispatcher = Dispatchers.IO
) : ViewModel() {
    private val _chats = MutableStateFlow<List<AidenChatSummary>>(emptyList())
    val chats: StateFlow<List<AidenChatSummary>> = _chats.asStateFlow()

    private val _inboxNotice = MutableStateFlow<AidenInboxNotice?>(null)
    /** The Inbox snackbar after a swipe: a confirmation with Undo, or a rollback. */
    val inboxNotice: StateFlow<AidenInboxNotice?> = _inboxNotice.asStateFlow()

    /** The row fields an Inbox swipe writes. */
    private enum class TriageField { PINNED, DONE, SNOOZE, REVISION, UNREAD }

    /**
     * An Inbox swipe's row, kept over list pages that may predate it: a load
     * already in flight when the row moved carries the host's older triage.
     * Only the [fields] the swipe's writes changed are kept, so a Mark read
     * never hides a pin made on another device. [token] orders it against
     * loads; while unsettled it holds over every page, and once the host
     * answered ([settled]) only over pages requested before its last write.
     */
    private data class TriageOverlay(
        val token: Long,
        val row: AidenChatSummary,
        val fields: Set<TriageField>,
        val settled: Boolean = false
    )
    // Read under the cache lock by a page save (see acceptSummaryPage), so
    // every access holds this map's monitor.
    private val triageOverlay = mutableMapOf<String, TriageOverlay>()
    private val triageWritesInFlight = mutableMapOf<String, Int>()
    /** Bumped on each host switch, so a write from before it settles nothing here. */
    private var triageGeneration = 0L
    /** Changes each time a chat is viewed ([accept]); see [AidenInboxTriage]. */
    private val viewStamps = mutableMapOf<String, Long>()
    private var viewClock = 0L

    private val _scheduledTasks = MutableStateFlow<List<AidenScheduledTask>>(emptyList())
    val scheduledTasks: StateFlow<List<AidenScheduledTask>> = _scheduledTasks.asStateFlow()

    private val _usage = MutableStateFlow<AidenUsageSummary?>(null)
    val usage: StateFlow<AidenUsageSummary?> = _usage.asStateFlow()

    private val _modelCatalog = MutableStateFlow<AidenModelCatalog?>(null)
    val modelCatalog: StateFlow<AidenModelCatalog?> = _modelCatalog.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private val _chatLoadErrorMessage = MutableStateFlow<String?>(null)
    val chatLoadErrorMessage: StateFlow<String?> = _chatLoadErrorMessage.asStateFlow()

    private val _chatListLoadState = MutableStateFlow(AidenChatListLoadState.UNRESOLVED)
    val chatListLoadState: StateFlow<AidenChatListLoadState> = _chatListLoadState.asStateFlow()

    private val _nextChatCursor = MutableStateFlow<String?>(null)
    val nextChatCursor: StateFlow<String?> = _nextChatCursor.asStateFlow()

    private val _isLoadingMoreChats = MutableStateFlow(false)
    val isLoadingMoreChats: StateFlow<Boolean> = _isLoadingMoreChats.asStateFlow()

    private val _chatPaginationErrorMessage = MutableStateFlow<String?>(null)
    val chatPaginationErrorMessage: StateFlow<String?> = _chatPaginationErrorMessage.asStateFlow()

    private val _usageErrorMessage = MutableStateFlow<String?>(null)
    val usageErrorMessage: StateFlow<String?> = _usageErrorMessage.asStateFlow()

    private var loadedClient: AidenRemoteClient? = null
    private var loadedInstanceId: String? = null
    private var loadingClient: AidenRemoteClient? = null
    private var loadingJob: Job? = null
    private var paginationJob: Job? = null
    private var loadGeneration = 0
    private var hydratedInstanceId: String? = null
    private var hydratedWorkspaceIds: Set<String> = emptySet()
    private var hydratedCanReadSchedules: Boolean? = null
    private var paginationBoundary: AidenChatSummary? = null
    private var lastLoadedAtMillis: Long? = null
    private val pendingRunKeysByInstance = mutableMapOf<String, AidenScheduledRunIdempotencyKeys>()

    fun pendingScheduledRunKeys(instanceId: String): AidenScheduledRunIdempotencyKeys =
        pendingRunKeysByInstance.getOrPut(instanceId) { AidenScheduledRunIdempotencyKeys() }

    init {
        viewModelScope.launch {
            chatCache.summaries.collect { cachedByInstance ->
                val instanceId = hydratedInstanceId ?: return@collect
                if (instanceId != coordinator.activeInstanceId) return@collect
                _chats.value = regularNewestFirst(
                    cachedByInstance[instanceId]
                        ?.values
                        ?.filter { it.workspaceId in hydratedWorkspaceIds }
                        .orEmpty()
                )
            }
        }
        viewModelScope.launch {
            combine(
                coordinator.workspaces,
                coordinator.client,
                coordinator.connectionState
            ) { workspaces, client, connectionState -> Triple(workspaces, client, connectionState) }
                .collect { (workspaces, client, connectionState) ->
                    hydrate(workspaces)
                    if (client != null && connectionState == AidenConnectionState.CONNECTED) load()
                }
        }
    }

    suspend fun hydrate(workspaces: List<AidenWorkspace>) {
        val instanceId = coordinator.activeInstanceId ?: return
        val workspaceIds = workspaces.map { it.id }.toSet()
        val canReadSchedules = coordinator.installationStore.activeInstallation
            ?.hasNegotiatedAccess(AidenRemoteCapability.SCHEDULE_READ) == true
        if (hydratedInstanceId == instanceId && hydratedWorkspaceIds == workspaceIds &&
            hydratedCanReadSchedules == canReadSchedules
        ) return

        if (hydratedInstanceId != instanceId) {
            lastLoadedAtMillis = null
            loadGeneration += 1
            loadedClient = null
            loadedInstanceId = null
            loadingClient = null
            loadingJob?.cancel()
            loadingJob = null
            paginationJob?.cancel()
            paginationJob = null
            _isLoading.value = false
            _isLoadingMoreChats.value = false
            _chatListLoadState.value = AidenChatListLoadState.UNRESOLVED
            _nextChatCursor.value = null
            _chatPaginationErrorMessage.value = null
            paginationBoundary = null
            // A notice or a pending swipe belongs to the host it was made on.
            _inboxNotice.value = null
            synchronized(triageOverlay) { triageOverlay.clear() }
            triageWritesInFlight.clear()
            triageGeneration += 1
        }

        val cached = withContext(Dispatchers.IO) { chatCache.loadSummaries(instanceId) }
            .orEmpty()
            .filter { it.workspaceId in workspaceIds }
        if (coordinator.activeInstanceId != instanceId) return
        _chats.value = regularNewestFirst(cached)
        _scheduledTasks.value = if (canReadSchedules) {
            coordinator.scheduledCache.loadForScheduleReadAccess(instanceId, canRead = true)?.tasks.orEmpty()
        } else {
            coordinator.scheduledCache.loadForScheduleReadAccess(instanceId, canRead = false)
            emptyList()
        }
        _usage.value = usageCache.load(instanceId)
        _chatLoadErrorMessage.value = null
        _errorMessage.value = null
        hydratedInstanceId = instanceId
        hydratedWorkspaceIds = workspaceIds
        hydratedCanReadSchedules = canReadSchedules
        loadedClient = null
    }

    fun load(force: Boolean = false) {
        val client = coordinator.client.value ?: return
        val instanceId = coordinator.activeInstanceId ?: return
        if (loadingClient === client && !force) return
        if (!force && loadedClient === client && loadedInstanceId == instanceId) return
        loadingJob?.cancel()
        paginationJob?.cancel()
        paginationJob = null
        _isLoadingMoreChats.value = false
        val requestGeneration = ++loadGeneration
        loadingClient = client

        val chatWriteToken = chatCache.reserveSummaryMutation(instanceId)
        val previouslyLoaded = _chatListLoadState.value == AidenChatListLoadState.LOADED
        loadingJob = viewModelScope.launch {
            _isLoading.value = true
            _errorMessage.value = null
            _chatLoadErrorMessage.value = null
            _chatListLoadState.value = AidenChatListLoadState.LOADING
            _chatPaginationErrorMessage.value = null
            try {
                var allCoreSucceeded = false
                supervisorScope {
                    val scheduleReadAllowed = coordinator.installationStore.activeInstallation
                        ?.hasNegotiatedAccess(AidenRemoteCapability.SCHEDULE_READ) == true
                    val chatsRequest = async {
                        request {
                            client.preferredChatSummaryPage(
                                supportsChatSummaries = coordinator.serverInfo.value?.supportsChatSummaries == true
                            )
                        }
                    }
                    val tasksRequest = async {
                        if (scheduleReadAllowed) request { client.scheduledTasks() }
                        else Result.success(emptyList<AidenScheduledTask>())
                    }
                    val usageRequest = async { request { client.usage() } }
                    val catalogRequest = async { request { client.modelCatalog() } }

                    val chatsResult = chatsRequest.await().mapCatching { accepted ->
                        if (isCurrentLoad(requestGeneration, client, instanceId)) {
                            acceptSummaryPage(accepted.summaries, replace = true, instanceId, chatWriteToken) {
                                isCurrentLoad(requestGeneration, client, instanceId)
                            }
                            _nextChatCursor.value = accepted.nextCursor
                            _chatLoadErrorMessage.value = null
                            _chatListLoadState.value = AidenChatListLoadState.LOADED
                        }
                        accepted
                    }
                    chatsResult
                        .onFailure { failure ->
                            if (isCurrentLoad(requestGeneration, client, instanceId)) {
                                _chatLoadErrorMessage.value =
                                    failure.message ?: "Aiden couldn't load chats."
                                _chatListLoadState.value = if (previouslyLoaded) AidenChatListLoadState.LOADED else AidenChatListLoadState.FAILED
                            }
                        }
                    val tasksResult = tasksRequest.await()
                    tasksResult.onSuccess { accepted ->
                        if (isCurrentLoad(requestGeneration, client, instanceId)) {
                            val canStillReadSchedules =
                                coordinator.installationStore.activeInstallation
                                    ?.hasNegotiatedAccess(AidenRemoteCapability.SCHEDULE_READ) == true
                            if (canStillReadSchedules) {
                                _scheduledTasks.value = accepted
                                coordinator.scheduledCache.store(instanceId, accepted, settings = null)
                            } else {
                                coordinator.scheduledCache.loadForScheduleReadAccess(
                                    instanceId,
                                    canRead = false
                                )
                                _scheduledTasks.value = emptyList()
                            }
                        }
                    }
                    val usageResult = usageRequest.await()
                    usageResult
                        .onSuccess { accepted ->
                            if (isCurrentLoad(requestGeneration, client, instanceId)) {
                                _usage.value = accepted
                                usageCache.store(instanceId, accepted)
                                _usageErrorMessage.value = null
                            }
                        }
                        .onFailure { failure ->
                            if (isCurrentLoad(requestGeneration, client, instanceId)) {
                                _usageErrorMessage.value = failure.message ?: "Aiden couldn't load Usage."
                            }
                        }
                    val catalogResult = catalogRequest.await()
                    catalogResult.onSuccess { accepted ->
                        if (isCurrentLoad(requestGeneration, client, instanceId)) {
                            _modelCatalog.value = accepted
                        }
                    }

                    val failures = listOf(chatsResult, tasksResult, usageResult)
                        .mapNotNull { it.exceptionOrNull() }
                    if (failures.size == 3) {
                        if (isCurrentLoad(requestGeneration, client, instanceId)) {
                            _errorMessage.value = failures.firstOrNull()?.message
                                ?: "Aiden couldn't refresh Workspace data."
                        }
                    }
                    allCoreSucceeded = failures.isEmpty()
                }
                if (isCurrentLoad(requestGeneration, client, instanceId) && allCoreSucceeded) {
                    loadedClient = client
                    loadedInstanceId = instanceId
                    lastLoadedAtMillis = System.currentTimeMillis()
                }
            } finally {
                if (isCurrentLoad(requestGeneration, client, instanceId)) {
                    loadingClient = null
                    loadingJob = null
                    _isLoading.value = false
                }
            }
        }
    }

    /**
     * Rereads chats, tasks and Usage when the home comes back to the foreground after
     * [AidenRevalidation.STALE_AFTER_MILLIS]. Saved rows stay on screen meanwhile.
     */
    fun revalidate(nowMillis: Long = System.currentTimeMillis()) {
        if (coordinator.connectionState.value != AidenConnectionState.CONNECTED) return
        if (!AidenRevalidation.isDue(lastLoadedAtMillis, nowMillis, inFlight = loadingClient != null)) return
        load(force = true)
    }

    fun refresh(workspaces: List<AidenWorkspace>) {
        viewModelScope.launch {
            hydrate(workspaces)
            load(force = true)
        }
    }

    fun accept(chat: AidenChat) {
        // An accepted chat is the one being viewed, so its row is read (and no
        // longer says Failed); the next summary refresh restores server flags.
        val existing = _chats.value.firstOrNull { it.id == chat.id }
        val admitted = AidenChatSummary.fromChat(chat).copy(rowStateWire = existing?.rowStateWire)
        val summary = existing?.let(admitted::withInboxSignals)?.admittingReplies(chat) ?: admitted
        viewStamps[chat.id] = ++viewClock
        _chats.value = regularNewestFirst(_chats.value.filterNot { it.id == summary.id } + summary)
        coordinator.activeInstanceId?.let { instanceId ->
            val writeToken = chatCache.reserveSummaryMutation(instanceId)
            viewModelScope.launch(cacheWriteDispatcher) { runCatching { chatCache.saveChat(chat, instanceId, writeToken) } }
        }
    }

    fun dismissInboxNotice(id: java.util.UUID? = null) {
        if (id == null || _inboxNotice.value?.id == id) _inboxNotice.value = null
    }

    private fun inboxTriage(): AidenInboxTriage? {
        val client = coordinator.client.value ?: return null
        val instanceId = coordinator.activeInstanceId ?: return null
        val isCurrent = { coordinator.activeInstanceId == instanceId && coordinator.client.value === client }
        val generation = triageGeneration
        return AidenInboxTriage(
            // After a switch the write still settles on the host it was sent
            // to, from that host's saved row: even back on the same host, the
            // list may now show a newer swipe's optimistic fields.
            row = { id ->
                (if (coordinator.activeInstanceId == instanceId && triageGeneration == generation) {
                    _chats.value.firstOrNull { it.id == id }
                } else null) ?: chatCache.summaries.value[instanceId]?.get(id)
            },
            publish = { row ->
                if (coordinator.activeInstanceId == instanceId && triageGeneration == generation) {
                    val previous = _chats.value.firstOrNull { it.id == row.id }
                    synchronized(triageOverlay) {
                        val fields = triageFieldsChanged(previous, row) + triageOverlay[row.id]?.fields.orEmpty()
                        triageOverlay[row.id] = TriageOverlay(chatCache.reserveChatWrite(), row, fields)
                    }
                    _chats.value = regularNewestFirst(_chats.value.map { if (it.id == row.id) row else it })
                }
                withContext(cacheWriteDispatcher) {
                    runCatching { chatCache.upsertSummary(row, instanceId, keepsWriteOrder = true) }
                }
            },
            isCurrent = isCurrent,
            writeTriage = { id, change, ifRevision, key -> client.setChatTriage(id, change, ifRevision, key) },
            writeRead = { id -> client.markChatRead(id) },
            reload = { load(force = true) },
            viewStamp = { id -> viewStamps[id] ?: 0L }
        )
    }

    private suspend fun <T> trackingTriageWrite(chatId: String, write: suspend () -> T): T {
        val generation = triageGeneration
        triageWritesInFlight[chatId] = (triageWritesInFlight[chatId] ?: 0) + 1
        try {
            return write()
        } finally {
            // After a host switch the counts belong to the new host's writes.
            if (generation == triageGeneration) {
                val left = (triageWritesInFlight[chatId] ?: 1) - 1
                if (left > 0) triageWritesInFlight[chatId] = left
                else {
                    triageWritesInFlight.remove(chatId)
                    synchronized(triageOverlay) {
                        triageOverlay[chatId]?.let { triageOverlay[chatId] = it.copy(settled = true) }
                    }
                }
            }
        }
    }

    fun markInboxRead(chatId: String) {
        val triage = inboxTriage() ?: return
        viewModelScope.launch {
            trackingTriageWrite(chatId) { triage.markRead(chatId) }?.let { _inboxNotice.value = it }
        }
    }

    /** Done, Snooze or an Undo. Undo itself offers no further Undo. */
    fun setInboxTriage(chatId: String, change: AidenChatTriageChange, isOpen: Boolean = false, offersUndo: Boolean = true) {
        val triage = inboxTriage() ?: return
        _inboxNotice.value = null
        viewModelScope.launch {
            trackingTriageWrite(chatId) {
                triage.setTriage(
                    chatId,
                    change,
                    readsFailures = coordinator.serverInfo.value?.supportsChatReadState == true,
                    isOpen = isOpen,
                    offersUndo = offersUndo
                )
            }?.let { _inboxNotice.value = it }
        }
    }

    /**
     * A page row with an Inbox swipe that may be newer kept over it: an
     * unsettled swipe always, a settled one only over a page requested
     * before its last write. Only the fields the swipe changed come from it;
     * unread stays read once either says so. Holds the overlay's monitor.
     */
    private fun overlayingTriage(page: AidenChatSummary, writeToken: Long): AidenChatSummary {
        val overlay = synchronized(triageOverlay) { triageOverlay[page.id] }
            ?.takeIf { !it.settled || it.token > writeToken } ?: return page
        val swipe = overlay.row
        var merged = page
        for (field in overlay.fields) merged = when (field) {
            TriageField.PINNED -> merged.copy(pinnedAt = swipe.pinnedAt)
            TriageField.DONE -> merged.copy(doneAt = swipe.doneAt)
            TriageField.SNOOZE -> merged.copy(snoozedUntil = swipe.snoozedUntil)
            TriageField.REVISION -> merged.copy(triageRevision = swipe.triageRevision)
            TriageField.UNREAD -> merged.copy(unread = page.unread && swipe.unread)
        }
        return if (merged == page) page else merged.withoutHostPlacement()
    }

    private fun triageFieldsChanged(previous: AidenChatSummary?, row: AidenChatSummary): Set<TriageField> {
        if (previous == null) return TriageField.entries.toSet()
        return buildSet {
            if (previous.pinnedAt != row.pinnedAt) add(TriageField.PINNED)
            if (previous.doneAt != row.doneAt) add(TriageField.DONE)
            if (previous.snoozedUntil != row.snoozedUntil) add(TriageField.SNOOZE)
            if (previous.triageRevision != row.triageRevision) add(TriageField.REVISION)
            if (previous.unread != row.unread) add(TriageField.UNREAD)
        }
    }

    fun loadMoreChats() {
        val cursor = _nextChatCursor.value ?: return
        val client = coordinator.client.value ?: return
        val instanceId = coordinator.activeInstanceId ?: return
        if (_isLoadingMoreChats.value || _chatListLoadState.value != AidenChatListLoadState.LOADED) return
        val requestGeneration = loadGeneration
        paginationJob?.cancel()
        val writeToken = chatCache.reserveSummaryMutation(instanceId)
        paginationJob = viewModelScope.launch {
            _isLoadingMoreChats.value = true
            _chatPaginationErrorMessage.value = null
            try {
                val accepted = client.preferredChatSummaryPage(
                    supportsChatSummaries = true,
                    cursor = cursor
                )
                if (!isCurrentPagination(requestGeneration, client, instanceId, cursor)) return@launch
                if (accepted.usedLegacyEndpoint || accepted.nextCursor == cursor) {
                    throw AidenRemoteContractException.InvalidJson("Invalid Chat Summary pagination response")
                }
                acceptSummaryPage(accepted.summaries, replace = false, instanceId, writeToken) {
                    isCurrentPagination(requestGeneration, client, instanceId, cursor)
                }
                _nextChatCursor.value = accepted.nextCursor
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (isCurrentPagination(requestGeneration, client, instanceId, cursor)) {
                    _chatPaginationErrorMessage.value = error.message ?: "Aiden couldn't load more chats."
                }
            } finally {
                if (loadGeneration == requestGeneration && coordinator.client.value === client &&
                    coordinator.activeInstanceId == instanceId
                ) {
                    _isLoadingMoreChats.value = false
                    paginationJob = null
                }
            }
        }
    }

    private suspend fun acceptSummaryPage(
        summaries: List<AidenChatSummary>, replace: Boolean, instanceId: String,
        writeToken: Long, isCurrent: () -> Boolean
    ) {
        val existing = if (replace) emptyList() else _chats.value
        if (!replace && summaries.any { summary -> existing.any { it.id == summary.id } }) {
            throw AidenRemoteContractException.InvalidJson("Duplicate Chat Summary across pages")
        }
        val boundary = if (replace) null else paginationBoundary
        val first = summaries.firstOrNull()
        if (!replace && boundary != null && first != null &&
            (first.updatedAt.isAfter(boundary.updatedAt) ||
                (first.updatedAt == boundary.updatedAt && first.id < boundary.id))
        ) {
            throw AidenRemoteContractException.InvalidJson("Chat Summary pages are out of order")
        }
        // A page requested after a swipe settled already carries it.
        synchronized(triageOverlay) {
            triageOverlay.entries.removeAll { (_, swipe) -> swipe.settled && swipe.token < writeToken }
        }
        val accepted = regularNewestFirst(existing + summaries.map { overlayingTriage(it, writeToken) })
        // Persist first so a bounded-cache failure leaves the visible list,
        // page boundary, and cursor unchanged and Retry can request the same page.
        // The overlay is applied again under the cache lock: a swipe that
        // lands while this save waits must not be written over.
        val retained = withContext(cacheWriteDispatcher) {
            chatCache.saveSummaries(
                accepted,
                instanceId,
                unchangedPrefixCount = if (replace) 0 else existing.size,
                writeToken = writeToken,
                merge = { rows -> rows.map { overlayingTriage(it, writeToken) } }
            )
        }
        if (!isCurrent()) throw CancellationException("Chat list owner changed")
        if (!retained || !chatCache.isSummaryWriteRetained(instanceId, writeToken)) {
            throw IllegalStateException("Chats changed while loading. Refresh and try again.")
        }
        paginationBoundary = summaries.lastOrNull() ?: boundary
        // A swipe made after the save, whose own cache write is still on its
        // way, is not in the saved rows yet.
        _chats.value = regularNewestFirst(
            chatCache.summaries.value[instanceId]?.values.orEmpty().map { overlayingTriage(it, writeToken) }
        )
            .filter { it.workspaceId in coordinator.workspaces.value.map(AidenWorkspace::id).toSet() }
    }

    private suspend fun <T> request(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        Result.failure(error)
    }

    private fun isCurrentLoad(
        generation: Int,
        client: AidenRemoteClient,
        instanceId: String
    ): Boolean = loadGeneration == generation &&
        loadingClient === client &&
        coordinator.client.value === client &&
        coordinator.activeInstanceId == instanceId

    private fun isCurrentPagination(
        generation: Int,
        client: AidenRemoteClient,
        instanceId: String,
        cursor: String
    ): Boolean = loadGeneration == generation &&
        coordinator.client.value === client &&
        coordinator.activeInstanceId == instanceId &&
        _nextChatCursor.value == cursor

    companion object {
        fun factory(
            coordinator: AidenRemoteCoordinator,
            chatCache: AidenChatCache
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return AidenWorkspaceHomeViewModel(coordinator, chatCache) as T
            }
        }
    }
}

fun regularNewestFirst(chats: List<AidenChatSummary>): List<AidenChatSummary> =
    chats
        .distinctBy { it.id }
        .sortedWith(compareByDescending<AidenChatSummary> { it.updatedAt }.thenBy { it.id })

data class AidenWorkspaceSidebarSection(
    val workspace: AidenWorkspace,
    val chats: List<AidenChatSummary>,
    val newestActivityAt: Instant
)

data class AidenWorkspaceSidebarProjection(
    val sections: List<AidenWorkspaceSidebarSection>,
    val recents: List<AidenChatSummary>
)

fun projectAidenWorkspaceSidebar(
    workspaces: List<AidenWorkspace>,
    chats: List<AidenChatSummary>,
    searchQuery: String
): AidenWorkspaceSidebarProjection {
    val query = searchQuery.trim()
    val workspacesById = workspaces.associateBy { it.id }
    // By workspace and Recent sort plainly by recency, as on the desktop;
    // attention ordering belongs to the Inbox organization.
    val regularChats = regularNewestFirst(chats).filter { workspacesById.containsKey(it.workspaceId) }
    val chatsByWorkspace = regularChats.groupBy { it.workspaceId }
    val sections = workspaces.mapNotNull { workspace ->
        val allChats = chatsByWorkspace[workspace.id].orEmpty()
        val workspaceMatches = query.isNotEmpty() && workspace.name.contains(query, ignoreCase = true)
        val visibleChats = when {
            query.isEmpty() || workspaceMatches -> allChats
            else -> allChats.filter { it.title.contains(query, ignoreCase = true) }
        }
        if (query.isNotEmpty() && !workspaceMatches && visibleChats.isEmpty()) return@mapNotNull null
        AidenWorkspaceSidebarSection(
            workspace = workspace,
            chats = visibleChats,
            newestActivityAt = maxOf(
                workspace.updatedAt ?: Instant.EPOCH,
                allChats.maxOfOrNull { it.updatedAt } ?: Instant.EPOCH
            )
        )
    }.sortedWith(
        compareByDescending<AidenWorkspaceSidebarSection> { it.newestActivityAt }
            .thenBy { it.workspace.name.lowercase() }
            .thenBy { it.workspace.id }
    )
    val recents = regularChats.filter { chat ->
        query.isEmpty() ||
            chat.title.contains(query, ignoreCase = true) ||
            workspacesById[chat.workspaceId]?.name?.contains(query, ignoreCase = true) == true
    }
    return AidenWorkspaceSidebarProjection(sections, recents)
}

fun aidenRelativeTimestamp(updatedAt: Instant, now: Instant = Instant.now()): String {
    val seconds = Duration.between(updatedAt, now).seconds.coerceAtLeast(0)
    return when {
        seconds < 60 -> "just now"
        seconds < 3_600 -> "${seconds / 60}m"
        seconds < 86_400 -> "${seconds / 3_600}h"
        else -> "${seconds / 86_400}d"
    }
}
