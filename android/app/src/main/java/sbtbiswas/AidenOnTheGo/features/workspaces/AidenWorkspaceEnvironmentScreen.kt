package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupOrientation
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonList
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.aidenGroupItemShape
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalResources
import sbtbiswas.AidenOnTheGo.R
import androidx.compose.ui.res.pluralStringResource
import sbtbiswas.AidenOnTheGo.ui.theme.AidenButtonDefaults

private val AidenFileTreeStep = 14.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenWorkspaceEnvironmentScreen(
    workspaceId: String,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    initialReference: String? = null
) {
    val currentClient = coordinator.client.collectAsStateWithLifecycle().value
    key(workspaceId, coordinator.activeInstanceId, currentClient) {
        AidenWorkspaceFilesContent(workspaceId, coordinator, onNavigateBack, initialReference)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AidenWorkspaceFilesContent(workspaceId: String, coordinator: AidenRemoteCoordinator, onNavigateBack: () -> Unit, initialReference: String?) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val client = coordinator.client.collectAsStateWithLifecycle().value
    val connectionState = coordinator.connectionState.collectAsStateWithLifecycle().value
    val cache = coordinator.workspaceCache
    val activeInstanceId = coordinator.activeInstanceId

    val remote = remember(client) { client?.let(::AidenRemoteClientWorkspaceFiles) }
    val connected = connectionState == AidenConnectionState.CONNECTED
    val strings = remember(resources) {
        AidenWorkspaceFilesStrings(
            treeLimit = resources.getString(R.string.files_tree_limit),
            openFailed = resources.getString(R.string.files_open_failed),
            staleFolderRecovery = resources.getString(R.string.files_stale_folder_recovery),
            staleFileRecovery = resources.getString(R.string.files_stale_file_recovery)
        )
    }
    val controller = remember(workspaceId, cache) {
        AidenWorkspaceFilesController(scope, workspaceId, cache, strings)
    }
    SideEffect {
        controller.bind(activeInstanceId, remote, connected, strings)
    }
    val state by controller.state.collectAsStateWithLifecycle()
    val expanded = state.expanded
    val loadingFolders = state.loadingFolders
    val cursors = state.cursors
    val isEditing = state.isEditing
    val fileIndex = state.fileIndex
    val selectedFile = state.selectedFile
    val draftContent = state.draftContent
    val isDirty = state.isDirty
    val isOfflineIndex = state.isOfflineIndex
    val isOfflineDocument = state.isOfflineDocument
    val isLoading = state.isLoading
    val isSaving = state.isSaving
    var searchQuery by remember { mutableStateOf("") }

    // Dialog States
    var showDiscardConfirmDialog by remember { mutableStateOf(false) }
    // System back mirrors the toolbar: leave an open file first, confirming unsaved edits.
    BackHandler(enabled = selectedFile != null) {
        if (isDirty) showDiscardConfirmDialog = true else controller.closeSelectedFile()
    }
    fun availability() = state.availability

    LaunchedEffect(remote, connected, workspaceId, activeInstanceId) {
        controller.bind(activeInstanceId, remote, connected, strings)
        if (state.fileIndex == null || (connected && state.isOfflineIndex)) {
            controller.refreshFiles()
        }
    }

    LaunchedEffect(initialReference, remote, connected) {
        if (initialReference != null) {
            controller.bind(activeInstanceId, remote, connected, strings)
            controller.openLinkedReference(initialReference)
        }
    }

    val filteredEntries = remember(fileIndex, searchQuery, expanded) {
        AidenWorkspaceFileTree.visible(fileIndex?.entries ?: emptyList(), expanded, searchQuery)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    val doc = selectedFile
                    if (doc != null) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = doc.displayPath,
                                fontWeight = FontWeight.Bold,
                                maxLines = 1
                            )
                            if (isDirty) {
                                Spacer(modifier = Modifier.width(4.dp))
                                Text("*", color = palette.accent, fontWeight = FontWeight.Bold)
                            }
                        }
                    } else {
                        Text(stringResource(R.string.files_title), fontWeight = FontWeight.Bold)
                    }
                },
                navigationIcon = {
                    IconButton(
                        onClick = {
                            if (selectedFile != null) {
                                if (isDirty) {
                                    showDiscardConfirmDialog = true
                                } else {
                                    controller.closeSelectedFile()
                                }
                            } else {
                                onNavigateBack()
                            }
                        }
                    ) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back), tint = palette.foreground)
                    }
                },
                actions = {
                    val doc = selectedFile
                    if (doc != null) {
                        if (!isEditing) {
                            AidenTonalButton(
                                text = stringResource(R.string.action_edit),
                                onClick = { controller.setEditing(true) },
                                enabled = availability().canEditDocument && client != null,
                                contentPadding = PaddingValues(horizontal = 16.dp),
                                modifier = Modifier.padding(end = 8.dp)
                            )
                        }
                        if (isDirty) {
                            AidenDiscardSavePair(
                                saving = isSaving,
                                saveEnabled = !isSaving && availability().canEditDocument,
                                onDiscard = { showDiscardConfirmDialog = true },
                                onSave = { controller.saveDocument() },
                                modifier = Modifier.padding(end = 8.dp)
                            )
                        }
                    } else {
                        IconButton(onClick = { controller.refreshFiles() }) {
                            Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.action_refresh), tint = palette.foreground)
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
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .aidenReadableWidth()
        ) {
            // Offline or Truncated Banner. A saved tree being revalidated is not "offline" yet.
            if (if (selectedFile != null) isOfflineDocument else isOfflineIndex && !isLoading) {
                Surface(
                    color = palette.warning.copy(alpha = 0.15f),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                    ) {
                        Icon(Icons.Default.CloudOff, contentDescription = null, tint = palette.warning, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = stringResource(R.string.files_offline_banner),
                            style = MaterialTheme.typography.bodySmall,
                            color = palette.foreground
                        )
                    }
                }
            }

            fileIndex?.let { idx ->
                if (idx.truncated) {
                    Surface(
                        color = palette.accent.copy(alpha = 0.15f),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                        ) {
                            Icon(Icons.Default.Info, contentDescription = null, tint = palette.accent, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = pluralStringResource(R.plurals.files_truncated_banner, idx.maxEntries, idx.maxEntries),
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.foreground
                            )
                        }
                    }
                }
            }

            val doc = selectedFile
            if (doc != null) {
                if (!isEditing) {
                    val lines = remember(doc.id, draftContent) { AidenWorkspaceSourcePreview.lines(draftContent) }
                    val gutterColor = MaterialTheme.colorScheme.surfaceContainerLow
                    LazyColumn(
                        Modifier
                            .fillMaxSize()
                            .background(palette.raised)
                            .drawBehind {
                                val inset = 8.dp.toPx()
                                drawRoundRect(
                                    color = gutterColor,
                                    topLeft = Offset(inset, inset),
                                    size = Size(52.dp.toPx(), size.height - inset * 2),
                                    cornerRadius = CornerRadius(12.dp.toPx())
                                )
                            }
                            .padding(16.dp)
                    ) {
                        items(lines.size) { index ->
                            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                                Text(
                                    "${index + 1}",
                                    color = palette.secondary,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 12.sp,
                                    textAlign = TextAlign.End,
                                    modifier = Modifier.width(36.dp)
                                )
                                Spacer(Modifier.width(16.dp))
                                androidx.compose.foundation.text.selection.SelectionContainer {
                                    Text(lines[index], color = palette.foreground, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                                }
                            }
                        }
                    }
                } else {
                // File Editor
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(palette.raised)
                        .padding(16.dp)
                ) {
                    BasicTextField(
                        value = draftContent,
                        onValueChange = { controller.updateDraft(it) },
                        textStyle = TextStyle(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp,
                            color = palette.foreground,
                            lineHeight = 20.sp
                        ),
                        cursorBrush = SolidColor(palette.accent),
                        readOnly = !availability().canEditDocument || client == null,
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                    )
                }
                }
            } else {
                // File Index List
                TextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    placeholder = { Text(stringResource(R.string.files_search_placeholder)) },
                    leadingIcon = { Icon(Icons.Default.Search, contentDescription = stringResource(R.string.action_search), tint = palette.secondary) },
                    trailingIcon = {
                        if (searchQuery.isNotEmpty()) {
                            IconButton(onClick = { searchQuery = "" }) {
                                Icon(Icons.Default.Clear, contentDescription = stringResource(R.string.action_clear), tint = palette.secondary)
                            }
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .clip(MaterialTheme.shapes.medium),
                    colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                    singleLine = true
                )

                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
                ) {
                    if (fileIndex == null && isLoading) {
                        item(key = "files-skeleton") {
                            AidenSkeletonList(count = 8, supporting = false, loadingDescription = stringResource(R.string.files_loading))
                        }
                    } else if (filteredEntries.isEmpty() && !isLoading) {
                        item {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(40.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Icon(Icons.Default.FolderOpen, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(48.dp))
                                    Spacer(modifier = Modifier.height(12.dp))
                                    Text(stringResource(R.string.files_no_matches), style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                                }
                            }
                        }
                    }

                    cursors.forEach { (path, _) ->
                        if (path.isEmpty() || path in expanded) {
                            item(key = "page:$path") {
                                TextButton(contentPadding = AidenButtonDefaults.TextContentPadding, onClick = { controller.loadPage(fileIndex?.entries?.firstOrNull { it.displayPath == path }) },
                                    enabled = path !in loadingFolders && availability().canLoadPage && !isLoading) {
                                    Text(if (path.isEmpty()) stringResource(R.string.files_load_more) else stringResource(R.string.files_load_more_in, path))
                                }
                            }
                        }
                    }
                    itemsIndexed(filteredEntries, key = { _, entry -> entry.displayPath }) { index, entry ->
                        AidenWorkspaceFileTreeRow(
                            entry = entry,
                            index = index,
                            count = filteredEntries.size,
                            expanded = entry.displayPath in expanded,
                            enabled = entry.kind != AidenWorkspaceFileKind.SYMLINK && entry.displayPath !in loadingFolders,
                            onClick = { controller.openEntry(entry) }
                        )
                    }
                }
            }
        }
    }

    // Discard Confirmation Dialog
    if (showDiscardConfirmDialog) {
        AidenWorkspaceAlertDialog(
            title = stringResource(R.string.files_discard_title),
            onDismissRequest = { showDiscardConfirmDialog = false },
            confirmText = stringResource(R.string.action_discard),
            dismissText = stringResource(R.string.files_keep_editing),
            destructive = true,
            onConfirm = {
                showDiscardConfirmDialog = false
                controller.closeSelectedFile(discardChanges = true)
            }
        ) {
            Text(stringResource(R.string.files_discard_body))
        }
    }

    // 409 Conflict Dialog
    if (state.showConflictDialog && selectedFile != null) {
        AidenWorkspaceAlertDialog(
            title = stringResource(R.string.files_conflict_title),
            onDismissRequest = { controller.dismissConflictDialog() },
            confirmText = stringResource(R.string.files_conflict_reload),
            onConfirm = { controller.reloadSelectedFile() }
        ) {
            Text(stringResource(R.string.files_conflict_body))
        }
    }

    // Error / Stale-Handle Recovery Dialog
    state.errorMessage?.let { message ->
        if (!showDiscardConfirmDialog && !state.showConflictDialog) {
            AidenWorkspaceAlertDialog(
                title = stringResource(R.string.files_title),
                onDismissRequest = { controller.dismissError() },
                confirmText = null,
                onConfirm = {},
                dismissText = stringResource(R.string.action_ok)
            ) {
                Text(message)
            }
        }
    }
}

