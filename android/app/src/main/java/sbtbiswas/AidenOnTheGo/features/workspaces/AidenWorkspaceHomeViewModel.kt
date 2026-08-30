package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.combine
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.models.AidenChat
import sbtbiswas.AidenOnTheGo.models.AidenScheduledTask
import sbtbiswas.AidenOnTheGo.models.AidenModelCatalog
import sbtbiswas.AidenOnTheGo.models.AidenUsageSummary
import sbtbiswas.AidenOnTheGo.models.AidenWorkspace
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenUsageCache
import java.time.Duration
import java.time.Instant

class AidenWorkspaceHomeViewModel(
    private val coordinator: AidenRemoteCoordinator,
    private val chatCache: AidenChatCache,
    private val usageCache: AidenUsageCache = coordinator.usageCache
) : ViewModel() {
    private val _chats = MutableStateFlow<List<AidenChat>>(emptyList())
    val chats: StateFlow<List<AidenChat>> = _chats.asStateFlow()

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

    private val _usageErrorMessage = MutableStateFlow<String?>(null)
    val usageErrorMessage: StateFlow<String?> = _usageErrorMessage.asStateFlow()

    private var loadedClient: AidenRemoteClient? = null
    private var loadingClient: AidenRemoteClient? = null
    private var hydratedInstanceId: String? = null
    private var hydratedWorkspaceIds: Set<String> = emptySet()

    init {
        viewModelScope.launch {
            chatCache.chats.collect { cachedById ->
                if (cachedById.isEmpty()) return@collect
                val merged = _chats.value.associateBy { it.id }.toMutableMap()
                cachedById.values
                    .filter { chat ->
                        !chat.isBotChat &&
                            hydratedInstanceId == coordinator.activeInstanceId &&
                            chat.workspaceId in hydratedWorkspaceIds
                    }
                    .forEach { merged[it.id] = it }
                _chats.value = regularNewestFirst(merged.values.toList())
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

    fun hydrate(workspaces: List<AidenWorkspace>) {
        val instanceId = coordinator.activeInstanceId ?: return
        val workspaceIds = workspaces.map { it.id }.toSet()
        if (hydratedInstanceId == instanceId && hydratedWorkspaceIds == workspaceIds) return

        val cached = workspaces.flatMap { workspace ->
            chatCache.loadChats(instanceId, workspace.id).orEmpty()
        }
        _chats.value = regularNewestFirst(cached)
        _scheduledTasks.value = coordinator.scheduledCache.load(instanceId)?.tasks.orEmpty()
        _usage.value = usageCache.load(instanceId)
        hydratedInstanceId = instanceId
        hydratedWorkspaceIds = workspaceIds
    }

    fun load(force: Boolean = false) {
        val client = coordinator.client.value ?: return
        if (loadingClient === client) return
        if (!force && loadedClient === client) return
        loadingClient = client

        viewModelScope.launch {
            _isLoading.value = _chats.value.isEmpty()
            _errorMessage.value = null
            try {
                var allCoreSucceeded = false
                supervisorScope {
                    val chatsRequest = async { request { client.chats() } }
                    val tasksRequest = async { request { client.scheduledTasks() } }
                    val usageRequest = async { request { client.usage() } }
                    val catalogRequest = async { request { client.modelCatalog() } }

                    chatsRequest.await().onSuccess { accepted ->
                        if (coordinator.client.value === client) acceptChats(accepted)
                    }
                    tasksRequest.await().onSuccess { accepted ->
                        if (coordinator.client.value === client) {
                            _scheduledTasks.value = accepted
                            coordinator.activeInstanceId?.let { instanceId ->
                                coordinator.scheduledCache.store(instanceId, accepted, settings = null)
                            }
                        }
                    }
                    val usageResult = usageRequest.await()
                    usageResult
                        .onSuccess { accepted ->
                            if (coordinator.client.value === client) {
                                _usage.value = accepted
                                coordinator.activeInstanceId?.let { usageCache.store(it, accepted) }
                                _usageErrorMessage.value = null
                            }
                        }
                        .onFailure { failure ->
                            if (coordinator.client.value === client) {
                                _usageErrorMessage.value = failure.message ?: "Aiden couldn't load Usage."
                            }
                        }
                    catalogRequest.await().onSuccess { accepted ->
                        if (coordinator.client.value === client) _modelCatalog.value = accepted
                    }

                    val failures = listOf(chatsRequest.await(), tasksRequest.await(), usageRequest.await())
                        .mapNotNull { it.exceptionOrNull() }
                    if (failures.size == 3) {
                        _errorMessage.value = failures.firstOrNull()?.message ?: "Aiden couldn't refresh Workspace data."
                    }
                    allCoreSucceeded = failures.isEmpty()
                }
                if (coordinator.client.value === client && allCoreSucceeded) loadedClient = client
            } finally {
                if (loadingClient === client) loadingClient = null
                _isLoading.value = false
            }
        }
    }

    fun refresh(workspaces: List<AidenWorkspace>) {
        hydrate(workspaces)
        load(force = true)
    }

    fun accept(chat: AidenChat) {
        _chats.value = regularNewestFirst(_chats.value.filterNot { it.id == chat.id } + chat)
        coordinator.activeInstanceId?.let { chatCache.saveChat(chat, it) }
    }

    private fun acceptChats(chats: List<AidenChat>) {
        val accepted = regularNewestFirst(chats)
        _chats.value = accepted
        val instanceId = coordinator.activeInstanceId ?: return
        val byWorkspace = accepted.groupBy { it.workspaceId }
        coordinator.workspaces.value.forEach { workspace ->
            chatCache.saveChats(byWorkspace[workspace.id].orEmpty(), instanceId, workspace.id)
        }
    }

    private suspend fun <T> request(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        Result.failure(error)
    }

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

fun regularNewestFirst(chats: List<AidenChat>): List<AidenChat> =
    AidenChat.regularWorkspaceChats(chats)
        .distinctBy { it.id }
        .sortedWith(compareByDescending<AidenChat> { it.updatedAt }.thenBy { it.id })

data class AidenWorkspaceSidebarSection(
    val workspace: AidenWorkspace,
    val chats: List<AidenChat>,
    val newestActivityAt: Instant
)

data class AidenWorkspaceSidebarProjection(
    val sections: List<AidenWorkspaceSidebarSection>,
    val recents: List<AidenChat>
)

fun projectAidenWorkspaceSidebar(
    workspaces: List<AidenWorkspace>,
    chats: List<AidenChat>,
    searchQuery: String
): AidenWorkspaceSidebarProjection {
    val query = searchQuery.trim()
    val workspacesById = workspaces.associateBy { it.id }
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
                allChats.firstOrNull()?.updatedAt ?: Instant.EPOCH
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
