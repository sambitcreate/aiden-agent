package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SearchOff
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

enum class AidenBotsHomeContentState {
    LOADING,
    ERROR,
    EMPTY,
    NO_RESULTS,
    CONTENT
}

fun aidenBotsHomeContentState(
    hasSnapshot: Boolean,
    totalBotCount: Int,
    hasQuery: Boolean,
    filteredBotCount: Int,
    hasError: Boolean = false
): AidenBotsHomeContentState {
    if (!hasSnapshot && hasError) return AidenBotsHomeContentState.ERROR
    if (!hasSnapshot) return AidenBotsHomeContentState.LOADING
    if (totalBotCount == 0) return AidenBotsHomeContentState.EMPTY
    if (hasQuery && filteredBotCount == 0) return AidenBotsHomeContentState.NO_RESULTS
    return AidenBotsHomeContentState.CONTENT
}

/** One Bot row on the home list. */
data class AidenBotHomeRow(
    val bot: AidenBotSummary,
    val conversation: AidenBotConversationItem?
) {
    val isWorking: Boolean
        get() = bot.sessionState == AidenBotSessionState.RUNNING ||
            (conversation != null && conversation.activityState != AidenBotConversationActivityState.IDLE)

    /** The line under the name: what needs the person first, then the last message, then the subtitle. */
    val preview: String
        get() {
            when (bot.sessionState) {
                AidenBotSessionState.INTERRUPTED -> return AidenBotSessionCopy.PAUSED_ROW
                AidenBotSessionState.NEEDS_MODEL -> return AidenBotSessionCopy.NEEDS_MODEL
                else -> {}
            }
            val conv = conversation
            if (conv?.activityState == AidenBotConversationActivityState.WAITING_FOR_APPROVAL) {
                return if (conv.canRespondToApproval) "Needs your OK" else "Waiting for your OK on your Mac"
            }
            val last = conv?.preview?.trim().orEmpty()
            if (last.isNotEmpty()) return last
            return "Say hi to ${bot.name}"
        }

    val updatedAt: Instant
        get() = conversation?.updatedAt ?: bot.updatedAt
}

/**
 * Bots newest first, filtered by [query] against the name, subtitle, last message and
 * any Bots the Mac matched remotely.
 */
fun aidenBotHomeRows(
    bots: List<AidenBotSummary>,
    conversations: List<AidenBotConversationItem>,
    query: String,
    remoteMatchBotIds: Set<String> = emptySet()
): List<AidenBotHomeRow> {
    val byBot = aidenCanonicalBotConversations(conversations).associateBy { it.botId }
    val needle = query.trim()
    return bots
        .map { AidenBotHomeRow(it, byBot[it.id]) }
        .filter { row ->
            needle.isEmpty() ||
                row.bot.name.contains(needle, ignoreCase = true) ||
                row.bot.purpose.contains(needle, ignoreCase = true) ||
                row.conversation?.preview?.contains(needle, ignoreCase = true) == true ||
                remoteMatchBotIds.contains(row.bot.id)
        }
        .sortedWith(compareByDescending<AidenBotHomeRow> { it.updatedAt }.thenBy { it.bot.name.lowercase() })
}

/** Friendly row time: a clock time today, "Yesterday", a weekday this week, otherwise a date. */
fun aidenBotRowTime(
    instant: Instant,
    now: Instant = Instant.now(),
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault()
): String {
    val day = instant.atZone(zone).toLocalDate()
    val today = now.atZone(zone).toLocalDate()
    val daysAgo = ChronoUnit.DAYS.between(day, today)
    val pattern = when {
        daysAgo <= 0L -> "h:mm a"
        daysAgo == 1L -> return "Yesterday"
        daysAgo < 7L -> "EEEE"
        day.year == today.year -> "MMM d"
        else -> "MMM d, yyyy"
    }
    return DateTimeFormatter.ofPattern(pattern, locale).withZone(zone).format(instant)
}