/**
 * Connected Discard / Save pair for the file editor toolbar: a quiet tonal Discard segment
 * joined to the accent Save segment by a narrow seam.
 */
@Composable
private fun AidenDiscardSavePair(
    saving: Boolean,
    saveEnabled: Boolean,
    onDiscard: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val outer = 12.dp
    val discardInteraction = remember { MutableInteractionSource() }
    val saveInteraction = remember { MutableInteractionSource() }
    Row(
        modifier = modifier.height(40.dp),
        horizontalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
    ) {
        Surface(
            onClick = onDiscard,
            shape = aidenGroupItemShape(0, 2, outer, AidenShape.SplitInner, AidenGroupOrientation.HORIZONTAL),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = palette.foreground,
            interactionSource = discardInteraction,
            modifier = Modifier
                .fillMaxHeight()
                .tactilePress(discardInteraction)
                .semantics { role = Role.Button }
        ) {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(horizontal = 14.dp)) {
                Text(stringResource(R.string.action_discard), style = MaterialTheme.typography.labelLarge, color = palette.foreground)
            }
        }
        Surface(
            onClick = onSave,
            enabled = saveEnabled,
            shape = aidenGroupItemShape(1, 2, outer, AidenShape.SplitInner, AidenGroupOrientation.HORIZONTAL),
            color = if (saveEnabled || saving) palette.accentFill.fill else palette.accentFill.fill.copy(alpha = 0.4f),
            contentColor = palette.accentFill.content,
            interactionSource = saveInteraction,
            modifier = Modifier
                .fillMaxHeight()
                .tactilePress(saveInteraction)
                .semantics { role = Role.Button }
        ) {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(horizontal = 16.dp)) {
                // Saving waits for the desktop's version check, so it holds a pending label.
                Text(
                    if (saving) stringResource(R.string.action_saving) else stringResource(R.string.action_save),
                    style = MaterialTheme.typography.labelLarge,
                    color = palette.accentFill.content,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}

/**
 * One row of the workspace file tree. Nested rows draw a faint guide line per ancestor
 * level, and folders lead with a chevron that turns when expanded (instantly when motion
 * is reduced).
 */
@Composable
internal fun AidenWorkspaceFileTreeRow(
    entry: AidenWorkspaceFileEntry,
    index: Int,
    count: Int,
    expanded: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val isDirectory = entry.kind == AidenWorkspaceFileKind.DIRECTORY
    val depth = AidenFileTreeLayout.depth(entry.displayPath)
    val guideColor = palette.secondary.copy(alpha = 0.18f)
    val chevronRotation by animateFloatAsState(
        targetValue = AidenFileTreeLayout.chevronRotation(expanded),
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "tree_chevron"
    )
    val disclosureState = stringResource(if (expanded) R.string.state_expanded else R.string.state_collapsed)
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = aidenGroupItemShape(index, count),
        color = palette.raised,
        interactionSource = interaction,
        modifier = modifier
            .fillMaxWidth()
            .tactilePress(interaction, targetScale = 0.985f)
            .semantics { if (isDirectory) stateDescription = disclosureState }
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .height(IntrinsicSize.Min)
                .padding(start = 8.dp, end = 12.dp)
        ) {
            if (depth > 0) {
                Box(
                    modifier = Modifier
                        .width(AidenFileTreeLayout.indent(depth, AidenFileTreeStep.value).dp)
                        .fillMaxHeight()
                        .drawBehind {
                            val stroke = 1.dp.toPx()
                            AidenFileTreeLayout.guideCenters(depth, AidenFileTreeStep.toPx()).forEach { x ->
                                drawLine(guideColor, Offset(x, 0f), Offset(x, size.height), strokeWidth = stroke)
                            }
                        }
                )
            }
            Box(contentAlignment = Alignment.Center, modifier = Modifier.size(20.dp)) {
                if (isDirectory) {
                    Icon(
                        Icons.Default.ChevronRight,
                        contentDescription = null,
                        tint = palette.secondary,
                        modifier = Modifier
                            .size(18.dp)
                            .graphicsLayer { rotationZ = chevronRotation }
                    )
                }
            }
            Spacer(modifier = Modifier.width(4.dp))
            Icon(
                imageVector = when (entry.kind) {
                    AidenWorkspaceFileKind.DIRECTORY -> if (expanded) Icons.Default.FolderOpen else Icons.Default.Folder
                    AidenWorkspaceFileKind.SYMLINK -> Icons.Default.Link
                    AidenWorkspaceFileKind.FILE -> Icons.Default.Description
                },
                contentDescription = null,
                tint = when (entry.kind) {
                    AidenWorkspaceFileKind.DIRECTORY -> palette.accent
                    AidenWorkspaceFileKind.SYMLINK -> palette.warning
                    AidenWorkspaceFileKind.FILE -> palette.secondary
                },
                modifier = Modifier.size(20.dp)
            )
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = entry.name,
                style = MaterialTheme.typography.bodyMedium,
                color = palette.foreground,
                modifier = Modifier
                    .weight(1f)
                    .padding(vertical = 12.dp)
            )
            entry.language?.let { lang ->
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerHigh,
                    shape = MaterialTheme.shapes.small
                ) {
                    Text(
                        text = lang,
                        style = MaterialTheme.typography.labelSmall,
                        color = palette.secondary,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                    )
                }
            }
        }
    }
}
