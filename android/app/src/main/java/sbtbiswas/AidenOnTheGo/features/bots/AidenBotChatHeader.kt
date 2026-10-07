package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarView
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileDocument
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileEntry
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileIndex
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileKind
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
    onOpenFiles: () -> Unit,
    canDelete: Boolean,
    onDelete: () -> Unit
) {
    val palette = AidenTheme.palette
    var menuOpen by remember { mutableStateOf(false) }
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = palette.foreground)
            }
        },
        title = {
            Surface(
                onClick = onOpenProfile,
                shape = RoundedCornerShape(50),
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                modifier = Modifier
                    .testTag(AidenBotChatHeaderTags.PILL)
                    .semantics { contentDescription = "Open ${identity.name}’s profile" }
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
                    Icon(Icons.Default.Stop, contentDescription = "Stop", tint = palette.danger)
                }
            }
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(Icons.Default.MoreHoriz, contentDescription = "More options", tint = palette.foreground)
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, containerColor = palette.raised) {
                    DropdownMenuItem(
                        text = { Text("Profile") },
                        leadingIcon = { Icon(Icons.Default.Person, contentDescription = null) },
                        onClick = {
                            menuOpen = false
                            onOpenProfile()
                        }
                    )
                    DropdownMenuItem(
                        text = { Text("Files") },
                        leadingIcon = { Icon(Icons.Default.Folder, contentDescription = null) },
                        onClick = {
                            menuOpen = false
                            onOpenFiles()
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
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsStateWithLifecycle()
    var index by remember(chatId) { mutableStateOf<AidenWorkspaceFileIndex?>(null) }
    var document by remember(chatId) { mutableStateOf<AidenWorkspaceFileDocument?>(null) }
    var message by remember(chatId) { mutableStateOf<String?>(null) }

    LaunchedEffect(chatId, client) {
        val cl = client ?: run {
            message = "Connect to your Mac to see files."
            return@LaunchedEffect
        }
        try {
            index = cl.botConversationFiles(chatId)
            message = null
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            message = "Files aren’t available for this Bot right now."
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = palette.raised) {
        Column(Modifier.fillMaxWidth().padding(horizontal = AidenUi.ScreenGutter).padding(bottom = 24.dp)) {
            val open = document
            Text(
                text = open?.displayPath ?: "Files",
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
                    TextButton(onClick = { document = null }) { Text("Back to files", color = palette.accent) }
                }
                message != null -> Text(message.orEmpty(), color = palette.secondary)
                index == null -> CircularProgressIndicator(color = palette.accent)
                else -> {
                    val entries = index?.entries.orEmpty()
                    if (entries.isEmpty()) {
                        Text("No files yet.", color = palette.secondary)
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
                                            message = "Aiden couldn’t open that file."
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
    Surface(onClick = onClick, color = palette.raised, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
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
