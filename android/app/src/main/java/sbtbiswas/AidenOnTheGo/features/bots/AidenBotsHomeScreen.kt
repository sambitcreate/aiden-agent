package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSectionLabel
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

data class AidenBotsFavoriteMutation(
    val id: UUID,
    val botID: String
)

data class AidenBotsFavoriteMutationFinish(
    val favoriteOverride: List<String>?,
    val favoriteError: String?
)

fun aidenBotsFinishFavoriteMutation(
    current: AidenBotsFavoriteMutation?,
    finishing: AidenBotsFavoriteMutation,
    restoring: List<String>?,
    error: String? = null
): AidenBotsFavoriteMutationFinish? {
    if (current != finishing) return null
    return AidenBotsFavoriteMutationFinish(
        favoriteOverride = restoring,
        favoriteError = error
    )
}

data class AidenBotContactSectionIDs(
    val favorites: List<String>,
    val others: List<String>
)

fun aidenBotContactSectionIDs(
    matchingBotIDs: List<String>,
    activeBotIDs: List<String>,
    favoriteIDs: List<String>,
    isSearching: Boolean
): AidenBotContactSectionIDs {
    if (isSearching) {
        return AidenBotContactSectionIDs(favorites = emptyList(), others = matchingBotIDs)
    }
    val activeSet = activeBotIDs.toSet()
    val seenFavorites = mutableSetOf<String>()
    val visibleFavorites = favoriteIDs.filter { id ->
        activeSet.contains(id) && seenFavorites.add(id)
    }
    val favoriteSet = visibleFavorites.toSet()
    return AidenBotContactSectionIDs(
        favorites = visibleFavorites,
        others = matchingBotIDs.filter { !favoriteSet.contains(it) }
    )
}

enum class AidenBotsHomeContentState {
    LOADING,
    ERROR,
    EMPTY,
    NO_RESULTS,
    CONTENT
}

fun aidenBotsHomeContentState(
    hasSnapshot: Boolean,
    isLoading: Boolean,
    totalBotCount: Int,
    activeBotCount: Int,
    conversationCount: Int,
    hasQuery: Boolean,
    filteredBotCount: Int,
    filteredConversationCount: Int,
    hasError: Boolean = false
): AidenBotsHomeContentState {
    if (!hasSnapshot && hasError) return AidenBotsHomeContentState.ERROR
    if (!hasSnapshot) return AidenBotsHomeContentState.LOADING
    if (totalBotCount == 0 && conversationCount == 0) return AidenBotsHomeContentState.EMPTY
    if (hasQuery && filteredBotCount == 0 && filteredConversationCount == 0) return AidenBotsHomeContentState.NO_RESULTS
    return AidenBotsHomeContentState.CONTENT
}

fun aidenCanonicalBotConversations(
    conversations: List<AidenBotConversationItem>
): List<AidenBotConversationItem> {
    val canonicalByBotID = mutableMapOf<String, AidenBotConversationItem>()
    for (conversation in conversations) {
        val current = canonicalByBotID[conversation.botId]
        if (current == null) {
            canonicalByBotID[conversation.botId] = conversation
            continue
        }
        if (conversation.updatedAt.isAfter(current.updatedAt) ||
            (conversation.updatedAt == current.updatedAt && (conversation.createdAt.isAfter(current.createdAt) ||
                    (conversation.createdAt == current.createdAt && conversation.chatId < current.chatId)))
        ) {
            canonicalByBotID[conversation.botId] = conversation
        }
    }
    return conversations.filter { conversation ->
        canonicalByBotID[conversation.botId]?.chatId == conversation.chatId
    }
}

enum class AidenBotFavoriteOrderMove {
    ADD,
    REMOVE,
    EARLIER,
    LATER
}

