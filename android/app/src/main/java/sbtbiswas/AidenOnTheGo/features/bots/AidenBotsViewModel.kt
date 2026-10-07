package sbtbiswas.AidenOnTheGo.features.bots

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenBotCache
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient

class AidenBotsViewModel(
    val coordinator: AidenRemoteCoordinator,
    val botCache: AidenBotCache? = null
) : ViewModel() {
    private val _botList = MutableStateFlow<AidenBotList?>(botCache?.botList?.value)
    val botList: StateFlow<AidenBotList?> = _botList.asStateFlow()

    private val _conversations = MutableStateFlow(
        aidenCanonicalBotConversations(botCache?.botConversations?.value?.conversations.orEmpty())
    )
    val conversations: StateFlow<List<AidenBotConversationItem>> = _conversations.asStateFlow()

    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()

    private val _remoteSearchResults = MutableStateFlow<List<AidenBotConversationItem>>(emptyList())
    val remoteSearchResults: StateFlow<List<AidenBotConversationItem>> = _remoteSearchResults.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private var searchJob: Job? = null
    private var loadedClient: AidenRemoteClient? = null
    private var loadingClient: AidenRemoteClient? = null

    init {
        viewModelScope.launch {
            combine(coordinator.client, coordinator.connectionState) { client, state -> client to state }
                .collect { (client, state) ->
                    if (client != null && state == AidenConnectionState.CONNECTED) loadBots()
                }
        }
    }

    fun loadBots(force: Boolean = false) {
        val client = coordinator.client.value
        if (client == null) {
            _isLoading.value = false
            return
        }
        if (loadedClient !== client && loadingClient !== client) {
            _botList.value = botCache?.botList?.value
            _conversations.value = aidenCanonicalBotConversations(
                botCache?.botConversations?.value?.conversations.orEmpty()
            )
            _remoteSearchResults.value = emptyList()
        }
        if (loadingClient === client) return
        if (!force && loadedClient === client) return
        loadingClient = client
        viewModelScope.launch {
            _isLoading.value = _botList.value == null
            try {
                supervisorScope {
                    val botsRequest = async { request { client.bots(includeArchived = false) } }
                    val conversationsRequest = async { request { client.botConversations() } }
                    val botsResult = botsRequest.await()
                    val conversationsResult = conversationsRequest.await()
                    if (coordinator.client.value !== client) return@supervisorScope
                    botsResult.onSuccess { list ->
                        _botList.value = list
                        botCache?.putBotList(list)
                    }
                    conversationsResult.onSuccess { page ->
                        _conversations.value = aidenCanonicalBotConversations(page.conversations)
                        botCache?.putBotConversations(page)
                    }
                    val failure = botsResult.exceptionOrNull() ?: conversationsResult.exceptionOrNull()
                    _errorMessage.value = failure?.message
                    if (failure == null) loadedClient = client
                }
            } catch (e: Exception) {
                if (e !is CancellationException) {
                    _errorMessage.value = e.message
                }
            } finally {
                if (loadingClient === client) loadingClient = null
                _isLoading.value = false
            }
        }
    }

    private suspend fun <T> request(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        Result.failure(error)
    }

    fun updateSearchQuery(query: String) {
        _searchQuery.value = query
        searchJob?.cancel()
        if (query.trim().isEmpty()) {
            _remoteSearchResults.value = emptyList()
            return
        }
        searchJob = viewModelScope.launch {
            delay(250)
            val client = coordinator.client.value ?: return@launch
            try {
                val page = client.botConversations(query = query.trim())
                _remoteSearchResults.value = page.conversations
            } catch (_: Exception) {}
        }
    }

    suspend fun loadBotDetail(botId: String): AidenBotDetail? {
        val client = coordinator.client.value ?: return botCache?.getBotDetail(botId)
        return try {
            val detail = client.bot(botId)
            botCache?.putBotDetail(detail)
            detail
        } catch (_: Exception) {
            botCache?.getBotDetail(botId)
        }
    }

    /**
     * Deletes a Bot through [deleter] and drops it from the list and saved snapshot.
     * Returns null on success, or a plain message the screen can show.
     */
    suspend fun deleteBot(botId: String, deleter: AidenBotDeleter): String? {
        val client = coordinator.client.value ?: return "Reconnect to your Mac to delete this Bot."
        return try {
            deleter.delete(client, botId)
            forgetBot(botId)
            null
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            "Aiden couldn’t delete this Bot. Try again."
        }
    }

    private fun forgetBot(botId: String) {
        _botList.value?.let { list ->
            val next = list.copy(
                bots = list.bots.filterNot { it.id == botId },
                favorites = list.favorites.copy(botIds = list.favorites.botIds.filterNot { it == botId })
            )
            _botList.value = next
            botCache?.putBotList(next)
        }
        val remaining = _conversations.value.filterNot { it.botId == botId }
        _conversations.value = remaining
        botCache?.botConversations?.value?.let { page ->
            botCache.putBotConversations(page.copy(conversations = page.conversations.filterNot { it.botId == botId }))
        }
    }

    fun acceptConversation(conversation: AidenBotConversationItem) {
        val accepted = aidenCanonicalBotConversations(
            _conversations.value.filterNot { it.chatId == conversation.chatId } + conversation
        )
        _conversations.value = accepted
        botCache?.botConversations?.value?.let { page ->
            botCache.putBotConversations(page.copy(conversations = accepted))
        }
    }

    companion object {
        fun factory(
            coordinator: AidenRemoteCoordinator,
            botCache: AidenBotCache? = coordinator.botCache
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return AidenBotsViewModel(coordinator, botCache) as T
            }
        }
    }
}
