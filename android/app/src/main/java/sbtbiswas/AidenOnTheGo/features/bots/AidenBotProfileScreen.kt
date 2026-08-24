package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

sealed class AidenBotProfileLifecycleAction {
    object Archive : AidenBotProfileLifecycleAction()
    data class Restore(val idempotencyKey: UUID = UUID.randomUUID()) : AidenBotProfileLifecycleAction()
}

data class AidenBotProfileLifecycleResult(
    val detail: AidenBotDetail,
    val favorites: AidenBotFavorites
)

suspend fun aidenBotProfileLifecycleUpdate(
    client: sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient,
    botId: String,
    revision: String,
    action: AidenBotProfileLifecycleAction
): AidenBotProfileLifecycleResult {
    val detail: AidenBotDetail = when (action) {
        is AidenBotProfileLifecycleAction.Archive -> client.archiveBot(botId, revision)
        is AidenBotProfileLifecycleAction.Restore -> client.restoreBot(botId, revision, action.idempotencyKey)
    }
    val favorites = client.botFavorites()
    return AidenBotProfileLifecycleResult(detail = detail, favorites = favorites)
}

fun aidenBotConversationCanDelete(
    conversation: AidenBotConversationItem,
    botHealth: AidenBotHealth,
    canWrite: Boolean
): Boolean {
    return canWrite && botHealth != AidenBotHealth.ARCHIVED && conversation.activityState == AidenBotConversationActivityState.IDLE
}

data class AidenBotConversationSelectionAccessibility(
    val value: String,
    val isSelected: Boolean,
    val hint: String
)