fun aidenBotFavoriteOrder(
    botIDs: List<String>,
    movingBotId: String,
    move: AidenBotFavoriteOrderMove
): List<String> {
    val result = botIDs.filter { it != movingBotId }.toMutableList()
    when (move) {
        AidenBotFavoriteOrderMove.ADD -> {
            result.add(movingBotId)
        }
        AidenBotFavoriteOrderMove.REMOVE -> {}
        AidenBotFavoriteOrderMove.EARLIER, AidenBotFavoriteOrderMove.LATER -> {
            val oldIndex = botIDs.indexOf(movingBotId)
            if (oldIndex == -1) return botIDs
            val destination = if (move == AidenBotFavoriteOrderMove.EARLIER) {
                maxOf(0, oldIndex - 1)
            } else {
                minOf(botIDs.size - 1, oldIndex + 1)
            }
            result.add(destination, movingBotId)
        }
    }
    return result
}

data class AidenBotInboxActivityStatus(
    val label: String,
    val symbol: String
)

fun aidenBotInboxActivityStatus(
    state: AidenBotConversationActivityState,
    canRespondToApproval: Boolean
): AidenBotInboxActivityStatus? {
    return when (state) {
        AidenBotConversationActivityState.IDLE -> null
        AidenBotConversationActivityState.QUEUED -> AidenBotInboxActivityStatus("Queued", "schedule")
        AidenBotConversationActivityState.RUNNING -> AidenBotInboxActivityStatus("Working", "graphic_eq")
        AidenBotConversationActivityState.WAITING_FOR_APPROVAL -> {
            if (canRespondToApproval) {
                AidenBotInboxActivityStatus("Approval needed", "verified_user")
            } else {
                AidenBotInboxActivityStatus("Waiting for approval on Mac", "computer")
            }
        }
        AidenBotConversationActivityState.RECONCILING -> AidenBotInboxActivityStatus("Updating", "sync")
    }
}

