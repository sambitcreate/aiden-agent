package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenWorkspaceEnvironmentScreen(
    workspaceId: String,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client = coordinator.client.collectAsState().value
    val cache = coordinator.workspaceCache
    val activeInstanceId = coordinator.activeInstanceId

    var fileIndex by remember { mutableStateOf<AidenWorkspaceFileIndex?>(null) }
    var selectedFile by remember { mutableStateOf<AidenWorkspaceFileDocument?>(null) }
    var draftContent by remember { mutableStateOf("") }
    var originalContent by remember { mutableStateOf("") }
    var isDirty by remember { mutableStateOf(false) }
    var isOfflineSnapshot by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(true) }
    var isSaving by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    // Dialog States
    var showDiscardConfirmDialog by remember { mutableStateOf(false) }
    var showConflictDialog by remember { mutableStateOf(false) }

    fun refreshFiles() {
        if (client != null) {
            isLoading = true
            scope.launch {
                try {
                    val index = client.workspaceFiles(workspaceId)
                    fileIndex = index
                    isOfflineSnapshot = false
                    if (activeInstanceId != null) {
                        cache.store(index, activeInstanceId, workspaceId)
                    }
                } catch (_: Exception) {
                    // Try cache
                    if (activeInstanceId != null) {
                        val snapshot = cache.load(activeInstanceId, workspaceId)
                        if (snapshot != null) {
                            fileIndex = snapshot.index
                            isOfflineSnapshot = true
                        }
                    }
                } finally {
                    isLoading = false
                }
            }
        } else if (activeInstanceId != null) {
            val snapshot = cache.load(activeInstanceId, workspaceId)
            if (snapshot != null) {
                fileIndex = snapshot.index
                isOfflineSnapshot = true
            }
            isLoading = false
        }
    }

    LaunchedEffect(client, workspaceId) {
        refreshFiles()
    }

    val filteredEntries = remember(fileIndex, searchQuery) {
        fileIndex?.entries?.filter {
            searchQuery.isEmpty() || it.displayPath.contains(searchQuery, ignoreCase = true)
        } ?: emptyList()
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
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back", tint = palette.foreground)
                    }
                },
                actions = {
                    val doc = selectedFile
                    if (doc != null) {
                        if (isDirty) {
                            TextButton(
                                onClick = { showDiscardConfirmDialog = true },
                                colors = ButtonDefaults.textButtonColors(contentColor = palette.secondary)
                            ) {
                                Text("Discard")
                            }
                            Button(
                                onClick = {
                                    if (client != null && !isSaving && !isOfflineSnapshot) {
                                        isSaving = true
                                        scope.launch {
                                            try {
                                                val updated = client.writeWorkspaceFile(
                                                    workspaceId = workspaceId,
                                                    fileId = doc.id,
                                                    content = draftContent,
                                                    expectedVersion = doc.version
                                                )
                                                selectedFile = updated
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
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                                shape = RoundedCornerShape(8.dp),
                                enabled = !isSaving && !isOfflineSnapshot
                            ) {
                                if (isSaving) {
                                    CircularProgressIndicator(color = Color.White, modifier = Modifier.size(16.dp))
                                } else {
                                    Text("Save", color = Color.White, fontWeight = FontWeight.Bold)
                                }
                            }
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
            // Offline or Truncated Banner
            if (isOfflineSnapshot) {
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
                        readOnly = isOfflineSnapshot,
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                    )
                }
            } else {
                // File Index List
                TextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    placeholder = { Text("Filter files...") },
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
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
                ) {
                    if (filteredEntries.isEmpty() && !isLoading) {
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

                    items(filteredEntries) { entry ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 2.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .clickable {
                                    if (entry.kind == AidenWorkspaceFileKind.FILE) {
                                        scope.launch {
                                            if (client != null) {
                                                try {
                                                    val fetchedDoc = client.workspaceFile(workspaceId, entry.id)
                                                    selectedFile = fetchedDoc
                                                    originalContent = fetchedDoc.content
                                                    draftContent = fetchedDoc.content
                                                    isDirty = false
                                                    if (activeInstanceId != null) {
                                                        cache.store(fetchedDoc, activeInstanceId, workspaceId)
                                                    }
                                                } catch (_: Exception) {
                                                    // Try load from cache
                                                    if (activeInstanceId != null) {
                                                        val cachedDoc = cache.load(activeInstanceId, workspaceId)?.documents?.get(entry.id)
                                                        if (cachedDoc != null) {
                                                            selectedFile = cachedDoc
                                                            originalContent = cachedDoc.content
                                                            draftContent = cachedDoc.content
                                                            isDirty = false
                                                        }
                                                    }
                                                }
                                            } else if (activeInstanceId != null) {
                                                val cachedDoc = cache.load(activeInstanceId, workspaceId)?.documents?.get(entry.id)
                                                if (cachedDoc != null) {
                                                    selectedFile = cachedDoc
                                                    originalContent = cachedDoc.content
                                                    draftContent = cachedDoc.content
                                                    isDirty = false
                                                }
                                            }
                                        }
                                    }
                                },
                            colors = CardDefaults.cardColors(containerColor = palette.raised),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)
                            ) {
                                Icon(
                                    imageVector = when (entry.kind) {
                                        AidenWorkspaceFileKind.DIRECTORY -> Icons.Default.Folder
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
                                    text = entry.displayPath,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = palette.foreground,
                                    modifier = Modifier.weight(1f)
                                )
                                entry.language?.let { lang ->
                                    Surface(
                                        color = palette.canvas,
                                        shape = RoundedCornerShape(4.dp)
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
                }
            }
        }
    }

    // Discard Confirmation Dialog
    if (showDiscardConfirmDialog) {
        AlertDialog(
            onDismissRequest = { showDiscardConfirmDialog = false },
            title = { Text("Discard Changes?", fontWeight = FontWeight.Bold) },
            text = { Text("You have unsaved changes in this file. Are you sure you want to discard them?") },
            confirmButton = {
                Button(
                    onClick = {
                        showDiscardConfirmDialog = false
                        draftContent = originalContent
                        isDirty = false
                        selectedFile = null
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.danger)
                ) {
                    Text("Discard", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDiscardConfirmDialog = false }) {
                    Text("Keep Editing", color = palette.foreground)
                }
            }
        )
    }

    // 409 Conflict Dialog
    if (showConflictDialog && selectedFile != null) {
        val doc = selectedFile!!
        AlertDialog(
            onDismissRequest = { showConflictDialog = false },
            title = { Text("Conflict Detected", fontWeight = FontWeight.Bold) },
            text = {
                Text("This file on your Mac was modified since you opened it. Would you like to reload the latest version from your Mac?")
            },
            confirmButton = {
                Button(
                    onClick = {
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
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                ) {
                    Text("Reload from Mac", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showConflictDialog = false }) {
                    Text("Cancel", color = palette.foreground)
                }
            }
        )
    }
}
