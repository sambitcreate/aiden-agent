package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionScreen
import sbtbiswas.AidenOnTheGo.features.bots.AidenRemoteBotDeleter
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.aidenCanonicalBotConversations
import sbtbiswas.AidenOnTheGo.networking.AidenNetworkAvailability
import sbtbiswas.AidenOnTheGo.notifications.AidenRemoteLiveNotificationManager
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/**
 * Opens a Bot's chat by Bot id. A Mac advertising `bot-durable-session-v1` serves the
 * durable session; an older Mac keeps the chat-id path, resolving (or creating) the Bot's
 * canonical conversation and showing the regular chat screen with its stream Stop.
 */
@Composable
fun AidenBotChatRoute(
    botId: String,
    coordinator: AidenRemoteCoordinator,
    chatCache: AidenChatCache,
    draftStore: AidenChatDraftStore,
    voiceInputStore: AidenVoiceInputStore,
    liveNotificationManager: AidenRemoteLiveNotificationManager?,
    networkAvailability: AidenNetworkAvailability,
    onNavigateToChat: (String) -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    onNavigateBack: () -> Unit
) {
    val serverInfo by coordinator.serverInfo.collectAsStateWithLifecycle()
    val client by coordinator.client.collectAsStateWithLifecycle()
    val palette = AidenTheme.palette
    if (serverInfo?.supportsBotDurableSession == true) {
        AidenBotSessionScreen(
            botId = botId,
            coordinator = coordinator,
            onNavigateBack = onNavigateBack,
            onNavigateToBotProfile = onNavigateToBotProfile
        )
        return
    }
    var chatId by remember(botId) { mutableStateOf<String?>(null) }
    var failed by remember(botId) { mutableStateOf(false) }
    LaunchedEffect(botId, client) {
        val cl = client ?: return@LaunchedEffect
        try {
            val page = cl.botConversations(botId = botId)
            chatId = aidenCanonicalBotConversations(page.conversations).firstOrNull { it.botId == botId }?.chatId
                ?: cl.createBotChat(botId).id
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = true
        }
    }
    val resolved = chatId
    if (resolved != null) {
        AidenChatDetailScreen(
            chatId = resolved,
            coordinator = coordinator,
            chatCache = chatCache,
            draftStore = draftStore,
            voiceInputStore = voiceInputStore,
            liveNotificationManager = liveNotificationManager,
            networkAvailability = networkAvailability,
            onNavigateToChat = onNavigateToChat,
            onNavigateToBotProfile = onNavigateToBotProfile,
            botDeleter = AidenRemoteBotDeleter,
            onNavigateBack = onNavigateBack
        )
    } else {
        Box(Modifier.fillMaxSize().background(palette.canvas), contentAlignment = Alignment.Center) {
            if (failed) {
                Text("Aiden couldn’t open this Bot’s chat. Try again.", color = palette.secondary)
            } else {
                CircularProgressIndicator(color = palette.accent)
            }
        }
    }
}
