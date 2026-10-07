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
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupOrientation
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonList
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.aidenGroupItemShape
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import androidx.lifecycle.compose.collectAsStateWithLifecycle

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
    val scope = rememberCoroutineScope()
    val client = coordinator.client.collectAsStateWithLifecycle().value
    val connectionState = coordinator.connectionState.collectAsStateWithLifecycle().value
    val cache = coordinator.workspaceCache
    val activeInstanceId = coordinator.activeInstanceId

    var expanded by remember { mutableStateOf(setOf<String>()) }
    var loadedFolders by remember { mutableStateOf(setOf<String>()) }
    var cursors by remember { mutableStateOf(mapOf<String, String>()) }
    var loadingFolders by remember { mutableStateOf(setOf<String>()) }
    var requestRevision by remember { mutableIntStateOf(0) }
    var openRevision by remember { mutableIntStateOf(0) }
    var isEditing by remember { mutableStateOf(false) }
    var fileIndex by remember { mutableStateOf<AidenWorkspaceFileIndex?>(null) }
    var selectedFile by remember { mutableStateOf<AidenWorkspaceFileDocument?>(null) }
    var draftContent by remember { mutableStateOf("") }
    var originalContent by remember { mutableStateOf("") }
    var isDirty by remember { mutableStateOf(false) }
    var isOfflineIndex by remember { mutableStateOf(false) }
    var isOfflineDocument by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(false) }
    var isSaving by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    // Dialog States
    var showDiscardConfirmDialog by remember { mutableStateOf(false) }
    // System back mirrors the toolbar: leave an open file first, confirming unsaved edits.
    BackHandler(enabled = selectedFile != null) {
        if (isDirty) showDiscardConfirmDialog = true else selectedFile = null
    }
    var showConflictDialog by remember { mutableStateOf(false) }
    fun availability() = AidenWorkspaceFileAvailability(
        isOfflineIndex, isOfflineDocument, connectionState == AidenConnectionState.CONNECTED
    )

    fun refreshFiles() {
        if (client != null) {
            if (isLoading) return
            // Show the saved tree at once while the desktop answers. It stays read-only
            // (its folder cursors may be stale) until the fresh index replaces it.
            if (fileIndex == null && activeInstanceId != null) {
                cache.load(activeInstanceId, workspaceId)?.let { snapshot ->
                    fileIndex = snapshot.index
                    isOfflineIndex = true
                }
            }
            requestRevision += 1
            val revision = requestRevision
            isLoading = true
            scope.launch {
                try {
                    val index = try { client.workspaceFilePage(workspaceId) }
                    catch (error: AidenRemoteClientException.Server) {
                        if (error.statusCode != 400 && error.statusCode != 404) throw error
                        client.workspaceFiles(workspaceId)
                    }
                    if (revision != requestRevision) return@launch
                    expanded = emptySet()
                    loadedFolders = setOf("")
                    loadingFolders = emptySet()
                    cursors = index.nextCursor?.let { mapOf("" to it) } ?: emptyMap()
                    fileIndex = index
                    isOfflineIndex = false
                    if (activeInstanceId != null) {
                        cache.store(index, activeInstanceId, workspaceId)
                    }
                } catch (error: Exception) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    if (revision != requestRevision) return@launch
                    errorMessage = error.localizedMessage
                    // Try cache
                    if (activeInstanceId != null) {
                        val snapshot = cache.load(activeInstanceId, workspaceId)
                        if (snapshot != null) {
                            fileIndex = snapshot.index
                            isOfflineIndex = true
                        }
                    }
                } finally {
                    if (revision == requestRevision) isLoading = false
                }
            }
        } else if (activeInstanceId != null) {
            val snapshot = cache.load(activeInstanceId, workspaceId)
            if (snapshot != null) {
                fileIndex = snapshot.index
                isOfflineIndex = true
            }
            isLoading = false
        }
    }

    fun loadPage(directory: AidenWorkspaceFileEntry?) {
        val directoryPath = directory?.displayPath ?: ""
        if (client == null || !availability().canLoadPage || isLoading || directoryPath in loadingFolders) return
        val revision = requestRevision
        loadingFolders = loadingFolders + directoryPath
        scope.launch {
            try {
                val page = client.workspaceFilePage(workspaceId, directory?.id, cursors[directoryPath])
                if (revision != requestRevision) return@launch
                val previous = fileIndex ?: return@launch
                val paths = previous.entries.map { it.displayPath }.toSet()
                val entries = previous.entries + page.entries.filter { it.displayPath !in paths }
                if (entries.size > 4_000) {
                    errorMessage = "The loaded tree reached 4,000 entries. Refresh Files to browse another folder."
                    return@launch
                }
                fileIndex = previous.copy(entries = entries, truncated = previous.truncated || page.truncated)
                cursors = cursors - directoryPath + (page.nextCursor?.let { mapOf(directoryPath to it) } ?: emptyMap())
                loadedFolders = loadedFolders + directoryPath
                if (activeInstanceId != null) fileIndex?.let { cache.store(it, activeInstanceId, workspaceId) }
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                if (revision == requestRevision) {
                    expanded = expanded - directoryPath
                    errorMessage = error.localizedMessage
                }
            } finally {
                if (revision == requestRevision) loadingFolders = loadingFolders - directoryPath
            }
        }
    }

    LaunchedEffect(client, workspaceId) {
        refreshFiles()
    }

    LaunchedEffect(initialReference, client) {
        if (initialReference != null) {
            openRevision += 1
            val revision = openRevision
            var online = false
            val document = try {
                client?.workspaceLinkedFile(workspaceId, initialReference)?.also {
                    if (revision == openRevision && activeInstanceId != null) cache.store(it, activeInstanceId, workspaceId)
                    online = true
                }
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                null
            } ?: activeInstanceId?.let { cache.document(initialReference, it, workspaceId) }
            if (revision != openRevision) return@LaunchedEffect
            if (document != null) {
                selectedFile = document
                originalContent = document.content
                draftContent = document.content
                isEditing = false
                isOfflineDocument = !online
            } else {
                errorMessage = "This workspace file could not be opened. Browse Files to locate it."
            }
        }
    }

    val filteredEntries = remember(fileIndex, searchQuery, expanded) {
        AidenWorkspaceFileTree.visible(fileIndex?.entries ?: emptyList(), expanded, searchQuery)
    }

    fun saveDocument(doc: AidenWorkspaceFileDocument) {
        if (client == null || isSaving || !availability().canEditDocument) return
        isSaving = true
        scope.launch {
            try {
                val updated = client.writeWorkspaceFile(
                    workspaceId = workspaceId,
                    fileId = doc.id,
                    displayPath = doc.displayPath,
                    content = draftContent,
                    expectedVersion = doc.version
                )
                selectedFile = updated
                // Lazy saves rotate the file handle; keep the tree bound to it.
                fileIndex?.let { current ->
                    val rebound = AidenWorkspaceFileTree.rebind(current, doc.id, updated.id)
                    if (rebound !== current) {
                        fileIndex = rebound
                        if (activeInstanceId != null) cache.store(rebound, activeInstanceId, workspaceId)
                    }
                }
                originalContent = updated.content
                draftContent = updated.content
                isDirty = false
                if (activeInstanceId != null) {
                    cache.store(updated, activeInstanceId, workspaceId)
                }
            } catch (e: AidenRemoteClientException.Server) {
                if (e.statusCode == 409) {
                    showConflictDialog = true
                } else {
                    errorMessage = e.message
                }
            } catch (e: Exception) {
                errorMessage = e.localizedMessage
            } finally {
                isSaving = false
            }
        }
    }

    fun openEntry(entry: AidenWorkspaceFileEntry) {
        if (entry.kind == AidenWorkspaceFileKind.DIRECTORY) {
            if (entry.displayPath in expanded) expanded = expanded - entry.displayPath
            else {
                expanded = expanded + entry.displayPath
                if (entry.displayPath !in loadedFolders && fileIndex?.directoryPath != null) loadPage(entry)
            }
        }
        if (entry.kind == AidenWorkspaceFileKind.FILE) {
            openRevision += 1
            val revision = openRevision
            scope.launch {
                if (client != null) {
                    try {
                        val fetchedDoc = client.workspaceFile(workspaceId, entry.id)
                        if (revision != openRevision) return@launch
                        isEditing = false
                        isOfflineDocument = false
                        selectedFile = fetchedDoc
                        originalContent = fetchedDoc.content
                        draftContent = fetchedDoc.content
                        isDirty = false
                        if (activeInstanceId != null) {
                            cache.store(fetchedDoc, activeInstanceId, workspaceId)
                        }
                    } catch (error: Exception) {
                        if (error is kotlinx.coroutines.CancellationException) throw error
                        if (revision != openRevision) return@launch
                        errorMessage = error.localizedMessage
                        // Try load from cache
                        if (activeInstanceId != null) {
                            val cachedDoc = cache.load(activeInstanceId, workspaceId)?.documents?.get(entry.id)
                            if (cachedDoc != null) {
                                isOfflineDocument = true
                                isEditing = false
                                selectedFile = cachedDoc
                                originalContent = cachedDoc.content
                                draftContent = cachedDoc.content
                                isDirty = false
                            }
                        }
                    }
                } else if (activeInstanceId != null) {
                    isEditing = false
                    val cachedDoc = cache.load(activeInstanceId, workspaceId)?.documents?.get(entry.id)
                    if (cachedDoc != null) {
                        isOfflineDocument = true
                        selectedFile = cachedDoc
                        originalContent = cachedDoc.content
                        draftContent = cachedDoc.content
                        isDirty = false
                    }
                }
            }
        }
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
                        Text("Workspace Files", fontWeight = FontWeight.Bold)
                    }
                },
                navigationIcon = {
                    IconButton(
                        onClick = {
                            if (selectedFile != null) {
                                if (isDirty) {
                                    showDiscardConfirmDialog = true
                                } else {
                                    selectedFile = null
                                }
                            } else {
                                onNavigateBack()
                            }
                        }
                    ) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = palette.foreground)
                    }
                },
                actions = {
                    val doc = selectedFile
                    if (doc != null) {
                        if (!isEditing) {
                            AidenTonalButton(
                                text = "Edit",
                                onClick = { isEditing = true },
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
                                onSave = { saveDocument(doc) },
                                modifier = Modifier.padding(end = 8.dp)
                            )
                        }
                    } else {
                        IconButton(onClick = { refreshFiles() }) {
                            Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = palette.foreground)
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
                            text = "Showing offline snapshot. Editing is disabled.",
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
                                text = "File list is truncated at ${idx.maxEntries} entries.",
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
                        onValueChange = {
                            draftContent = it
                            isDirty = (it != originalContent)
                        },
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
                    placeholder = { Text("Search loaded files…") },
                    leadingIcon = { Icon(Icons.Default.Search, contentDescription = "Search", tint = palette.secondary) },
                    trailingIcon = {
                        if (searchQuery.isNotEmpty()) {
                            IconButton(onClick = { searchQuery = "" }) {
                                Icon(Icons.Default.Clear, contentDescription = "Clear", tint = palette.secondary)
                            }
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .clip(RoundedCornerShape(12.dp)),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = palette.raised,
                        unfocusedContainerColor = palette.raised,
                        disabledContainerColor = palette.raised,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent
                    ),
                    singleLine = true
                )

                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
                ) {
                    if (fileIndex == null && isLoading) {
                        item(key = "files-skeleton") {
                            AidenSkeletonList(count = 8, supporting = false, loadingDescription = "Loading files")
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
                                    Text("No matching files found", style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                                }
                            }
                        }
                    }

                    cursors.forEach { (path, _) ->
                        if (path.isEmpty() || path in expanded) {
                            item(key = "page:$path") {
                                TextButton(onClick = { loadPage(fileIndex?.entries?.firstOrNull { it.displayPath == path }) },
                                    enabled = path !in loadingFolders && availability().canLoadPage && !isLoading) {
                                    Text(if (path.isEmpty()) "Load more files" else "Load more in $path")
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
                            onClick = { openEntry(entry) }
                        )
                    }
                }
            }
        }
    }

    // Discard Confirmation Dialog
    if (showDiscardConfirmDialog) {
        AidenWorkspaceAlertDialog(
            title = "Discard Changes?",
            onDismissRequest = { showDiscardConfirmDialog = false },
            confirmText = "Discard",
            dismissText = "Keep Editing",
            destructive = true,
            onConfirm = {
                showDiscardConfirmDialog = false
                draftContent = originalContent
                isDirty = false
                selectedFile = null
            }
        ) {
            Text("You have unsaved changes in this file. Are you sure you want to discard them?")
        }
    }

    // 409 Conflict Dialog
    if (showConflictDialog && selectedFile != null) {
        val doc = selectedFile!!
        AidenWorkspaceAlertDialog(
            title = "Conflict Detected",
            onDismissRequest = { showConflictDialog = false },
            confirmText = "Reload from desktop",
            onConfirm = {
                showConflictDialog = false
                scope.launch {
                    if (client != null) {
                        try {
                            val reloaded = client.workspaceFile(workspaceId, doc.id)
                            selectedFile = reloaded
                            originalContent = reloaded.content
                            draftContent = reloaded.content
                            isDirty = false
                        } catch (_: Exception) {}
                    }
                }
            }
        ) {
            Text("This file on your paired desktop was modified since you opened it. Would you like to reload the latest version from your desktop?")
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
                Text("Discard", style = MaterialTheme.typography.labelLarge, color = palette.foreground)
            }
        }
        Surface(
            onClick = onSave,
            enabled = saveEnabled,
            shape = aidenGroupItemShape(1, 2, outer, AidenShape.SplitInner, AidenGroupOrientation.HORIZONTAL),
            color = if (saveEnabled || saving) palette.accent else palette.accent.copy(alpha = 0.4f),
            contentColor = palette.onAccent,
            interactionSource = saveInteraction,
            modifier = Modifier
                .fillMaxHeight()
                .tactilePress(saveInteraction)
                .semantics { role = Role.Button }
        ) {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(horizontal = 16.dp)) {
                // Saving waits for the desktop's version check, so it holds a pending label.
                Text(
                    if (saving) "Saving…" else "Save",
                    style = MaterialTheme.typography.labelLarge,
                    color = palette.onAccent,
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
            .semantics { if (isDirectory) stateDescription = if (expanded) "Expanded" else "Collapsed" }
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
                    shape = RoundedCornerShape(6.dp)
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
