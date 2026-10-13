package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.SdStorage
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenBotMemoryEntry
import sbtbiswas.AidenOnTheGo.models.AidenBotMemoryStore
import sbtbiswas.AidenOnTheGo.models.AidenBotMemoryTarget
import sbtbiswas.AidenOnTheGo.models.AidenBotMemoryWire
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonBlock
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors

/**
 * Profile → Memory (`bot-memory-v1`): what the Bot remembers about the person ("About you")
 * and its own notes, each with a usage meter, Edit and Delete, plus Erase memory.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotMemoryScreen(
    botId: String,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsStateWithLifecycle()
    val name = rememberAidenBotChatIdentity(coordinator, botId, "").name
    val cl = client
    val controller = remember(botId, cl) { cl?.let { AidenBotMemoryController(botId, AidenRemoteBotMemoryTransport(it)) } }
    LaunchedEffect(controller) { controller?.load() }
    val ui = controller?.state?.collectAsStateWithLifecycle()?.value
    var confirmingErase by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = palette.canvas,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.bot_memory_title)) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back), tint = palette.foreground)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas)
            )
        }
    ) { padding ->
        val view = ui?.view
        when {
            controller == null || ui == null -> AidenEmptyState(
                icon = Icons.Default.CloudOff,
                title = stringResource(R.string.bot_memory_title),
                body = stringResource(R.string.bot_memory_connect),
                modifier = Modifier.fillMaxSize().padding(padding)
            )
            view == null && ui.isLoading -> AidenBotMemorySkeleton(Modifier.padding(padding))
            view == null -> AidenEmptyState(
                icon = Icons.Default.CloudOff,
                title = stringResource(R.string.bot_memory_title),
                body = stringResource(R.string.bot_memory_load_failed),
                modifier = Modifier.fillMaxSize().padding(padding),
                action = { AidenTonalButton(text = stringResource(R.string.action_try_again), onClick = { scope.launch { controller.load() } }) }
            )
            else -> Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .aidenReadableWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp)
            ) {
                Text(
                    stringResource(R.string.bot_memory_description, name),
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.secondary
                )
                if (!view.readable) {
                    AidenBotMemoryUnreadableCallout(name = name)
                } else {
                    AidenBotMemoryGroup(
                        title = stringResource(R.string.bot_memory_about_you),
                        store = view.user,
                        empty = stringResource(R.string.bot_memory_empty_user, name),
                        deleting = ui.deleting,
                        onEdit = { controller.beginEdit(AidenBotMemoryTarget.USER, it) },
                        onDelete = { scope.launch { controller.delete(AidenBotMemoryTarget.USER, it.id) } }
                    )
                    AidenBotMemoryGroup(
                        title = stringResource(R.string.bot_memory_notes, name),
                        store = view.memory,
                        empty = stringResource(R.string.bot_memory_empty_notes, name),
                        deleting = ui.deleting,
                        onEdit = { controller.beginEdit(AidenBotMemoryTarget.MEMORY, it) },
                        onDelete = { scope.launch { controller.delete(AidenBotMemoryTarget.MEMORY, it.id) } }
                    )
                }
                ui.actionError?.let { error ->
                    Text(
                        aidenBotMemoryActionErrorText(error),
                        color = palette.danger,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                if (ui.eraseFailed) {
                    Text(
                        stringResource(R.string.bot_memory_erase_failed),
                        color = palette.danger,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                AidenTonalButton(
                    text = stringResource(R.string.bot_memory_erase),
                    destructive = true,
                    enabled = !ui.isErasing,
                    onClick = { confirmingErase = true }
                )
            }
        }
    }

    val editing = ui?.editing
    if (controller != null && editing != null) {
        val groupName = when (editing.target) {
            AidenBotMemoryTarget.USER -> stringResource(R.string.bot_memory_about_you)
            AidenBotMemoryTarget.MEMORY -> stringResource(R.string.bot_memory_notes, name)
        }
        AlertDialog(
            onDismissRequest = controller::cancelEdit,
            title = { Text(stringResource(R.string.bot_memory_edit_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    TextField(
                        value = editing.text,
                        onValueChange = controller::updateDraft,
                        enabled = !editing.isSaving,
                        minLines = 3,
                        colors = aidenTextFieldColors(),
                        shape = MaterialTheme.shapes.large,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        supportingText = {
                            Text(
                                stringResource(
                                    R.string.bot_memory_edit_count,
                                    editing.text.codePointCount(0, editing.text.length),
                                    AidenBotMemoryWire.MAX_ENTRY_LENGTH
                                )
                            )
                        },
                        modifier = Modifier.fillMaxWidth()
                    )
                    editing.error?.let { error ->
                        Surface(color = palette.danger.copy(alpha = 0.12f), shape = MaterialTheme.shapes.medium) {
                            Text(
                                when (error) {
                                    AidenBotMemoryError.BLOCKED -> stringResource(R.string.bot_memory_error_blocked)
                                    AidenBotMemoryError.OVER_BUDGET -> stringResource(R.string.bot_memory_error_over_budget, groupName)
                                    AidenBotMemoryError.NOT_FOUND -> stringResource(R.string.bot_memory_error_not_found)
                                    AidenBotMemoryError.FAILED -> stringResource(R.string.bot_memory_error_failed)
                                },
                                color = palette.danger,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(12.dp)
                            )
                        }
                    }
                }
            },
            confirmButton = {
                AidenDialogConfirmButton(
                    text = if (editing.isSaving) stringResource(R.string.action_saving) else stringResource(R.string.action_save),
                    enabled = editing.canSave,
                    onClick = { scope.launch { controller.saveEdit() } }
                )
            },
            dismissButton = { AidenDialogDismissButton(onClick = controller::cancelEdit) },
            shape = AidenShape.Dialog,
            containerColor = palette.raised
        )
    }

    if (controller != null && confirmingErase) {
        AlertDialog(
            onDismissRequest = { confirmingErase = false },
            title = { Text(stringResource(R.string.bot_memory_erase_title, name)) },
            text = { Text(stringResource(R.string.bot_memory_erase_body)) },
            confirmButton = {
                AidenDialogConfirmButton(
                    text = stringResource(R.string.bot_memory_erase),
                    destructive = true,
                    enabled = ui?.isErasing != true,
                    onClick = {
                        confirmingErase = false
                        scope.launch { controller.erase() }
                    }
                )
            },
            dismissButton = { AidenDialogDismissButton(onClick = { confirmingErase = false }) },
            shape = AidenShape.Dialog,
            containerColor = palette.raised
        )
    }
}

@Composable
private fun aidenBotMemoryActionErrorText(error: AidenBotMemoryError): String = when (error) {
    AidenBotMemoryError.NOT_FOUND -> stringResource(R.string.bot_memory_error_not_found)
    AidenBotMemoryError.BLOCKED, AidenBotMemoryError.OVER_BUDGET, AidenBotMemoryError.FAILED ->
        stringResource(R.string.bot_memory_delete_failed)
}

/** One group: title, neutral usage meter, and its entries as rows with ⋮ Edit / Delete. */
@Composable
private fun AidenBotMemoryGroup(
    title: String,
    store: AidenBotMemoryStore,
    empty: String,
    deleting: Set<String>,
    onEdit: (AidenBotMemoryEntry) -> Unit,
    onDelete: (AidenBotMemoryEntry) -> Unit
) {
    val palette = AidenTheme.palette
    val (used, limit) = aidenBotMemoryUsageNumbers(store)
    val usage = stringResource(R.string.bot_memory_usage_cd, used, limit)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            title,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = palette.secondary,
            modifier = Modifier.padding(horizontal = 4.dp)
        )
        LinearProgressIndicator(
            progress = { aidenBotMemoryUsageFraction(store) },
            color = palette.secondary,
            trackColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            drawStopIndicator = {},
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp)
                .height(4.dp)
                .clip(MaterialTheme.shapes.extraSmall)
                .clearAndSetSemantics { contentDescription = usage }
        )
        Surface(color = palette.raised, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
            Column {
                if (store.entries.isEmpty()) {
                    Text(
                        empty,
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.secondary,
                        modifier = Modifier.padding(16.dp)
                    )
                }
                store.entries.forEachIndexed { index, entry ->
                    if (index > 0) HorizontalDivider(color = palette.canvas, modifier = Modifier.padding(start = 16.dp))
                    AidenBotMemoryRow(
                        entry = entry,
                        enabled = entry.id !in deleting,
                        onEdit = { onEdit(entry) },
                        onDelete = { onDelete(entry) }
                    )
                }
            }
        }
    }
}