@Composable
private fun AidenBotSkeletonBlock(width: Dp?, height: Dp, radius: Dp, reduceMotion: Boolean) {
    val palette = AidenTheme.palette
    val brush = if (!reduceMotion) {
        val shimmer by rememberInfiniteTransition(label = "bot_home_shimmer").animateFloat(
            initialValue = -300f,
            targetValue = 600f,
            animationSpec = infiniteRepeatable(tween(1500, easing = LinearEasing), RepeatMode.Restart),
            label = "bot_home_shimmer_x"
        )
        Brush.linearGradient(
            colors = listOf(palette.raised, palette.foreground.copy(alpha = 0.12f), palette.raised),
            start = androidx.compose.ui.geometry.Offset(shimmer, 0f),
            end = androidx.compose.ui.geometry.Offset(shimmer + 200f, 0f)
        )
    } else {
        SolidColor(palette.raised)
    }
    Box(
        Modifier
            .then(if (width != null) Modifier.width(width) else Modifier.fillMaxWidth())
            .height(height)
            .clip(RoundedCornerShape(radius))
            .background(brush)
    )
}

@Composable
private fun AidenBotHomeSkeleton(reduceMotion: Boolean) {
    Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        repeat(4) { index ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = AidenUi.ScreenGutter),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                AidenBotSkeletonBlock(52.dp, 52.dp, 26.dp, reduceMotion)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    AidenBotSkeletonBlock(if (index % 2 == 0) 120.dp else 96.dp, 15.dp, 7.dp, reduceMotion)
                    AidenBotSkeletonBlock(null, 12.dp, 6.dp, reduceMotion)
                }
            }
        }
    }
}

