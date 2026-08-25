package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenWorkspaceDirectoryScreen(
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onNavigateToChat: (String) -> Unit,
    onNavigateToFiles: (String) -> Unit,
    onNavigateToGit: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client = coordinator.client.collectAsState().value
    val allWorkspaces by coordinator.workspaces.collectAsState()
    val archiveStore = coordinator.archiveStore
    val archivedIDs by archiveStore.workspaceIDsByInstance.collectAsState()
    val activeInstanceId = coordinator.activeInstanceId

    var searchQuery by remember { mutableStateOf("") }
    var selectedTab by remember { mutableStateOf(0) } // 0: Active, 1: Archived
    var selectedWorkspace by remember { mutableStateOf<AidenWorkspace?>(null) }
    var workspaceChats by remember { mutableStateOf<List<AidenChat>>(emptyList()) }
    var isLoadingChats by remember { mutableStateOf(false) }

    // Dialog & Sheet States
    var showCreateMenu by remember { mutableStateOf(false) }
    var showNewWorkspaceDialog by remember { mutableStateOf(false) }
    var newWorkspaceName by remember { mutableStateOf("") }
    var showScratchConfirmDialog by remember { mutableStateOf(false) }
    var showFolderBrowserSheet by remember { mutableStateOf(false) }
    var showSettingsSheet by remember { mutableStateOf(false) }
    var workspaceToEditSettings by remember { mutableStateOf<AidenWorkspace?>(null) }
    var showRenameDialog by remember { mutableStateOf(false) }
    var workspaceToRename by remember { mutableStateOf<AidenWorkspace?>(null) }
    var renameInput by remember { mutableStateOf("") }
    var showArchiveDisclosureDialog by remember { mutableStateOf(false) }
    var workspaceToArchive by remember { mutableStateOf<AidenWorkspace?>(null) }
    var showRemoveDialog by remember { mutableStateOf(false) }
    var workspaceToRemove by remember { mutableStateOf<AidenWorkspace?>(null) }
    var showDeleteWorktreeDialog by remember { mutableStateOf(false) }
    var worktreeToDelete by remember { mutableStateOf<AidenWorkspace?>(null) }
    var showNewAgentChoices by remember { mutableStateOf(false) }

    val instanceArchivedSet = activeInstanceId?.let { archivedIDs[it] } ?: emptySet()

    val activeWorkspaces = remember(allWorkspaces, instanceArchivedSet, searchQuery) {
        allWorkspaces
            .filter { !instanceArchivedSet.contains(it.id) }
            .filter { searchQuery.isEmpty() || it.name.contains(searchQuery, ignoreCase = true) }
    }

    val archivedWorkspaces = remember(allWorkspaces, instanceArchivedSet, searchQuery) {
        allWorkspaces
            .filter { instanceArchivedSet.contains(it.id) }
            .filter { searchQuery.isEmpty() || it.name.contains(searchQuery, ignoreCase = true) }
    }

    LaunchedEffect(selectedWorkspace, client) {
        val ws = selectedWorkspace
        if (ws != null && client != null) {
            isLoadingChats = true
            try {
                workspaceChats = AidenChat.regularWorkspaceChats(client.chats(ws.id))
            } catch (_: Exception) {} finally {
                isLoadingChats = false
            }
        }
    }

    Scaffold(
        modifier = modifier,
        floatingActionButton = {
            if (selectedWorkspace != null) {
                FloatingActionButton(
                    onClick = {
                        val currentWs = selectedWorkspace ?: return@FloatingActionButton
                        scope.launch {
                            if (client != null) {
                                try {
                                    val chat = client.createChat(currentWs.id)
                                    onNavigateToChat(chat.id)
                                } catch (_: Exception) {}
                            }
                        }
                    },
                    containerColor = palette.accent,
                    contentColor = Color.White,
                    shape = CircleShape
                ) {
                    Icon(Icons.Default.Add, contentDescription = "New Chat")
                }
            }
        },
        containerColor = palette.canvas,
        contentWindowInsets = WindowInsets(0, 0, 0, 0)
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            // If a workspace is currently selected, show Workspace Detail view
            val activeWs = selectedWorkspace
            if (activeWs != null) {
                // Detail Header
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
                ) {
                    IconButton(onClick = { selectedWorkspace = null }) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back to Workspaces", tint = palette.foreground)
                    }
                    Spacer(modifier = Modifier.width(4.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = activeWs.name,
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = palette.foreground,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = "Permission: ${activeWs.permission.title}",
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.secondary
                            )
                            if (activeWs.branchName != null) {
                                Text(" • ", color = palette.secondary)
                                Text(
                                    text = activeWs.branchName,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = palette.accent
                                )
                            }
                        }
                    }
                    IconButton(
                        onClick = {
                            workspaceToEditSettings = activeWs
                            showSettingsSheet = true
                        }
                    ) {
                        Icon(Icons.Default.Settings, contentDescription = "Workspace Settings", tint = palette.foreground)
                    }
                }

                // Quick action buttons: Files & Git Review
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Button(
                        onClick = { onNavigateToFiles(activeWs.id) },
                        colors = ButtonDefaults.buttonColors(containerColor = palette.raised),
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Default.FolderOpen, contentDescription = null, tint = palette.foreground, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Files", color = palette.foreground, fontWeight = FontWeight.SemiBold)
                    }

                    Button(
                        onClick = { onNavigateToGit(activeWs.id) },
                        colors = ButtonDefaults.buttonColors(containerColor = palette.raised),
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Default.Commit, contentDescription = null, tint = palette.foreground, modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Git Review", color = palette.foreground, fontWeight = FontWeight.SemiBold)
                        activeWs.git?.uncommitted?.let { uncommitted ->
                            if (uncommitted > 0) {
                                Spacer(modifier = Modifier.width(6.dp))
                                Surface(
                                    color = palette.accent,
                                    shape = CircleShape,
                                    modifier = Modifier.size(18.dp)
                                ) {
                                    Box(contentAlignment = Alignment.Center) {
                                        Text(
                                            text = if (uncommitted > 99) "99+" else uncommitted.toString(),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = Color.White,
                                            fontSize = 9.sp
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                Divider(color = palette.raised, modifier = Modifier.padding(vertical = 4.dp))

                // Chats List for Workspace
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)
                ) {
                    if (workspaceChats.isEmpty() && !isLoadingChats) {
                        item {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(40.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Icon(
                                        imageVector = Icons.Default.ChatBubbleOutline,
                                        contentDescription = null,
                                        tint = palette.secondary,
                                        modifier = Modifier.size(48.dp)
                                    )
                                    Spacer(modifier = Modifier.height(12.dp))
                                    Text(
                                        text = "No chats in this workspace yet",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = palette.secondary
                                    )
                                    Spacer(modifier = Modifier.height(12.dp))
                                    Button(
                                        onClick = {
                                            scope.launch {
                                                if (client != null) {
                                                    try {
                                                        val chat = client.createChat(activeWs.id)
                                                        onNavigateToChat(chat.id)
                                                    } catch (_: Exception) {}
                                                }
                                            }
                                        },
                                        colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                                        shape = RoundedCornerShape(8.dp)
                                    ) {
                                        Text("Start a Chat", color = Color.White)
                                    }
                                }
                            }
                        }
                    }

                    items(workspaceChats) { chat ->
                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(14.dp))
                                .clickable { onNavigateToChat(chat.id) },
                            color = Color.Transparent,
                            shape = RoundedCornerShape(14.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(horizontal = 4.dp, vertical = AidenUi.RowVerticalPadding)
                            ) {
                                Icon(Icons.Default.Chat, contentDescription = null, tint = palette.accent)
                                Spacer(modifier = Modifier.width(12.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = chat.title.ifEmpty { "New Chat" },
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.SemiBold,
                                        color = palette.foreground,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                    Spacer(modifier = Modifier.height(2.dp))
                                    Text(
                                        text = "${chat.messages.size} messages",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = palette.secondary
                                    )
                                }
                                Icon(Icons.Default.ChevronRight, contentDescription = null, tint = palette.secondary)
                            }
                        }
                    }
                }
            } else {
                // Workspace Directory View
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 2.dp)
                ) {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back to Workspace home", tint = palette.foreground)
                    }
                    Text(
                        text = "Workspaces",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.foreground,
                        modifier = Modifier.weight(1f)
                    )
                }
                // 1:1 Parity iOS Glass Search & Action Dock
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
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
                                contentDescription = "Search",
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
                                        text = "Search workspaces...",
                                        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp),
                                        color = palette.secondary.copy(alpha = 0.7f)
                                    )
                                }
                                BasicTextField(
                                    value = searchQuery,
                                    onValueChange = { searchQuery = it },
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
                                    onClick = { searchQuery = "" },
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

                    // 54dp Floating Action Button with Dropdown
                    Box {
                        Surface(
                            shape = CircleShape,
                            color = palette.accent,
                            shadowElevation = 3.dp,
                            modifier = Modifier
                                .size(54.dp)
                        ) {
                            IconButton(
                                onClick = { showCreateMenu = true },
                                modifier = Modifier.fillMaxSize()
                            ) {
                                Icon(Icons.Default.Add, contentDescription = "Add Workspace", tint = Color.White, modifier = Modifier.size(22.dp))
                            }
                        }
                        DropdownMenu(
                            expanded = showCreateMenu,
                            onDismissRequest = { showCreateMenu = false }
                        ) {
                            DropdownMenuItem(
                                text = { Text("New Workspace") },
                                leadingIcon = { Icon(Icons.Default.CreateNewFolder, contentDescription = null) },
                                onClick = {
                                    showCreateMenu = false
                                    newWorkspaceName = ""
                                    showNewWorkspaceDialog = true
                                }
                            )
                            DropdownMenuItem(
                                text = { Text("New Managed Scratch") },
                                leadingIcon = { Icon(Icons.Default.FolderSpecial, contentDescription = null) },
                                onClick = {
                                    showCreateMenu = false
                                    showScratchConfirmDialog = true
                                }
                            )
                            DropdownMenuItem(
                                text = { Text("Add Mac Folder...") },
                                leadingIcon = { Icon(Icons.Default.Folder, contentDescription = null) },
                                onClick = {
                                    showCreateMenu = false
                                    showFolderBrowserSheet = true
                                }
                            )
                        }
                    }
                }

                // Filter Segmented Pill (Active vs Archived)
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                    shape = RoundedCornerShape(20.dp),
                    modifier = Modifier
                        .padding(horizontal = AidenUi.ScreenGutter, vertical = 4.dp)
                        .fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(4.dp)
                    ) {
                        // Active Tab
                        Surface(
                            onClick = { selectedTab = 0 },
                            color = if (selectedTab == 0) MaterialTheme.colorScheme.primaryContainer else Color.Transparent,
                            shape = RoundedCornerShape(16.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Box(
                                contentAlignment = Alignment.Center,
                                modifier = Modifier.padding(vertical = 8.dp)
                            ) {
                                Text(
                                    text = "Active (${activeWorkspaces.size})",
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = FontWeight.Bold,
                                    color = if (selectedTab == 0) palette.accent else palette.secondary
                                )
                            }
                        }

                        // Archived Tab
                        Surface(
                            onClick = { selectedTab = 1 },
                            color = if (selectedTab == 1) MaterialTheme.colorScheme.primaryContainer else Color.Transparent,
                            shape = RoundedCornerShape(16.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Box(
                                contentAlignment = Alignment.Center,
                                modifier = Modifier.padding(vertical = 8.dp)
                            ) {
                                Text(
                                    text = "Archived (${archivedWorkspaces.size})",
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = FontWeight.Bold,
                                    color = if (selectedTab == 1) palette.accent else palette.secondary
                                )
                            }
                        }
                    }
                }

                val currentList = if (selectedTab == 0) activeWorkspaces else archivedWorkspaces

                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp)
                ) {
                    if (currentList.isEmpty()) {
                        item {
                            AidenEmptyState(
                                icon = if (selectedTab == 0) Icons.Default.FolderOpen else Icons.Default.Archive,
                                title = if (selectedTab == 0) "No active workspaces" else "No archived workspaces",
                                body = if (selectedTab == 0)
                                    "Create a workspace or add an approved folder from your Mac."
                                else
                                    "Workspaces archived on this device will appear here."
                            )
                        }
                    }

                    items(currentList) { ws ->
                        var showRowMenu by remember { mutableStateOf(false) }

                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(14.dp))
                                .clickable { selectedWorkspace = ws },
                            color = Color.Transparent,
                            shape = RoundedCornerShape(14.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(horizontal = 4.dp, vertical = AidenUi.RowVerticalPadding)
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(40.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .background(
                                            if (ws.isManagedWorktree) palette.accent.copy(alpha = 0.15f)
                                            else palette.secondary.copy(alpha = 0.12f)
                                        ),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Icon(
                                        imageVector = if (ws.isManagedWorktree) Icons.Default.AccountTree
                                        else if (ws.git?.isRepo == true) Icons.Default.Commit
                                        else Icons.Default.Folder,
                                        contentDescription = null,
                                        tint = if (ws.isManagedWorktree) palette.accent else palette.foreground
                                    )
                                }

                                Spacer(modifier = Modifier.width(12.dp))

                                Column(modifier = Modifier.weight(1f)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(
                                            text = ws.name,
                                            style = MaterialTheme.typography.titleMedium,
                                            fontWeight = FontWeight.Bold,
                                            color = palette.foreground,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis
                                        )
                                        if (ws.isManagedWorktree) {
                                            Spacer(modifier = Modifier.width(6.dp))
                                            Surface(
                                                color = palette.accent.copy(alpha = 0.15f),
                                                shape = RoundedCornerShape(4.dp)
                                            ) {
                                                Text(
                                                    text = "Worktree",
                                                    style = MaterialTheme.typography.labelSmall,
                                                    color = palette.accent,
                                                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp)
                                                )
                                            }
                                        }
                                    }

                                    Spacer(modifier = Modifier.height(2.dp))

                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(
                                            text = ws.permission.title,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = palette.secondary
                                        )
                                        if (ws.branchName != null) {
                                            Text(" • ", color = palette.secondary)
                                            Text(
                                                text = ws.branchName,
                                                style = MaterialTheme.typography.bodySmall,
                                                color = palette.accent,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis
                                            )
                                        }
                                        ws.git?.uncommitted?.let { uncommitted ->
                                            if (uncommitted > 0) {
                                                Text(" • ", color = palette.secondary)
                                                Text(
                                                    text = "+$uncommitted uncommitted",
                                                    style = MaterialTheme.typography.bodySmall,
                                                    color = palette.warning
                                                )
                                            }
                                        }
                                    }
                                }

                                Box {
                                    IconButton(onClick = { showRowMenu = true }) {
                                        Icon(Icons.Default.MoreVert, contentDescription = "More actions", tint = palette.secondary)
                                    }
                                    DropdownMenu(
                                        expanded = showRowMenu,
                                        onDismissRequest = { showRowMenu = false }
                                    ) {
                                        DropdownMenuItem(
                                            text = { Text("Rename") },
                                            leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                                            onClick = {
                                                showRowMenu = false
                                                workspaceToRename = ws
                                                renameInput = ws.name
                                                showRenameDialog = true
                                            }
                                        )
                                        if (selectedTab == 0) {
                                            DropdownMenuItem(
                                                text = { Text("Archive on this device") },
                                                leadingIcon = { Icon(Icons.Default.Archive, contentDescription = null) },
                                                onClick = {
                                                    showRowMenu = false
                                                    workspaceToArchive = ws
                                                    if (!archiveStore.hasAcknowledgedDeviceOnlyArchive.value) {
                                                        showArchiveDisclosureDialog = true
                                                    } else {
                                                        archiveStore.archive(ws.id, activeInstanceId)
                                                    }
                                                }
                                            )
                                        } else {
                                            DropdownMenuItem(
                                                text = { Text("Unarchive") },
                                                leadingIcon = { Icon(Icons.Default.Unarchive, contentDescription = null) },
                                                onClick = {
                                                    showRowMenu = false
                                                    archiveStore.unarchive(ws.id, activeInstanceId)
                                                }
                                            )
                                        }
                                        DropdownMenuItem(
                                            text = { Text("Workspace Settings") },
                                            leadingIcon = { Icon(Icons.Default.Settings, contentDescription = null) },
                                            onClick = {
                                                showRowMenu = false
                                                workspaceToEditSettings = ws
                                                showSettingsSheet = true
                                            }
                                        )
                                        Divider()
                                        if (ws.isManagedWorktree) {
                                            DropdownMenuItem(
                                                text = { Text("Delete Managed Worktree", color = palette.danger) },
                                                leadingIcon = { Icon(Icons.Default.DeleteForever, contentDescription = null, tint = palette.danger) },
                                                onClick = {
                                                    showRowMenu = false
                                                    worktreeToDelete = ws
                                                    showDeleteWorktreeDialog = true
                                                }
                                            )
                                        }
                                        DropdownMenuItem(
                                            text = { Text("Remove from Aiden", color = palette.danger) },
                                            leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, tint = palette.danger) },
                                            onClick = {
                                                showRowMenu = false
                                                workspaceToRemove = ws
                                                showRemoveDialog = true
                                            }
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

    // --- Dialogs ---

    // New Workspace Dialog
    if (showNewWorkspaceDialog) {
        AlertDialog(
            onDismissRequest = { showNewWorkspaceDialog = false },
            title = { Text("New Workspace", fontWeight = FontWeight.Bold) },
            text = {
                Column {
                    Text("Enter a name for the new folderless workspace:")
                    Spacer(modifier = Modifier.height(8.dp))
                    TextField(
                        colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                        value = newWorkspaceName,
                        onValueChange = { newWorkspaceName = it },
                        placeholder = { Text("Workspace name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val name = newWorkspaceName.trim()
                        if (name.isNotEmpty()) {
                            showNewWorkspaceDialog = false
                            scope.launch {
                                try {
                                    coordinator.createWorkspace(AidenWorkspaceCreate.Folderless(name = name))
                                } catch (_: Exception) {}
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                ) {
                    Text("Create", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showNewWorkspaceDialog = false }) {
                    Text("Cancel", color = palette.foreground)
                }
            }
        )
    }

    // New Scratch Workspace Confirm Dialog
    if (showScratchConfirmDialog) {
        AlertDialog(
            onDismissRequest = { showScratchConfirmDialog = false },
            title = { Text("Create Managed Scratch?", fontWeight = FontWeight.Bold) },
            text = {
                Text("Aiden will create an isolated scratch workspace in an ephemeral location on your Mac.")
            },
            confirmButton = {
                Button(
                    onClick = {
                        showScratchConfirmDialog = false
                        scope.launch {
                            try {
                                coordinator.createWorkspace(AidenWorkspaceCreate.Scratch())
                            } catch (_: Exception) {}
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                ) {
                    Text("Create Scratch", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showScratchConfirmDialog = false }) {
                    Text("Cancel", color = palette.foreground)
                }
            }
        )
    }

    // Rename Dialog
    if (showRenameDialog && workspaceToRename != null) {
        val target = workspaceToRename!!
        AlertDialog(
            onDismissRequest = { showRenameDialog = false },
            title = { Text("Rename Workspace", fontWeight = FontWeight.Bold) },
            text = {
                Column {
                    TextField(
                        colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                        value = renameInput,
                        onValueChange = { renameInput = it },
                        label = { Text("Workspace Name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val newName = renameInput.trim()
                        if (newName.isNotEmpty()) {
                            showRenameDialog = false
                            scope.launch {
                                try {
                                    coordinator.updateWorkspace(target, name = newName)
                                } catch (_: Exception) {}
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                ) {
                    Text("Save", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showRenameDialog = false }) {
                    Text("Cancel", color = palette.foreground)
                }
            }
        )
    }

    // Archive on Device Disclosure Dialog
    if (showArchiveDisclosureDialog && workspaceToArchive != null) {
        val target = workspaceToArchive!!
        AlertDialog(
            onDismissRequest = { showArchiveDisclosureDialog = false },
            title = { Text("Archive on this Device", fontWeight = FontWeight.Bold) },
            text = {
                Text("Archiving a workspace hides it only on this device. Your Mac, files, and other devices remain completely unaffected.")
            },
            confirmButton = {
                Button(
                    onClick = {
                        archiveStore.acknowledgeDeviceOnlyArchive()
                        archiveStore.archive(target.id, activeInstanceId)
                        showArchiveDisclosureDialog = false
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                ) {
                    Text("Got it, Archive", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showArchiveDisclosureDialog = false }) {
                    Text("Cancel", color = palette.foreground)
                }
            }
        )
    }

    // Remove Workspace Confirm Dialog
    if (showRemoveDialog && workspaceToRemove != null) {
        val target = workspaceToRemove!!
        AlertDialog(
            onDismissRequest = { showRemoveDialog = false },
            title = { Text("Remove Workspace?", fontWeight = FontWeight.Bold) },
            text = {
                Text("Are you sure you want to remove \"${target.name}\" from Aiden? Local files on your Mac are preserved.")
            },
            confirmButton = {
                Button(
                    onClick = {
                        showRemoveDialog = false
                        scope.launch {
                            try {
                                coordinator.removeWorkspace(target)
                            } catch (_: Exception) {}
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.danger)
                ) {
                    Text("Remove", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showRemoveDialog = false }) {
                    Text("Cancel", color = palette.foreground)
                }
            }
        )
    }

    // Delete Managed Worktree Confirm Dialog
    if (showDeleteWorktreeDialog && worktreeToDelete != null) {
        val target = worktreeToDelete!!
        AlertDialog(
            onDismissRequest = { showDeleteWorktreeDialog = false },
            title = { Text("Delete Managed Worktree?", fontWeight = FontWeight.Bold) },
            text = {
                Text("This will permanently remove the managed worktree folder and git worktree on your Mac.")
            },
            confirmButton = {
                Button(
                    onClick = {
                        showDeleteWorktreeDialog = false
                        scope.launch {
                            try {
                                coordinator.removeManagedWorktree(target)
                            } catch (_: Exception) {}
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.danger)
                ) {
                    Text("Delete Worktree", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteWorktreeDialog = false }) {
                    Text("Cancel", color = palette.foreground)
                }
            }
        )
    }

    // Folder Browser Sheet
    if (showFolderBrowserSheet) {
        ModalBottomSheet(
            onDismissRequest = { showFolderBrowserSheet = false },
            containerColor = palette.canvas,
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            AidenFolderBrowserSheet(
                coordinator = coordinator,
                onDismiss = { showFolderBrowserSheet = false },
                onFolderAdded = {
                    showFolderBrowserSheet = false
                    coordinator.refreshWorkspaces()
                }
            )
        }
    }

    // Settings Sheet
    if (showSettingsSheet && workspaceToEditSettings != null) {
        ModalBottomSheet(
            onDismissRequest = { showSettingsSheet = false },
            containerColor = palette.canvas
        ) {
            AidenWorkspaceSettingsSheet(
                workspace = workspaceToEditSettings!!,
                coordinator = coordinator,
                onDismiss = { showSettingsSheet = false },
                onDeleted = {
                    showSettingsSheet = false
                    if (selectedWorkspace?.id == workspaceToEditSettings?.id) {
                        selectedWorkspace = null
                    }
                }
            )
        }
    }
}

@Composable
fun AidenFolderBrowserSheet(
    coordinator: AidenRemoteCoordinator,
    onDismiss: () -> Unit,
    onFolderAdded: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client = coordinator.client.collectAsState().value

    var roots by remember { mutableStateOf<List<AidenBrowserRoot>>(emptyList()) }
    var currentPage by remember { mutableStateOf<AidenBrowserPage?>(null) }
    var currentLocation by remember { mutableStateOf<String?>(null) }
    var currentCursor by remember { mutableStateOf<String?>(null) }
    var isLoading by remember { mutableStateOf(false) }
    var isAdding by remember { mutableStateOf(false) }

    LaunchedEffect(client) {
        if (client != null) {
            isLoading = true
            try {
                roots = client.browserRoots()
            } catch (_: Exception) {} finally {
                isLoading = false
            }
        }
    }

    fun loadLocation(location: String, cursor: String? = null, append: Boolean = false) {
        if (client == null) return
        scope.launch {
            isLoading = true
            try {
                val page = client.browserChildren(location, cursor)
                currentLocation = location
                currentCursor = page.nextCursor
                if (append && currentPage != null) {
                    val combined = currentPage!!.copy(
                        entries = currentPage!!.entries + page.entries,
                        nextCursor = page.nextCursor
                    )
                    currentPage = combined
                } else {
                    currentPage = page
                }
            } catch (_: Exception) {} finally {
                isLoading = false
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                text = "Browse Mac Folders",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                color = palette.foreground,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = onDismiss) {
                Icon(Icons.Default.Close, contentDescription = "Close", tint = palette.foreground)
            }
        }

        // Breadcrumbs
        val page = currentPage
        if (page != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp)
            ) {
                Text(
                    text = "Roots",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.accent,
                    modifier = Modifier.clickable {
                        currentPage = null
                        currentLocation = null
                    }
                )
                page.breadcrumbs.forEach { bc ->
                    Text(" / ", color = palette.secondary, style = MaterialTheme.typography.bodySmall)
                    Text(
                        text = bc.label,
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.accent,
                        modifier = Modifier.clickable {
                            loadLocation(bc.location)
                        }
                    )
                }
            }
        }

        Divider(color = palette.raised, modifier = Modifier.padding(vertical = 4.dp))

        // Content
        if (page == null) {
            // Show Roots
            LazyColumn(
                modifier = Modifier
                    .weight(1f, fill = false)
                    .fillMaxWidth()
            ) {
                items(roots) { root ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { loadLocation(root.location) },
                        colors = CardDefaults.cardColors(containerColor = palette.raised),
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(12.dp)
                        ) {
                            Icon(Icons.Default.Folder, contentDescription = null, tint = palette.accent)
                            Spacer(modifier = Modifier.width(12.dp))
                            Text(
                                text = root.label,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = palette.foreground,
                                modifier = Modifier.weight(1f)
                            )
                            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = palette.secondary)
                        }
                    }
                }
            }
        } else {
            // Show Page Entries
            LazyColumn(
                modifier = Modifier
                    .weight(1f, fill = false)
                    .fillMaxWidth()
            ) {
                items(page.entries) { entry ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 3.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { loadLocation(entry.location) },
                        colors = CardDefaults.cardColors(containerColor = palette.raised),
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(10.dp)
                        ) {
                            Icon(Icons.Default.FolderOpen, contentDescription = null, tint = palette.accent)
                            Spacer(modifier = Modifier.width(10.dp))
                            Text(
                                text = entry.name,
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.foreground,
                                modifier = Modifier.weight(1f)
                            )
                            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = palette.secondary)
                        }
                    }
                }

                if (page.nextCursor != null) {
                    item {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(8.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            TextButton(
                                onClick = {
                                    val loc = currentLocation
                                    if (loc != null && page.nextCursor != null) {
                                        loadLocation(loc, page.nextCursor, append = true)
                                    }
                                }
                            ) {
                                Text("Load More", color = palette.accent)
                            }
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Add This Folder Button
            val loc = currentLocation
            if (loc != null) {
                Button(
                    onClick = {
                        if (client != null && !isAdding) {
                            isAdding = true
                            scope.launch {
                                try {
                                    val sel = client.createWorkspaceSelection(loc)
                                    coordinator.createWorkspace(
                                        AidenWorkspaceCreate.SelectedFolder(
                                            selection = sel.selection,
                                            name = if (sel.displayName.isNotEmpty()) sel.displayName else null
                                        )
                                    )
                                    onFolderAdded()
                                } catch (_: Exception) {} finally {
                                    isAdding = false
                                }
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isAdding
                ) {
                    if (isAdding) {
                        CircularProgressIndicator(color = Color.White, modifier = Modifier.size(18.dp))
                    } else {
                        Text("Add This Folder as Workspace", color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
fun AidenWorkspaceSettingsSheet(
    workspace: AidenWorkspace,
    coordinator: AidenRemoteCoordinator,
    onDismiss: () -> Unit,
    onDeleted: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    var nameInput by remember { mutableStateOf(workspace.name) }
    var selectedPermission by remember { mutableStateOf(workspace.permission) }
    var isSaving by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(20.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                text = "Workspace Settings",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                color = palette.foreground,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = onDismiss) {
                Icon(Icons.Default.Close, contentDescription = "Close", tint = palette.foreground)
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Name
        TextField(
            colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
            value = nameInput,
            onValueChange = { nameInput = it },
            label = { Text("Workspace Name") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Permission Switcher
        Text(
            text = "Permission Level",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            color = palette.foreground
        )
        Spacer(modifier = Modifier.height(8.dp))

        AidenWorkspacePermission.values().forEach { perm ->
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .clickable { selectedPermission = perm },
                colors = CardDefaults.cardColors(
                    containerColor = if (selectedPermission == perm) palette.accent.copy(alpha = 0.15f) else palette.raised
                ),
                shape = RoundedCornerShape(10.dp)
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(12.dp)
                ) {
                    RadioButton(
                        selected = selectedPermission == perm,
                        onClick = { selectedPermission = perm },
                        colors = RadioButtonDefaults.colors(selectedColor = palette.accent)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = perm.title,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold,
                            color = palette.foreground
                        )
                        Text(
                            text = perm.detail,
                            style = MaterialTheme.typography.bodySmall,
                            color = palette.secondary
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Save Button
        Button(
            onClick = {
                val newName = nameInput.trim()
                if (newName.isNotEmpty() && !isSaving) {
                    isSaving = true
                    scope.launch {
                        try {
                            coordinator.updateWorkspace(
                                workspace = workspace,
                                name = newName,
                                permission = selectedPermission
                            )
                            onDismiss()
                        } catch (_: Exception) {} finally {
                            isSaving = false
                        }
                    }
                }
            },
            colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth(),
            enabled = !isSaving
        ) {
            Text("Save Changes", color = Color.White, fontWeight = FontWeight.Bold)
        }

        Spacer(modifier = Modifier.height(16.dp))
        Divider(color = palette.raised)
        Spacer(modifier = Modifier.height(12.dp))

        // Destructive Actions
        TextButton(
            onClick = { showDeleteConfirm = true },
            colors = ButtonDefaults.textButtonColors(contentColor = palette.danger),
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(Icons.Default.Delete, contentDescription = null, tint = palette.danger)
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = if (workspace.isManagedWorktree) "Delete Managed Worktree" else "Remove Workspace",
                fontWeight = FontWeight.Bold
            )
        }
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text(if (workspace.isManagedWorktree) "Delete Worktree?" else "Remove Workspace?", fontWeight = FontWeight.Bold) },
            text = {
                Text(
                    if (workspace.isManagedWorktree) "This will permanently remove the managed worktree folder and git worktree on your Mac."
                    else "Are you sure you want to remove \"${workspace.name}\" from Aiden? Local files on your Mac are preserved."
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        showDeleteConfirm = false
                        scope.launch {
                            try {
                                if (workspace.isManagedWorktree) {
                                    coordinator.removeManagedWorktree(workspace)
                                } else {
                                    coordinator.removeWorkspace(workspace)
                                }
                                onDeleted()
                            } catch (_: Exception) {}
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.danger)
                ) {
                    Text(if (workspace.isManagedWorktree) "Delete" else "Remove", color = Color.White)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) {
                    Text("Cancel", color = palette.foreground)
                }
            }
        )
    }
}