@Composable
private fun AidenBotMemoryRow(
    entry: AidenBotMemoryEntry,
    enabled: Boolean,
    onEdit: () -> Unit,
    onDelete: () -> Unit
) {
    val palette = AidenTheme.palette
    var showMenu by remember { mutableStateOf(false) }
    ListItem(
        headlineContent = {
            Text(
                entry.text,
                style = MaterialTheme.typography.bodyLarge,
                color = if (enabled) palette.foreground else palette.secondary
            )
        },
        trailingContent = {
            Box {
                IconButton(onClick = { showMenu = true }, enabled = enabled) {
                    Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.bot_memory_entry_options), tint = palette.secondary)
                }
                DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }, containerColor = palette.raised) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_edit)) },
                        leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                        onClick = {
                            showMenu = false
                            onEdit()
                        }
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.action_delete), color = palette.danger) },
                        leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, tint = palette.danger) },
                        onClick = {
                            showMenu = false
                            onDelete()
                        }
                    )
                }
            }
        },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent)
    )
}

/** The memory files couldn't be read: Erase is the only way forward. */
@Composable
private fun AidenBotMemoryUnreadableCallout(name: String) {
    val palette = AidenTheme.palette
    Surface(color = palette.raised, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.Top) {
            Box(
                Modifier.size(36.dp).clip(AidenShape.Button).background(palette.warning.copy(alpha = 0.14f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Outlined.SdStorage, contentDescription = null, tint = palette.warning, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    stringResource(R.string.bot_memory_unreadable_title),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground
                )
                Text(
                    stringResource(R.string.bot_memory_unreadable_body, name),
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.secondary
                )
            }
        }
    }
}

@Composable
private fun AidenBotMemorySkeleton(modifier: Modifier = Modifier) {
    val loadingDescription = stringResource(R.string.bot_memory_loading)
    Column(
        verticalArrangement = Arrangement.spacedBy(16.dp),
        modifier = modifier
            .fillMaxSize()
            .aidenReadableWidth()
            .padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
            .clearAndSetSemantics { contentDescription = loadingDescription }
    ) {
        AidenSkeletonBlock(height = 14.dp)
        AidenSkeletonBlock(width = 220.dp, height = 14.dp)
        AidenSkeletonBlock(height = 160.dp, shape = MaterialTheme.shapes.large)
        AidenSkeletonBlock(height = 112.dp, shape = MaterialTheme.shapes.large)
    }
}