@Composable
fun AidenBotsHomeScreen(
    coordinator: AidenRemoteCoordinator,
    viewModel: AidenBotsViewModel,
    onNavigateToChat: (String) -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    onNavigateToCreateBot: () -> Unit,
    modifier: Modifier = Modifier,
    onNavigateToBotChat: (String) -> Unit = {},
    botDeleter: AidenBotDeleter? = null
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsStateWithLifecycle()
    val connectionState by coordinator.connectionState.collectAsStateWithLifecycle()
    val serverInfo by coordinator.serverInfo.collectAsStateWithLifecycle()

    val botList by viewModel.botList.collectAsStateWithLifecycle()
    val conversations by viewModel.conversations.collectAsStateWithLifecycle()
    val searchQuery by viewModel.searchQuery.collectAsStateWithLifecycle()
    val remoteSearchResults by viewModel.remoteSearchResults.collectAsStateWithLifecycle()
    val errorMessage by viewModel.errorMessage.collectAsStateWithLifecycle()

    var pendingDelete by remember { mutableStateOf<AidenBotSummary?>(null) }
    var isDeleting by remember { mutableStateOf(false) }
    var deleteError by remember { mutableStateOf<String?>(null) }
    val canDelete = aidenBotDeleteAvailable(serverInfo, botDeleter)

    LaunchedEffect(client, connectionState) {
        if (client != null && connectionState == AidenConnectionState.CONNECTED) viewModel.loadBots()
    }

    val allBots = botList?.bots.orEmpty()
    val rows = remember(allBots, conversations, searchQuery, remoteSearchResults) {
        aidenBotHomeRows(allBots, conversations, searchQuery, remoteSearchResults.map { it.botId }.toSet())
    }
    val contentState = aidenBotsHomeContentState(
        hasSnapshot = botList != null,
        totalBotCount = allBots.size,
        hasQuery = searchQuery.isNotBlank(),
        filteredBotCount = rows.size,
        hasError = errorMessage != null
    )

    val presets by viewModel.presets.collectAsStateWithLifecycle()
    var startingPresetId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(client, connectionState, serverInfo) {
        if (client != null && connectionState == AidenConnectionState.CONNECTED) viewModel.loadPresets()
    }

    fun openChat(bot: AidenBotSummary) {
        if (serverInfo?.supportsBotDurableSession == true) {
            onNavigateToBotChat(bot.id)
            return
        }
        scope.launch {
            val existing = aidenCanonicalBotConversations(conversations).firstOrNull { it.botId == bot.id }
            if (existing != null) {
                onNavigateToChat(existing.chatId)
                return@launch
            }
            val cl = client ?: return@launch
            try {
                val created = cl.createBotChat(bot.id)
                onNavigateToChat(created.id)
                viewModel.loadBots(force = true)
            } catch (_: Exception) {
                onNavigateToBotProfile(bot.id)
            }
        }
    }

    LazyColumn(
        modifier = modifier.fillMaxSize().background(palette.canvas),
        contentPadding = PaddingValues(bottom = 24.dp)
    ) {
        if (contentState != AidenBotsHomeContentState.EMPTY && contentState != AidenBotsHomeContentState.LOADING) {
            item(key = "search") {
                AidenBotSearchField(
                    query = searchQuery,
                    onQueryChange = viewModel::updateSearchQuery,
                    modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
                )
            }
        }
        if (connectionState != AidenConnectionState.CONNECTED && botList != null) {
            item(key = "offline") {
                Surface(
                    color = palette.raised,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = AidenUi.ScreenGutter, vertical = 4.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                        Icon(Icons.Default.WifiOff, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Offline. Showing your saved Bots.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                    }
                }
            }
        }
        when (contentState) {
            AidenBotsHomeContentState.LOADING -> item(key = "loading") { AidenBotHomeSkeleton(reduceMotion) }
            AidenBotsHomeContentState.ERROR -> item(key = "error") {
                AidenEmptyState(
                    icon = Icons.Default.WifiOff,
                    title = "Bots couldn’t load",
                    body = "Make sure your Mac is on and nearby, then try again.",
                    modifier = Modifier.padding(top = 36.dp),
                    action = { AidenPrimaryButton(text = "Try Again", onClick = { viewModel.loadBots(force = true) }) }
                )
            }
            AidenBotsHomeContentState.EMPTY -> item(key = "empty") {
                val connected = connectionState == AidenConnectionState.CONNECTED
                if (connected && presets.isNotEmpty()) {
                    AidenMeetYourFirstBot(
                        presets = presets,
                        startingPresetId = startingPresetId,
                        onStartChat = { preset ->
                            if (startingPresetId != null) return@AidenMeetYourFirstBot
                            startingPresetId = preset.id
                            scope.launch {
                                val botId = viewModel.startPreset(preset.id)
                                startingPresetId = null
                                if (botId != null) onNavigateToBotChat(botId)
                            }
                        },
                        onCreateMyOwn = onNavigateToCreateBot,
                        modifier = Modifier.padding(top = 12.dp)
                    )
                    return@item
                }
                AidenEmptyState(
                    icon = Icons.Default.SmartToy,
                    title = if (connected) "Make your first Bot" else "No saved Bots",
                    body = if (connected) "A Bot is a helper with its own chat. Give it a name and tell it what to help with."
                    else "Connect to your Mac to see your Bots.",
                    modifier = Modifier.padding(top = 36.dp),
                    action = if (connected) {
                        { AidenPrimaryButton(text = "New Bot", onClick = onNavigateToCreateBot) }
                    } else null
                )
            }
            AidenBotsHomeContentState.NO_RESULTS -> item(key = "no-results") {
                Column(
                    Modifier.fillMaxWidth().padding(top = 54.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Icon(Icons.Default.SearchOff, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(40.dp))
                    Spacer(Modifier.height(12.dp))
                    Text("No Bots match “${searchQuery.trim()}”", style = MaterialTheme.typography.titleMedium, color = palette.secondary)
                }
            }
            AidenBotsHomeContentState.CONTENT -> items(rows, key = { it.bot.id }) { row ->
                AidenBotHomeRowView(
                    row = row,
                    coordinator = coordinator,
                    canDelete = canDelete,
                    onOpen = { openChat(row.bot) },
                    onOpenProfile = { onNavigateToBotProfile(row.bot.id) },
                    onDelete = { pendingDelete = row.bot }
                )
            }
        }
    }

    pendingDelete?.let { bot ->
        AidenBotDeleteDialog(
            name = bot.name,
            isDeleting = isDeleting,
            onDismiss = { pendingDelete = null },
            onConfirm = {
                val deleter = botDeleter ?: return@AidenBotDeleteDialog
                scope.launch {
                    isDeleting = true
                    deleteError = viewModel.deleteBot(bot.id, deleter)
                    isDeleting = false
                    pendingDelete = null
                }
            }
        )
    }
    deleteError?.let { message ->
        AlertDialog(
            onDismissRequest = { deleteError = null },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = { deleteError = null }) { Text("OK", color = palette.accent) } },
            containerColor = palette.raised
        )
    }
}