fun aidenBotConversationSelectionAccessibility(
    isSelecting: Boolean,
    isSelected: Boolean,
    canDelete: Boolean,
    botHealth: AidenBotHealth,
    canWrite: Boolean,
    activityState: AidenBotConversationActivityState
): AidenBotConversationSelectionAccessibility {
    if (!isSelecting) {
        return AidenBotConversationSelectionAccessibility(value = "", isSelected = false, hint = "Opens this chat.")
    }
    val hint = when {
        botHealth == AidenBotHealth.ARCHIVED -> "Archived Bot chats are read-only."
        !canWrite -> "Reconnect or refresh before selecting chats."
        activityState != AidenBotConversationActivityState.IDLE -> "Active chats cannot be deleted."
        canDelete -> "Selects this chat for deletion."
        else -> "This chat cannot be deleted."
    }
    return AidenBotConversationSelectionAccessibility(
        value = if (isSelected) "Selected" else "Not selected",
        isSelected = isSelected,
        hint = hint
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotProfileScreen(
    botId: String,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onNavigateToChat: (String) -> Unit,
    onNavigateToEditBot: (String) -> Unit,
    onNavigateToCustomAccess: ((String) -> Unit)? = null
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsState()
    val connectionState by coordinator.connectionState.collectAsState()

    var botDetail by remember { mutableStateOf<AidenBotDetail?>(null) }
    var favorites by remember { mutableStateOf<AidenBotFavorites?>(null) }
    var conversations by remember { mutableStateOf<List<AidenBotConversationItem>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var isConfirmingArchive by remember { mutableStateOf(false) }
    var showMenu by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }

    fun refresh() {
        val cl = client ?: return
        scope.launch {
            isLoading = true
            try {
                val b = cl.bot(botId)
                botDetail = b
                val fav = cl.botFavorites()
                favorites = fav
                val page = cl.botConversations(botId = botId)
                conversations = aidenCanonicalBotConversations(page.conversations)
            } catch (_: Exception) {} finally {
                isLoading = false
            }
        }
    }

    LaunchedEffect(client, botId, connectionState) {
        if (client != null) {
            refresh()
        }
    }

    val bot = botDetail
    val isFavorite = favorites?.botIds?.contains(botId) == true
    val favoriteList = favorites?.botIds ?: emptyList()
    val favoriteIndex = favoriteList.indexOf(botId)
    val isArchived = bot?.health == AidenBotHealth.ARCHIVED

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Bot Profile", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back", tint = palette.foreground)
                    }
                },
                actions = {
                    IconButton(onClick = { showMenu = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "Options", tint = palette.foreground)
                    }
                    DropdownMenu(
                        expanded = showMenu,
                        onDismissRequest = { showMenu = false },
                        modifier = Modifier.background(palette.raised)
                    ) {
                        if (!isArchived) {
                            DropdownMenuItem(
                                text = { Text("Archive Bot", color = palette.danger) },
                                onClick = {
                                    showMenu = false
                                    isConfirmingArchive = true
                                },
                                leadingIcon = {
                                    Icon(Icons.Default.Archive, contentDescription = null, tint = palette.danger)
                                }
                            )
                        } else {
                            DropdownMenuItem(
                                text = { Text("Restore Bot", color = palette.accent) },
                                onClick = {
                                    showMenu = false
                                    val cl = client ?: return@DropdownMenuItem
                                    val b = bot ?: return@DropdownMenuItem
                                    scope.launch {
                                        try {
                                            val res = aidenBotProfileLifecycleUpdate(
                                                client = cl,
                                                botId = botId,
                                                revision = b.revision,
                                                action = AidenBotProfileLifecycleAction.Restore()
                                            )
                                            botDetail = res.detail
                                            favorites = res.favorites
                                        } catch (e: Exception) {
                                            actionError = e.message
                                        }
                                    }
                                },
                                leadingIcon = {
                                    Icon(Icons.Default.Unarchive, contentDescription = null, tint = palette.accent)
                                }
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = palette.canvas,
                    titleContentColor = palette.foreground
                )
            )
        },
        containerColor = palette.canvas
    ) { padding ->
        if (isLoading) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = palette.accent)
            }
        } else if (bot != null) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(20.dp)
            ) {
                // Header: Large Avatar, Name, Purpose
                AidenBotCanonicalAvatarView(
                    coordinator = coordinator,
                    botId = bot.id,
                    avatar = bot.avatar,
                    name = bot.name,
                    size = 112.dp
                )

                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        text = bot.name,
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                        color = palette.foreground
                    )
                    if (bot.purpose.isNotEmpty()) {
                        Text(
                            text = bot.purpose,
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.secondary
                        )
                    }
                }

                if (isArchived) {
                    Surface(
                        color = palette.warning.copy(alpha = 0.15f),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(12.dp)
                        ) {
                            Icon(Icons.Default.Archive, contentDescription = null, tint = palette.warning, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Archived — chats are read-only", style = MaterialTheme.typography.bodySmall, color = palette.warning)
                        }
                    }
                }

                // 4-Button Action Bar
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    // 1. Chat button
                    Button(
                        onClick = {
                            scope.launch {
                                val existing = conversations.firstOrNull { it.botId == bot.id }
                                if (existing != null) {
                                    onNavigateToChat(existing.chatId)
                                } else {
                                    val cl = client ?: return@launch
                                    try {
                                        val created = cl.createBotChat(bot.id)
                                        onNavigateToChat(created.id)
                                    } catch (_: Exception) {}
                                }
                            }
                        },
                        enabled = bot.health == AidenBotHealth.READY,
                        colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.weight(1f)
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Default.Chat, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
                            Spacer(modifier = Modifier.height(2.dp))
                            Text("Chat", color = Color.White, style = MaterialTheme.typography.labelSmall)
                        }
                    }

                    // 2. Edit button
                    OutlinedButton(
                        onClick = { onNavigateToEditBot(botId) },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.weight(1f)
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Default.Edit, contentDescription = null, tint = palette.foreground, modifier = Modifier.size(20.dp))
                            Spacer(modifier = Modifier.height(2.dp))
                            Text("Edit", color = palette.foreground, style = MaterialTheme.typography.labelSmall)
                        }
                    }

                    // 3. Access button
                    OutlinedButton(
                        onClick = {
                            if (onNavigateToCustomAccess != null) {
                                onNavigateToCustomAccess(botId)
                            } else {
                                onNavigateToEditBot(botId)
                            }
                        },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.weight(1f)
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Default.Shield, contentDescription = null, tint = palette.foreground, modifier = Modifier.size(20.dp))
                            Spacer(modifier = Modifier.height(2.dp))
                            Text("Access", color = palette.foreground, style = MaterialTheme.typography.labelSmall)
                        }
                    }

                    // 4. Pin / Favorite button
                    OutlinedButton(
                        onClick = {
                            val cl = client ?: return@OutlinedButton
                            val favs = favorites ?: return@OutlinedButton
                            scope.launch {
                                val next = if (isFavorite) {
                                    favoriteList.filter { it != botId }
                                } else {
                                    (favoriteList + botId).take(AidenBotWire.MAX_FAVORITES)
                                }
                                try {
                                    val updated = cl.updateFavorites(next, favs.revision)
                                    favorites = updated
                                } catch (e: Exception) {
                                    actionError = e.message
                                }
                            }
                        },
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.weight(1f)
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(
                                imageVector = if (isFavorite) Icons.Default.Star else Icons.Default.StarBorder,
                                contentDescription = null,
                                tint = if (isFavorite) palette.accent else palette.foreground,
                                modifier = Modifier.size(20.dp)
                            )
                            Spacer(modifier = Modifier.height(2.dp))
                            Text(if (isFavorite) "Unpin" else "Pin", color = palette.foreground, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }

                // Favorite Order Card (if favorite)
                if (isFavorite && favoriteIndex >= 0) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = palette.raised),
                        shape = RoundedCornerShape(14.dp)
                    ) {
                        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    text = "Favorite Order",
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.Bold,
                                    color = palette.foreground,
                                    modifier = Modifier.weight(1f)
                                )
                                Text(
                                    text = "${favoriteIndex + 1} of ${favoriteList.size}",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = palette.secondary
                                )
                            }
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(10.dp)
                            ) {
                                OutlinedButton(
                                    onClick = {
                                        val cl = client ?: return@OutlinedButton
                                        val favs = favorites ?: return@OutlinedButton
                                        val next = aidenBotFavoriteOrder(favoriteList, botId, AidenBotFavoriteOrderMove.EARLIER)
                                        scope.launch {
                                            try {
                                                val updated = cl.updateFavorites(next, favs.revision)
                                                favorites = updated
                                            } catch (_: Exception) {}
                                        }
                                    },
                                    enabled = favoriteIndex > 0,
                                    modifier = Modifier.weight(1f),
                                    shape = RoundedCornerShape(10.dp)
                                ) {
                                    Icon(Icons.Default.ArrowBack, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text("Move Earlier")
                                }

                                OutlinedButton(
                                    onClick = {
                                        val cl = client ?: return@OutlinedButton
                                        val favs = favorites ?: return@OutlinedButton
                                        val next = aidenBotFavoriteOrder(favoriteList, botId, AidenBotFavoriteOrderMove.LATER)
                                        scope.launch {
                                            try {
                                                val updated = cl.updateFavorites(next, favs.revision)
                                                favorites = updated
                                            } catch (_: Exception) {}
                                        }
                                    },
                                    enabled = favoriteIndex < favoriteList.size - 1,
                                    modifier = Modifier.weight(1f),
                                    shape = RoundedCornerShape(10.dp)
                                ) {
                                    Text("Move Later")
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Icon(Icons.Default.ArrowForward, contentDescription = null, modifier = Modifier.size(16.dp))
                                }
                            }
                        }
                    }
                }

                // Chat History Section Card
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = palette.raised),
                    shape = RoundedCornerShape(14.dp)
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(
                            text = "Recent Chats",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                            color = palette.secondary
                        )

                        if (conversations.isEmpty()) {
                            Text(
                                text = "No conversation history yet.",
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.secondary
                            )
                        } else {
                            conversations.forEach { conv ->
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable { onNavigateToChat(conv.chatId) }
                                        .padding(vertical = 8.dp)
                                ) {
                                    Icon(Icons.Default.ChatBubbleOutline, contentDescription = null, tint = palette.accent, modifier = Modifier.size(20.dp))
                                    Spacer(modifier = Modifier.width(10.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(
                                            text = conv.title.ifEmpty { "Chat" },
                                            style = MaterialTheme.typography.bodyMedium,
                                            fontWeight = FontWeight.SemiBold,
                                            color = palette.foreground,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis
                                        )
                                        conv.preview?.let {
                                            Text(
                                                text = it,
                                                style = MaterialTheme.typography.bodySmall,
                                                color = palette.secondary,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis
                                            )
                                        }
                                    }
                                    val time = DateTimeFormatter.ofPattern("MMM d")
                                        .withZone(ZoneId.systemDefault())
                                        .format(conv.updatedAt)
                                    Text(text = time, style = MaterialTheme.typography.labelSmall, color = palette.secondary)
                                }
                            }
                        }
                    }
                }

                // Greeting & Instructions Cards
                bot.openingGreeting?.let { greeting ->
                    if (greeting.isNotEmpty()) {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = palette.raised),
                            shape = RoundedCornerShape(14.dp)
                        ) {
                            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text("Greeting", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)
                                Text(greeting, style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
                            }
                        }
                    }
                }

                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = palette.raised),
                    shape = RoundedCornerShape(14.dp)
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Instructions", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)
                        Text(bot.instructions, style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
                    }
                }

                actionError?.let { err ->
                    Text(err, color = palette.danger, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }

    if (isConfirmingArchive) {
        AlertDialog(
            onDismissRequest = { isConfirmingArchive = false },
            title = { Text("Archive ${bot?.name ?: "Bot"}?") },
            text = { Text("Its chats stay available to read. Restore the Bot later to edit it or start new work.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        isConfirmingArchive = false
                        val cl = client ?: return@TextButton
                        val b = bot ?: return@TextButton
                        scope.launch {
                            try {
                                val res = aidenBotProfileLifecycleUpdate(
                                    client = cl,
                                    botId = botId,
                                    revision = b.revision,
                                    action = AidenBotProfileLifecycleAction.Archive
                                )
                                botDetail = res.detail
                                favorites = res.favorites
                            } catch (e: Exception) {
                                actionError = e.message
                            }
                        }
                    }
                ) {
                    Text("Archive Bot", color = palette.danger, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { isConfirmingArchive = false }) {
                    Text("Cancel", color = palette.secondary)
                }
            },
            containerColor = palette.raised
        )
    }
}
