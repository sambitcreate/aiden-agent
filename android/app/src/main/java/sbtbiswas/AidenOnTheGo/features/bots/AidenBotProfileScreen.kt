package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupOrientation
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenGroupItemShape
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import androidx.lifecycle.compose.collectAsStateWithLifecycle

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
    onNavigateToCustomAccess: ((String) -> Unit)? = null,
    onBotMutated: () -> Unit = {}
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsStateWithLifecycle()
    val connectionState by coordinator.connectionState.collectAsStateWithLifecycle()

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
                                            coordinator.botCache.putBotDetail(res.detail)
                                            onBotMutated()
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
                    .aidenReadableWidth()
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
                        shape = AidenShape.Button,
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

                AidenBotProfileActionBar(
                    actions = listOf(
                        AidenBotProfileAction(
                            label = "Chat",
                            icon = Icons.Default.Chat,
                            enabled = bot.health == AidenBotHealth.READY,
                            emphasized = true,
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
                            }
                        ),
                        AidenBotProfileAction(
                            label = "Edit",
                            icon = Icons.Default.Edit,
                            onClick = { onNavigateToEditBot(botId) }
                        ),
                        AidenBotProfileAction(
                            label = "Access",
                            icon = Icons.Default.Shield,
                            onClick = {
                                if (onNavigateToCustomAccess != null) {
                                    onNavigateToCustomAccess(botId)
                                } else {
                                    onNavigateToEditBot(botId)
                                }
                            }
                        ),
                        AidenBotProfileAction(
                            label = if (isFavorite) "Unpin" else "Pin",
                            icon = if (isFavorite) Icons.Default.Star else Icons.Default.StarBorder,
                            iconTint = if (isFavorite) palette.accent else null,
                            onClick = onClick@{
                                val cl = client ?: return@onClick
                                val favs = favorites ?: return@onClick
                                scope.launch {
                                    val next = if (isFavorite) {
                                        favoriteList.filter { it != botId }
                                    } else {
                                        (favoriteList + botId).take(AidenBotWire.MAX_FAVORITES)
                                    }
                                    try {
                                        val updated = cl.updateFavorites(next, favs.revision)
                                        favorites = updated
                                        onBotMutated()
                                    } catch (e: Exception) {
                                        actionError = e.message
                                    }
                                }
                            }
                        )
                    )
                )

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
                                    border = null,
                                    onClick = {
                                        val cl = client ?: return@OutlinedButton
                                        val favs = favorites ?: return@OutlinedButton
                                        val next = aidenBotFavoriteOrder(favoriteList, botId, AidenBotFavoriteOrderMove.EARLIER)
                                        scope.launch {
                                            try {
                                                val updated = cl.updateFavorites(next, favs.revision)
                                                favorites = updated
                                                onBotMutated()
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
                                    border = null,
                                    onClick = {
                                        val cl = client ?: return@OutlinedButton
                                        val favs = favorites ?: return@OutlinedButton
                                        val next = aidenBotFavoriteOrder(favoriteList, botId, AidenBotFavoriteOrderMove.LATER)
                                        scope.launch {
                                            try {
                                                val updated = cl.updateFavorites(next, favs.revision)
                                                favorites = updated
                                                onBotMutated()
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

                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = "Recent Chats",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        color = palette.secondary,
                        modifier = Modifier.padding(horizontal = 4.dp)
                    )

                    AidenConnectedColumn {
                        if (conversations.isEmpty()) {
                            AidenGroupCard(index = 0, count = 1, role = null) {
                                Text(
                                    text = "No conversation history yet.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = palette.secondary
                                )
                            }
                        } else {
                            conversations.forEachIndexed { index, conv ->
                                AidenGroupCard(
                                    index = index,
                                    count = conversations.size,
                                    onClick = { onNavigateToChat(conv.chatId) },
                                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                                ) {
                                    Icon(Icons.Default.ChatBubbleOutline, contentDescription = null, tint = palette.accent, modifier = Modifier.size(20.dp))
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
                AidenDialogConfirmButton(
                    text = "Archive Bot",
                    destructive = true,
                    onClick = onClick@{
                        isConfirmingArchive = false
                        val cl = client ?: return@onClick
                        val b = bot ?: return@onClick
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
                                coordinator.botCache.putBotDetail(res.detail)
                                onBotMutated()
                            } catch (e: Exception) {
                                actionError = e.message
                            }
                        }
                    }
                )
            },
            dismissButton = {
                AidenDialogDismissButton(onClick = { isConfirmingArchive = false })
            },
            shape = AidenShape.Dialog,
            containerColor = palette.raised
        )
    }
}

data class AidenBotProfileAction(
    val label: String,
    val icon: ImageVector,
    val onClick: () -> Unit,
    val enabled: Boolean = true,
    val emphasized: Boolean = false,
    val iconTint: Color? = null
)

/**
 * Connected horizontal group of filled tonal squircles. The emphasized action takes the
 * accent tonal fill; the others sit on the high tonal tier.
 */
@Composable
fun AidenBotProfileActionBar(
    actions: List<AidenBotProfileAction>,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
    ) {
        actions.forEachIndexed { index, action ->
            val interaction = remember { MutableInteractionSource() }
            val ink = if (action.emphasized) palette.accent else palette.foreground
            Surface(
                onClick = action.onClick,
                enabled = action.enabled,
                shape = aidenGroupItemShape(index, actions.size, orientation = AidenGroupOrientation.HORIZONTAL),
                color = if (action.emphasized) palette.accent.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHigh,
                interactionSource = interaction,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .tactilePress(interaction)
                    .alpha(if (action.enabled) 1f else 0.38f)
                    .semantics { role = Role.Button }
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 12.dp)
                ) {
                    Icon(action.icon, contentDescription = null, tint = action.iconTint ?: ink, modifier = Modifier.size(20.dp))
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = action.label,
                        color = ink,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }
    }
}