@Composable
private fun AidenBotSearchField(query: String, onQueryChange: (String) -> Unit, modifier: Modifier = Modifier) {
    val palette = AidenTheme.palette
    Surface(
        shape = RoundedCornerShape(22.dp),
        color = palette.raised,
        modifier = modifier.fillMaxWidth().height(44.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 14.dp)) {
            Icon(Icons.Default.Search, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                if (query.isEmpty()) {
                    Text("Search Bots", style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                }
                BasicTextField(
                    value = query,
                    onValueChange = onQueryChange,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = palette.foreground),
                    cursorBrush = SolidColor(palette.accent),
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Search Bots" }
                )
            }
            if (query.isNotEmpty()) {
                IconButton(onClick = { onQueryChange("") }, modifier = Modifier.size(AidenUi.MinimumTouchTarget)) {
                    Icon(Icons.Default.Close, contentDescription = "Clear search", tint = palette.secondary, modifier = Modifier.size(16.dp))
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AidenBotHomeRowView(
    row: AidenBotHomeRow,
    coordinator: AidenRemoteCoordinator,
    canDelete: Boolean,
    onOpen: () -> Unit,
    onOpenProfile: () -> Unit,
    onDelete: () -> Unit
) {
    val palette = AidenTheme.palette
    var menuOpen by remember { mutableStateOf(false) }
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp)
                .clip(RoundedCornerShape(16.dp))
                .combinedClickable(
                    role = Role.Button,
                    onClickLabel = "Open chat",
                    onLongClickLabel = "More options",
                    onClick = onOpen,
                    onLongClick = { menuOpen = true }
                )
                .padding(horizontal = 12.dp, vertical = 12.dp)
        ) {
            Box {
                AidenBotCanonicalAvatarView(
                    coordinator = coordinator,
                    botId = row.bot.id,
                    avatar = row.bot.avatar,
                    name = row.bot.name,
                    size = 52.dp
                )
                if (row.isWorking) {
                    Box(
                        Modifier
                            .align(Alignment.BottomEnd)
                            .size(14.dp)
                            .clip(CircleShape)
                            .background(palette.canvas)
                            .padding(2.dp)
                            .clip(CircleShape)
                            .background(palette.success)
                            .semantics { contentDescription = "Working" }
                    )
                }
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                        Text(
                            text = row.bot.name,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = palette.foreground,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false)
                        )
                        if (row.bot.purpose.isNotBlank()) {
                            Spacer(Modifier.width(8.dp))
                            Surface(
                                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                                shape = RoundedCornerShape(8.dp),
                                modifier = Modifier.weight(1f, fill = false)
                            ) {
                                Text(
                                    text = row.bot.purpose,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = palette.secondary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                                )
                            }
                        }
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = aidenBotRowTime(row.updatedAt),
                        style = MaterialTheme.typography.labelSmall,
                        color = palette.secondary
                    )
                }
                Spacer(Modifier.height(3.dp))
                Text(
                    text = row.preview,
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.secondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        DropdownMenu(
            expanded = menuOpen,
            onDismissRequest = { menuOpen = false },
            containerColor = palette.raised
        ) {
            DropdownMenuItem(
                text = { Text("Profile") },
                leadingIcon = { Icon(Icons.Default.Person, contentDescription = null) },
                onClick = {
                    menuOpen = false
                    onOpenProfile()
                }
            )
            if (canDelete) {
                DropdownMenuItem(
                    text = { Text("Delete", color = palette.danger) },
                    leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, tint = palette.danger) },
                    onClick = {
                        menuOpen = false
                        onDelete()
                    }
                )
            }
        }
    }
}
