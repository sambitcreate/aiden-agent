package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarView
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileDocument
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileEntry
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileIndex
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileKind
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonBlock
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi

/** Composer placeholder for a Bot chat. */
fun aidenBotChatPlaceholder(name: String?): String =
    "Ask ${name?.trim()?.ifEmpty { null } ?: "your Bot"}"

object AidenBotChatHeaderTags {
    const val PILL = "bot_chat_header_pill"
}

/** What the Bot chat header shows for a Bot: the known name and avatar, if any. */
data class AidenBotChatIdentity(
    val botId: String,
    val name: String,
    val avatar: AidenBotAvatarView?
)

/** Looks a Bot up in the saved snapshot so the header renders before the Mac answers. */
@Composable
fun rememberAidenBotChatIdentity(coordinator: AidenRemoteCoordinator, botId: String, fallbackName: String): AidenBotChatIdentity {
    val list by coordinator.botCache.botList.collectAsStateWithLifecycle()
    val details by coordinator.botCache.botDetails.collectAsStateWithLifecycle()
    val summary = list?.bots?.firstOrNull { it.id == botId }
    val detail = details[botId]
    return AidenBotChatIdentity(
        botId = botId,
        name = detail?.name ?: summary?.name ?: fallbackName.ifBlank { "Bot" },
        avatar = detail?.avatar ?: summary?.avatar
    )
}

/**
 * Bot chat top bar: back, a pill with the Bot's avatar and name that opens its Profile,
 * Stop while it is working, and ••• with Profile, Files and (when the Mac allows) Delete.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotChatTopBar(
    identity: AidenBotChatIdentity,
    coordinator: AidenRemoteCoordinator?,
    isStreaming: Boolean,
    canStop: Boolean,
    onStop: () -> Unit,
    onBack: () -> Unit,
    onOpenProfile: () -> Unit,
    /** Null hides Files, for chats with no file index (the durable session). */
    onOpenFiles: (() -> Unit)?,
    canDelete: Boolean,
    onDelete: () -> Unit
) {
    val palette = AidenTheme.palette
    var menuOpen by remember { mutableStateOf(false) }
    val openProfileLabel = stringResource(R.string.bot_chat_open_profile_cd, identity.name)
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back), tint = palette.foreground)
            }
        },
        title = {
            Surface(
                onClick = onOpenProfile,
                shape = CircleShape,
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                modifier = Modifier
                    .testTag(AidenBotChatHeaderTags.PILL)
                    .semantics { contentDescription = openProfileLabel }
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.heightIn(min = 40.dp).padding(start = 6.dp, end = 14.dp)
                ) {
                    val avatar = identity.avatar
                    if (avatar != null) {
                        AidenBotCanonicalAvatarView(
                            coordinator = coordinator,
                            botId = identity.botId,
                            avatar = avatar,
                            name = "",
                            size = 28.dp
                        )
                        Spacer(Modifier.width(8.dp))
                    } else {
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(
                        text = identity.name,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.foreground,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        },
        actions = {
            if (isStreaming) {
                IconButton(onClick = onStop, enabled = canStop) {
                    Icon(Icons.Default.Stop, contentDescription = stringResource(R.string.action_stop), tint = palette.danger)
                }
            }
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(Icons.Default.MoreHoriz, contentDescription = stringResource(R.string.action_more_options), tint = palette.foreground)
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, containerColor = palette.raised) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.bot_menu_profile)) },
                        leadingIcon = { Icon(Icons.Default.Person, contentDescription = null) },
                        onClick = {
                            menuOpen = false
                            onOpenProfile()
                        }
                    )
                    if (onOpenFiles != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.bot_menu_files)) },
                            leadingIcon = { Icon(Icons.Default.Folder, contentDescription = null) },
                            onClick = {
                                menuOpen = false
                                onOpenFiles()
                            }
                        )
                    }
                    if (canDelete) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.action_delete), color = palette.danger) },
                            leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, tint = palette.danger) },
                            onClick = {
                                menuOpen = false
                                onDelete()
                            }
                        )
                    }
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas, titleContentColor = palette.foreground)
    )
}

/** Read-only list of the files this Bot's chat has made, with a simple viewer. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotFilesSheet(
    chatId: String,
    coordinator: AidenRemoteCoordinator,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsStateWithLifecycle()
    var index by remember(chatId) { mutableStateOf<AidenWorkspaceFileIndex?>(null) }
    var document by remember(chatId) { mutableStateOf<AidenWorkspaceFileDocument?>(null) }
    var message by remember(chatId) { mutableStateOf<String?>(null) }

    LaunchedEffect(chatId, client) {
        val cl = client ?: run {
            message = resources.getString(R.string.bot_files_connect)
            return@LaunchedEffect
        }
        // The pairing this read belongs to; a removed or switched pairing never gets it back.
        val requestInstance = coordinator.activeInstanceId
        try {
            val files = cl.botConversationFiles(chatId)
            if (!coordinator.holdsReadAuthority(cl, requestInstance)) return@LaunchedEffect
            index = files
            message = null
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            message = resources.getString(R.string.bot_files_unavailable)
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = palette.raised) {
        Column(Modifier.fillMaxWidth().padding(horizontal = AidenUi.ScreenGutter).padding(bottom = 24.dp)) {
            val open = document
            Text(
                text = open?.displayPath ?: stringResource(R.string.bot_menu_files),
                style = MaterialTheme.typography.titleLarge,
                color = palette.foreground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(bottom = 12.dp)
            )
            when {
                open != null -> {
                    Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState())) {
                        Text(open.content, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = palette.foreground)
                    }
                    TextButton(onClick = { document = null }) { Text(stringResource(R.string.bot_files_back), color = palette.accent) }
                }
                message != null -> Text(message.orEmpty(), color = palette.secondary)
                index == null -> {
                    val loadingDescription = stringResource(R.string.bot_files_loading)
                    Column(
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.clearAndSetSemantics { contentDescription = loadingDescription }
                    ) {
                        repeat(3) { AidenSkeletonBlock(height = 48.dp, shape = MaterialTheme.shapes.medium) }
                    }
                }
                else -> {
                    val entries = index?.entries.orEmpty()
                    if (entries.isEmpty()) {
                        Text(stringResource(R.string.bot_files_empty), color = palette.secondary)
                    } else {
                        LazyColumn(Modifier.heightIn(max = 480.dp)) {
                            items(entries, key = { it.id }) { entry ->
                                AidenBotFileRow(entry) {
                                    val cl = client ?: return@AidenBotFileRow
                                    if (entry.kind != AidenWorkspaceFileKind.FILE) return@AidenBotFileRow
                                    scope.launch {
                                        try {
                                            document = cl.botConversationFile(chatId, entry.id)
                                        } catch (e: CancellationException) {
                                            throw e
                                        } catch (_: Exception) {
                                            message = resources.getString(R.string.bot_files_open_failed)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AidenBotFileRow(entry: AidenWorkspaceFileEntry, onClick: () -> Unit) {
    val palette = AidenTheme.palette
    Surface(onClick = onClick, color = palette.raised, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.heightIn(min = 48.dp).padding(horizontal = 8.dp)) {
            Icon(
                if (entry.kind == AidenWorkspaceFileKind.FILE) Icons.Default.InsertDriveFile else Icons.Default.Folder,
                contentDescription = null,
                tint = palette.secondary,
                modifier = Modifier.size(20.dp)
            )
            Spacer(Modifier.width(12.dp))
            Text(entry.displayPath, color = palette.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