@Composable
fun AidenBotSkeletonBlock(
    width: Dp?,
    height: Dp,
    radius: Dp,
    reduceMotion: Boolean = false,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val infiniteTransition = rememberInfiniteTransition(label = "ShimmerTransition")
    val shimmerTranslate by infiniteTransition.animateFloat(
        initialValue = -300f,
        targetValue = 600f,
        animationSpec = infiniteRepeatable(
            animation = tween(1500, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "ShimmerTranslate"
    )

    val shimmerBrush = if (!reduceMotion) {
        Brush.linearGradient(
            colors = listOf(
                palette.raised,
                palette.foreground.copy(alpha = 0.12f),
                palette.raised
            ),
            start = androidx.compose.ui.geometry.Offset(shimmerTranslate, 0f),
            end = androidx.compose.ui.geometry.Offset(shimmerTranslate + 200f, 0f)
        )
    } else {
        Brush.linearGradient(listOf(palette.raised, palette.raised))
    }

    Box(
        modifier = modifier
            .then(if (width != null) Modifier.width(width) else Modifier.fillMaxWidth())
            .height(height)
            .clip(RoundedCornerShape(radius))
            .background(shimmerBrush)
    )
}

@Composable
fun AidenBotHomeSkeletonView(
    reduceMotion: Boolean = false,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Favorites label skeleton
        AidenBotSkeletonBlock(width = 74.dp, height = 16.dp, radius = 8.dp, reduceMotion = reduceMotion, modifier = Modifier.padding(horizontal = 20.dp))

        // Favorites carousel skeleton
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            repeat(4) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    AidenBotSkeletonBlock(width = 72.dp, height = 72.dp, radius = 36.dp, reduceMotion = reduceMotion)
                    AidenBotSkeletonBlock(width = 48.dp, height = 10.dp, radius = 5.dp, reduceMotion = reduceMotion)
                }
            }
        }

        // Bots list label skeleton
        AidenBotSkeletonBlock(width = 48.dp, height = 16.dp, radius = 8.dp, reduceMotion = reduceMotion, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))

        // Bot rows skeleton
        repeat(3) { index ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                AidenBotSkeletonBlock(width = 52.dp, height = 52.dp, radius = 26.dp, reduceMotion = reduceMotion)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.weight(1f)) {
                    AidenBotSkeletonBlock(width = if (index == 1) 130.dp else 100.dp, height = 15.dp, radius = 7.dp, reduceMotion = reduceMotion)
                    AidenBotSkeletonBlock(width = if (index == 2) 160.dp else 180.dp, height = 12.dp, radius = 6.dp, reduceMotion = reduceMotion)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotsHomeScreen(
    coordinator: AidenRemoteCoordinator,
    viewModel: AidenBotsViewModel,
    onNavigateToChat: (String) -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    onNavigateToCreateBot: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsState()
    val connectionState by coordinator.connectionState.collectAsState()

    val botList by viewModel.botList.collectAsState()
    val conversations by viewModel.conversations.collectAsState()
    val searchQuery by viewModel.searchQuery.collectAsState()
    val remoteSearchResults by viewModel.remoteSearchResults.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val errorMessage by viewModel.errorMessage.collectAsState()
    var isChoosingBotDialog by remember { mutableStateOf(false) }

    LaunchedEffect(client, connectionState) {
        if (client != null && connectionState == AidenConnectionState.CONNECTED) {
            viewModel.loadBots()
        }
    }

    val allBots = botList?.bots ?: emptyList()
    val activeBots = allBots.filter { it.health != AidenBotHealth.ARCHIVED }
    val chatReadyBots = activeBots.filter { it.health == AidenBotHealth.READY }
    val favoriteIDs = botList?.favorites?.botIds ?: emptyList()
    val conversationByBotId = conversations.associateBy { it.botId }

    val matchingBots = remember(allBots, searchQuery, conversations, remoteSearchResults) {
        val query = searchQuery.trim()
        val remoteBotIds = remoteSearchResults.map { it.botId }.toSet()
        val list = allBots.filter { bot ->
            if (query.isEmpty()) return@filter true
            val conv = conversationByBotId[bot.id]
            bot.name.contains(query, ignoreCase = true) ||
                    bot.purpose.contains(query, ignoreCase = true) ||
                    (conv?.title?.contains(query, ignoreCase = true) == true) ||
                    (conv?.preview?.contains(query, ignoreCase = true) == true) ||
                    remoteBotIds.contains(bot.id)
        }
        list.sortedWith { lhs, rhs ->
            val leftDate = conversationByBotId[lhs.id]?.updatedAt ?: lhs.updatedAt
            val rightDate = conversationByBotId[rhs.id]?.updatedAt ?: rhs.updatedAt
            if (leftDate != rightDate) {
                rightDate.compareTo(leftDate)
            } else {
                lhs.name.compareTo(rhs.name, ignoreCase = true)
            }
        }
    }

    val contactSections = remember(matchingBots, activeBots, favoriteIDs, searchQuery) {
        aidenBotContactSectionIDs(
            matchingBotIDs = matchingBots.map { it.id },
            activeBotIDs = activeBots.map { it.id },
            favoriteIDs = favoriteIDs,
            isSearching = searchQuery.trim().isNotEmpty()
        )
    }

    val activeById = remember(activeBots) { activeBots.associateBy { it.id } }
    val matchingById = remember(matchingBots) { matchingBots.associateBy { it.id } }
    val favoriteBots = contactSections.favorites.mapNotNull { activeById[it] }
    val otherBots = contactSections.others.mapNotNull { matchingById[it] }

    val contentState = aidenBotsHomeContentState(
        hasSnapshot = botList != null,
        isLoading = isLoading,
        totalBotCount = allBots.size,
        activeBotCount = activeBots.size,
        conversationCount = conversations.size,
        hasQuery = searchQuery.trim().isNotEmpty(),
        filteredBotCount = matchingBots.size,
        filteredConversationCount = 0,
        hasError = errorMessage != null
    )

    fun startOrOpenChat(bot: AidenBotSummary) {
        scope.launch {
            val existing = conversations.firstOrNull { it.botId == bot.id }
            if (existing != null) {
                onNavigateToChat(existing.chatId)
            } else {
                val cl = client ?: return@launch
                try {
                    val created = cl.createBotChat(bot.id)
                    onNavigateToChat(created.id)
                    viewModel.loadBots(force = true)
                } catch (_: Exception) {}
            }
        }
    }

    Scaffold(
        containerColor = palette.canvas,
        contentWindowInsets = WindowInsets(0, 0, 0, 0)
    ) { padding ->
        Box(
            modifier = modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 104.dp)
            ) {
                // Offline banner if offline
                if (connectionState != AidenConnectionState.CONNECTED && botList != null) {
                    item {
                        Surface(
                            color = palette.raised,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp, vertical = 4.dp),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
                            ) {
                                Icon(Icons.Default.WifiOff, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(16.dp))
                                Spacer(modifier = Modifier.width(8.dp))
                                Text("Offline — showing saved Bots", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                            }
                        }
                    }
                }

                // Content Views
                when (contentState) {
                    AidenBotsHomeContentState.LOADING -> {
                        item {
                            AidenBotHomeSkeletonView()
                        }
                    }
                    AidenBotsHomeContentState.ERROR -> {
                        item {
                            AidenEmptyState(
                                icon = Icons.Default.WifiOff,
                                title = "Bots couldn’t load",
                                body = errorMessage ?: "Reconnect to your Mac and try again.",
                                modifier = Modifier.padding(top = 36.dp),
                                action = {
                                    Button(
                                        onClick = { viewModel.loadBots(force = true) },
                                        colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                                        shape = RoundedCornerShape(24.dp),
                                        modifier = Modifier.heightIn(min = AidenUi.MinimumTouchTarget)
                                    ) { Text("Retry") }
                                }
                            )
                        }
                    }
                    AidenBotsHomeContentState.EMPTY -> {
                        item {
                            AidenEmptyState(
                                icon = Icons.Default.SmartToy,
                                title = if (connectionState == AidenConnectionState.CONNECTED) "Make your first Bot" else "No saved Bots",
                                body = if (connectionState == AidenConnectionState.CONNECTED)
                                    "Create a familiar helper with one persistent conversation and its own capabilities."
                                else
                                    "Reconnect to your Mac to load Bots.",
                                modifier = Modifier.padding(top = 36.dp),
                                action = if (connectionState == AidenConnectionState.CONNECTED) {
                                    {
                                        Button(
                                            onClick = onNavigateToCreateBot,
                                            colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                                            shape = RoundedCornerShape(24.dp),
                                            modifier = Modifier.heightIn(min = AidenUi.MinimumTouchTarget)
                                        ) { Text("New Bot") }
                                    }
                                } else null
                            )
                        }
                    }
                    AidenBotsHomeContentState.NO_RESULTS -> {
                        item {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 54.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Icon(Icons.Default.SearchOff, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(48.dp))
                                    Spacer(modifier = Modifier.height(12.dp))
                                    Text("No Results for \"$searchQuery\"", style = MaterialTheme.typography.titleMedium, color = palette.secondary)
                                }
                            }
                        }
                    }
                    AidenBotsHomeContentState.CONTENT -> {
                        // Favorites Section
                        if (favoriteBots.isNotEmpty()) {
                            item {
                                AidenSectionLabel(
                                    text = "Favorites",
                                    modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 10.dp)
                                )
                                LazyRow(
                                    contentPadding = PaddingValues(horizontal = 20.dp),
                                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                                    modifier = Modifier.padding(bottom = 16.dp)
                                ) {
                                    items(favoriteBots, key = { it.id }) { bot ->
                                        Column(
                                            horizontalAlignment = Alignment.CenterHorizontally,
                                            modifier = Modifier
                                                .width(80.dp)
                                                .clip(RoundedCornerShape(16.dp))
                                                .clickable { startOrOpenChat(bot) }
                                                .padding(vertical = 4.dp)
                                        ) {
                                            Box(
                                                contentAlignment = Alignment.Center,
                                                modifier = Modifier
                                                    .size(76.dp)
                                                    .shadow(elevation = 1.dp, shape = CircleShape)
                                            ) {
                                                AidenBotCanonicalAvatarView(
                                                    coordinator = coordinator,
                                                    botId = bot.id,
                                                    avatar = bot.avatar,
                                                    name = bot.name,
                                                    size = 72.dp
                                                )
                                            }
                                            Spacer(modifier = Modifier.height(8.dp))
                                            Text(
                                                text = bot.name,
                                                style = MaterialTheme.typography.labelMedium,
                                                fontWeight = FontWeight.SemiBold,
                                                color = palette.foreground,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        // Bots Section
                        if (otherBots.isNotEmpty()) {
                            item {
                                AidenSectionLabel(
                                    text = "Bots",
                                    modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 10.dp)
                                )
                            }

                            items(otherBots, key = { it.id }) { bot ->
                                val conv = conversationByBotId[bot.id]
                                val preview = conv?.preview ?: conv?.title ?: bot.purpose.ifEmpty { "Start a conversation" }
                                val formattedPreview = if (bot.health == AidenBotHealth.ARCHIVED) "Archived · $preview" else preview

                                val isActive = conv?.activityState != null && conv.activityState != AidenBotConversationActivityState.IDLE

                                Surface(
                                    color = Color.Transparent,
                                    shape = RoundedCornerShape(14.dp),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 8.dp, vertical = 1.dp)
                                        .clip(RoundedCornerShape(14.dp))
                                        .clickable { startOrOpenChat(bot) }
                                ) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = AidenUi.RowVerticalPadding)
                                    ) {
                                        AidenBotCanonicalAvatarView(
                                            coordinator = coordinator,
                                            botId = bot.id,
                                            avatar = bot.avatar,
                                            name = bot.name,
                                            size = 52.dp
                                        )
                                        Spacer(modifier = Modifier.width(14.dp))
                                        Column(modifier = Modifier.weight(1f)) {
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                Text(
                                                    text = bot.name,
                                                    style = MaterialTheme.typography.titleMedium,
                                                    fontWeight = FontWeight.Bold,
                                                    color = palette.foreground,
                                                    maxLines = 1,
                                                    overflow = TextOverflow.Ellipsis,
                                                    modifier = Modifier.weight(1f)
                                                )
                                                if (conv != null) {
                                                    val instant = conv.updatedAt
                                                    val timeText = DateTimeFormatter.ofPattern("h:mm a")
                                                        .withZone(ZoneId.systemDefault())
                                                        .format(instant)
                                                    Text(
                                                        text = timeText,
                                                        style = MaterialTheme.typography.labelSmall,
                                                        color = palette.secondary
                                                    )
                                                }
                                            }
                                            Spacer(modifier = Modifier.height(3.dp))
                                            Text(
                                                text = formattedPreview,
                                                style = MaterialTheme.typography.bodyMedium,
                                                color = palette.secondary,
                                                maxLines = 2,
                                                overflow = TextOverflow.Ellipsis
                                            )
                                            if (conv != null) {
                                                val status = aidenBotInboxActivityStatus(
                                                    state = conv.activityState,
                                                    canRespondToApproval = conv.canRespondToApproval
                                                )
                                                if (status != null) {
                                                    Spacer(modifier = Modifier.height(6.dp))
                                                    Surface(
                                                        color = MaterialTheme.colorScheme.primaryContainer,
                                                        shape = RoundedCornerShape(10.dp)
                                                    ) {
                                                        Row(
                                                            verticalAlignment = Alignment.CenterVertically,
                                                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)
                                                        ) {
                                                            Icon(
                                                                imageVector = when (status.symbol) {
                                                                    "schedule" -> Icons.Default.Schedule
                                                                    "graphic_eq" -> Icons.Default.GraphicEq
                                                                    "verified_user" -> Icons.Default.VerifiedUser
                                                                    "computer" -> Icons.Default.Computer
                                                                    else -> Icons.Default.Sync
                                                                },
                                                                contentDescription = null,
                                                                tint = palette.accent,
                                                                modifier = Modifier.size(12.dp)
                                                            )
                                                            Spacer(modifier = Modifier.width(4.dp))
                                                            Text(
                                                                text = status.label,
                                                                style = MaterialTheme.typography.labelSmall,
                                                                color = palette.accent,
                                                                fontWeight = FontWeight.SemiBold
                                                            )
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        IconButton(
                                            onClick = { onNavigateToBotProfile(bot.id) },
                                            modifier = Modifier.size(AidenUi.MinimumTouchTarget)
                                        ) {
                                            Icon(Icons.Default.ChevronRight, contentDescription = "Open ${bot.name} details", tint = palette.secondary)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 1:1 Parity iOS Glass Bottom Dock
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(horizontal = AidenUi.ScreenGutter, vertical = 10.dp)
            ) {
                // Search Glass Capsule
                Surface(
                    shape = RoundedCornerShape(27.dp),
                    color = palette.raised.copy(alpha = 0.94f),
                    shadowElevation = 3.dp,
                    modifier = Modifier
                        .weight(1f)
                        .height(54.dp)
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(horizontal = 16.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Search,
                            contentDescription = null,
                            tint = palette.foreground,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(10.dp))
                        Box(
                            modifier = Modifier.weight(1f),
                            contentAlignment = Alignment.CenterStart
                        ) {
                            if (searchQuery.isEmpty()) {
                                Text(
                                    text = "Search Bots",
                                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp),
                                    color = palette.secondary.copy(alpha = 0.7f)
                                )
                            }
                            BasicTextField(
                                value = searchQuery,
                                onValueChange = viewModel::updateSearchQuery,
                                textStyle = MaterialTheme.typography.bodyMedium.copy(
                                    color = palette.foreground,
                                    fontSize = 15.sp
                                ),
                                cursorBrush = SolidColor(palette.accent),
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                        if (searchQuery.isNotEmpty()) {
                            IconButton(
                                onClick = { viewModel.updateSearchQuery("") },
                                modifier = Modifier.size(28.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Close,
                                    contentDescription = "Clear search",
                                    tint = palette.secondary,
                                    modifier = Modifier.size(16.dp)
                                )
                            }
                        }
                    }
                }

                // Standalone 54dp Floating Action Button
                Surface(
                    shape = CircleShape,
                    color = if (chatReadyBots.isNotEmpty()) palette.accent else palette.raised,
                    shadowElevation = 3.dp,
                    modifier = Modifier.size(54.dp)
                ) {
                    IconButton(
                        onClick = { isChoosingBotDialog = true },
                        enabled = chatReadyBots.isNotEmpty(),
                        modifier = Modifier.fillMaxSize()
                    ) {
                        Icon(
                            imageVector = Icons.Default.Edit,
                            contentDescription = "Open Bot Chat",
                            tint = if (chatReadyBots.isNotEmpty()) Color.White else palette.secondary.copy(alpha = 0.4f),
                            modifier = Modifier.size(22.dp)
                        )
                    }
                }
            }
        }
    }

    // Open Bot Chat Picker Dialog
    if (isChoosingBotDialog) {
        AlertDialog(
            onDismissRequest = { isChoosingBotDialog = false },
            title = { Text("Choose a Bot", fontWeight = FontWeight.Bold) },
            text = {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text("Open this Bot’s chat. Aiden starts it the first time if needed.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                    Spacer(modifier = Modifier.height(4.dp))
                    chatReadyBots.forEach { bot ->
                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .clickable {
                                    isChoosingBotDialog = false
                                    startOrOpenChat(bot)
                                },
                            color = palette.raised
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(12.dp)
                            ) {
                                AidenBotCanonicalAvatarView(
                                    coordinator = coordinator,
                                    botId = bot.id,
                                    avatar = bot.avatar,
                                    name = bot.name,
                                    size = 36.dp
                                )
                                Spacer(modifier = Modifier.width(12.dp))
                                Text(bot.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { isChoosingBotDialog = false }) {
                    Text("Cancel", color = palette.secondary)
                }
            },
            containerColor = palette.canvas
        )
    }
}
