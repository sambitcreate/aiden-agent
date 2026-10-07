package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.activity.compose.BackHandler
import sbtbiswas.AidenOnTheGo.ui.theme.rememberAidenFullSheetState
import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import sbtbiswas.AidenOnTheGo.features.shared.AidenReadPresentation
import sbtbiswas.AidenOnTheGo.persistence.AidenReadSnapshotKeys
import sbtbiswas.AidenOnTheGo.ui.theme.AidenActivityDot
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonList
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSegmentedPillRow
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** Corner radius of Aiden's squircle floating actions. */
private val AidenFabShape = RoundedCornerShape(18.dp)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenWorkspaceDirectoryScreen(
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onNavigateToChat: (String) -> Unit,
    onNavigateToFiles: (String) -> Unit,
    onNavigateToGit: (String) -> Unit,
    modifier: Modifier = Modifier,
    isActive: Boolean = true
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client = coordinator.client.collectAsStateWithLifecycle().value
    val allWorkspaces by coordinator.workspaces.collectAsStateWithLifecycle()
    val archiveStore = coordinator.archiveStore
    val archivedIDs by archiveStore.workspaceIDsByInstance.collectAsStateWithLifecycle()
    val activeInstanceId = coordinator.activeInstanceId

    var searchQuery by remember { mutableStateOf("") }
    var selectedTab by remember { mutableIntStateOf(0) } // 0: Active, 1: Archived
    var selectedWorkspace by remember { mutableStateOf<AidenWorkspace?>(null) }
    BackHandler(enabled = isActive && selectedWorkspace != null) { selectedWorkspace = null }
    // The selected Workspace's chats render from its saved listing while they refresh.
    var workspaceChats by remember { mutableStateOf<List<AidenWorkspaceChatListing>?>(null) }
    var workspaceChatsOwner by remember { mutableStateOf<String?>(null) }
    var isLoadingChats by remember { mutableStateOf(false) }
    var chatsLoadFailed by remember { mutableStateOf(false) }
    var chatsReloadToken by remember { mutableIntStateOf(0) }
    var isCreatingChat by remember { mutableStateOf(false) }
    var isCreatingWorkspace by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }
    // Renames show at once and roll back on failure. Removals are destructive and the
    // desktop can refuse them, so their rows only show a pending state until it answers.
    var pendingNames by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var pendingRemovalIds by remember { mutableStateOf<Set<String>>(emptySet()) }

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
    val displayedWorkspaces = remember(allWorkspaces, pendingNames) {
        aidenWorkspacesWithPendingNames(allWorkspaces, pendingNames)
    }

    val activeWorkspaces = remember(displayedWorkspaces, instanceArchivedSet, searchQuery) {
        displayedWorkspaces
            .filter { !instanceArchivedSet.contains(it.id) }
            .filter { searchQuery.isEmpty() || it.name.contains(searchQuery, ignoreCase = true) }
    }

    val archivedWorkspaces = remember(displayedWorkspaces, instanceArchivedSet, searchQuery) {
        displayedWorkspaces
            .filter { instanceArchivedSet.contains(it.id) }
            .filter { searchQuery.isEmpty() || it.name.contains(searchQuery, ignoreCase = true) }
    }

    LaunchedEffect(selectedWorkspace?.id, client, activeInstanceId, chatsReloadToken) {
        val ws = selectedWorkspace ?: run {
            workspaceChats = null
            workspaceChatsOwner = null
            return@LaunchedEffect
        }
        val instanceId = activeInstanceId
        val key = AidenReadSnapshotKeys.workspaceChats(ws.id)
        // A retry keeps what is shown; a different Workspace starts from its own saved listing.
        if (workspaceChatsOwner != ws.id || workspaceChats == null) {
            workspaceChats = instanceId?.let {
                coordinator.readSnapshotCache.load(it, key, AidenWorkspaceChatListing.listSerializer)
            }
            workspaceChatsOwner = ws.id
        }
        chatsLoadFailed = false
        val activeClient = client ?: return@LaunchedEffect
        isLoadingChats = true
        try {
            val fresh = AidenWorkspaceChatListing.of(AidenChat.regularWorkspaceChats(activeClient.chats(ws.id)))
            if (coordinator.client.value === activeClient && coordinator.activeInstanceId == instanceId) {
                workspaceChats = fresh
                instanceId?.let { coordinator.readSnapshotCache.store(it, key, fresh, AidenWorkspaceChatListing.listSerializer) }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // Saved chats stay on screen; only an empty screen turns into the error state.
            chatsLoadFailed = true
        } finally {
            isLoadingChats = false
        }
    }

    fun startChat(workspace: AidenWorkspace) {
        val activeClient = client ?: return
        if (isCreatingChat) return
        isCreatingChat = true
        scope.launch {
            try {
                val chat = activeClient.createChat(workspace.id)
                onNavigateToChat(chat.id)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                snackbarHostState.showSnackbar(error.message ?: "Aiden couldn't start a chat.")
            } finally {
                isCreatingChat = false
            }
        }
    }

    fun createWorkspace(create: AidenWorkspaceCreate) {
        if (isCreatingWorkspace) return
        isCreatingWorkspace = true
        scope.launch {
            try {
                coordinator.createWorkspace(create)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                snackbarHostState.showSnackbar(error.message ?: "Aiden couldn't create the workspace.")
            } finally {
                isCreatingWorkspace = false
            }
        }
    }

    fun renameWorkspace(target: AidenWorkspace, newName: String) {
        pendingNames = pendingNames + (target.id to newName)
        scope.launch {
            try {
                coordinator.updateWorkspace(target, name = newName)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                snackbarHostState.showSnackbar(error.message ?: "Aiden couldn't rename \"${target.name}\".")
            } finally {
                // Success already put the server's Workspace in the list; failure rolls back.
                pendingNames = pendingNames - target.id
            }
        }
    }

    fun removeWorkspace(target: AidenWorkspace, managedWorktree: Boolean) {
        if (target.id in pendingRemovalIds) return
        pendingRemovalIds = pendingRemovalIds + target.id
        scope.launch {
            try {
                if (managedWorktree) coordinator.removeManagedWorktree(target) else coordinator.removeWorkspace(target)
                if (selectedWorkspace?.id == target.id) selectedWorkspace = null
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                snackbarHostState.showSnackbar(
                    error.message ?: if (managedWorktree) "Aiden couldn't delete the worktree." else "Aiden couldn't remove \"${target.name}\"."
                )
            } finally {
                pendingRemovalIds = pendingRemovalIds - target.id
            }
        }
    }

    Scaffold(
        modifier = modifier,
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            if (selectedWorkspace != null) {
                val fabInteraction = remember { MutableInteractionSource() }
                FloatingActionButton(
                    onClick = {
                        val currentWs = selectedWorkspace ?: return@FloatingActionButton
                        startChat(currentWs)
                    },
                    containerColor = palette.accent,
                    contentColor = palette.onAccent,
                    shape = AidenFabShape,
                    interactionSource = fabInteraction,
                    modifier = Modifier.tactilePress(fabInteraction)
                ) {
                    if (isCreatingChat) {
                        AidenActivityDot(color = palette.onAccent, size = 10.dp, contentDescription = "Opening new chat")
                    } else {
                        Icon(Icons.Default.Add, contentDescription = "New Chat")
                    }
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
                .aidenReadableWidth()
        ) {
            // If a workspace is currently selected, show Workspace Detail view
            val activeWs = selectedWorkspace?.let { selected ->
                displayedWorkspaces.firstOrNull { it.id == selected.id } ?: selected
            }
            if (activeWs != null) {
                // Detail Header
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
                ) {
                    IconButton(onClick = { selectedWorkspace = null }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to Workspaces", tint = palette.foreground)
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

                AidenWorkspaceQuickActions(
                    uncommitted = activeWs.git?.uncommitted ?: 0,
                    onFiles = { onNavigateToFiles(activeWs.id) },
                    onGitReview = { onNavigateToGit(activeWs.id) },
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                )

                HorizontalDivider(color = palette.raised, modifier = Modifier.padding(vertical = 4.dp))

                AidenWorkspaceChatList(
                    chats = workspaceChats,
                    isRefreshing = isLoadingChats,
                    loadFailed = chatsLoadFailed,
                    canStartChat = client != null && !isCreatingChat,
                    onOpenChat = onNavigateToChat,
                    onStartChat = { startChat(activeWs) },
                    onRetry = { chatsReloadToken += 1 }
                )
            } else {
                // Workspace Directory View
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 2.dp)
                ) {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to Workspace home", tint = palette.foreground)
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
                        val addInteraction = remember { MutableInteractionSource() }
                        Surface(
                            onClick = { showCreateMenu = true },
                            enabled = !isCreatingWorkspace,
                            shape = AidenFabShape,
                            color = palette.accent,
                            contentColor = palette.onAccent,
                            shadowElevation = 3.dp,
                            interactionSource = addInteraction,
                            modifier = Modifier
                                .size(54.dp)
                                .tactilePress(addInteraction)
                                .semantics { role = Role.Button }
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                if (isCreatingWorkspace) {
                                    AidenActivityDot(color = palette.onAccent, size = 10.dp, contentDescription = "Creating workspace")
                                } else {
                                    Icon(Icons.Default.Add, contentDescription = "Add Workspace", tint = palette.onAccent, modifier = Modifier.size(22.dp))
                                }
                            }
                        }
                        DropdownMenu(
                            expanded = showCreateMenu,
                            onDismissRequest = { showCreateMenu = false },
                            shape = AidenShape.Snackbar,
                            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest
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
                                text = { Text("Add Desktop Folder...") },
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
                AidenSegmentedPillRow(
                    options = listOf(0, 1),
                    selected = selectedTab,
                    onSelect = { selectedTab = it },
                    label = { tab ->
                        if (tab == 0) "Active (${activeWorkspaces.size})" else "Archived (${archivedWorkspaces.size})"
                    },
                    role = Role.Tab,
                    modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 4.dp)
                )

                val currentList = if (selectedTab == 0) activeWorkspaces else archivedWorkspaces

                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
                ) {
                    if (currentList.isEmpty()) {
                        item {
                            AidenEmptyState(
                                icon = if (selectedTab == 0) Icons.Default.FolderOpen else Icons.Default.Archive,
                                title = if (selectedTab == 0) "No active workspaces" else "No archived workspaces",
                                body = if (selectedTab == 0)
                                    "Create a workspace or add an approved folder from your desktop."
                                else
                                    "Workspaces archived on this device will appear here."
                            )
                        }
                    }

                    itemsIndexed(currentList, key = { _, ws -> ws.id }) { index, ws ->
                        var showRowMenu by remember { mutableStateOf(false) }
                        val isRemoving = ws.id in pendingRemovalIds

                        AidenGroupCard(
                            index = index,
                            count = currentList.size,
                            onClick = { if (!isRemoving) selectedWorkspace = ws },
                            contentPadding = PaddingValues(start = 12.dp, end = 4.dp, top = 10.dp, bottom = 10.dp)
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
                                    if (isRemoving) {
                                        AidenActivityDot(color = palette.secondary, size = 6.dp)
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Text(
                                            text = if (ws.isManagedWorktree) "Deleting…" else "Removing…",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = palette.secondary
                                        )
                                        Text(" • ", color = palette.secondary)
                                    }
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
                                IconButton(onClick = { showRowMenu = true }, enabled = !isRemoving) {
                                    Icon(Icons.Default.MoreVert, contentDescription = "More actions", tint = palette.secondary)
                                }
                                DropdownMenu(
                                    expanded = showRowMenu,
                                    onDismissRequest = { showRowMenu = false },
                                    shape = AidenShape.Snackbar,
                                    containerColor = MaterialTheme.colorScheme.surfaceContainerHighest
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
                                    HorizontalDivider()
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

    // --- Dialogs ---

    // New Workspace Dialog
    if (showNewWorkspaceDialog) {
        AidenWorkspaceAlertDialog(
            title = "New Workspace",
            onDismissRequest = { showNewWorkspaceDialog = false },
            confirmText = "Create",
            onConfirm = {
                val name = newWorkspaceName.trim()
                if (name.isNotEmpty()) {
                    showNewWorkspaceDialog = false
                    createWorkspace(AidenWorkspaceCreate.Folderless(name = name))
                }
            }
        ) {
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
        }
    }

    // New Scratch Workspace Confirm Dialog
    if (showScratchConfirmDialog) {
        AidenWorkspaceAlertDialog(
            title = "Create Managed Scratch?",
            onDismissRequest = { showScratchConfirmDialog = false },
            confirmText = "Create Scratch",
            onConfirm = {
                showScratchConfirmDialog = false
                createWorkspace(AidenWorkspaceCreate.Scratch())
            }
        ) {
            Text("Aiden will create an isolated scratch workspace in an ephemeral location on your paired desktop.")
        }
    }

    // Rename Dialog
    if (showRenameDialog && workspaceToRename != null) {
        val target = workspaceToRename!!
        AidenWorkspaceAlertDialog(
            title = "Rename Workspace",
            onDismissRequest = { showRenameDialog = false },
            confirmText = "Save",
            onConfirm = {
                val newName = renameInput.trim()
                if (newName.isNotEmpty()) {
                    showRenameDialog = false
                    if (newName != target.name) renameWorkspace(target, newName)
                }
            }
        ) {
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
        }
    }

    // Archive on Device Disclosure Dialog
    if (showArchiveDisclosureDialog && workspaceToArchive != null) {
        val target = workspaceToArchive!!
        AidenWorkspaceAlertDialog(
            title = "Archive on this Device",
            onDismissRequest = { showArchiveDisclosureDialog = false },
            confirmText = "Got it, Archive",
            onConfirm = {
                archiveStore.acknowledgeDeviceOnlyArchive()
                archiveStore.archive(target.id, activeInstanceId)
                showArchiveDisclosureDialog = false
            }
        ) {
            Text("Archiving a workspace hides it only on this device. Your paired desktop, files, and other devices remain completely unaffected.")
        }
    }

    // Remove Workspace Confirm Dialog
    if (showRemoveDialog && workspaceToRemove != null) {
        val target = workspaceToRemove!!
        AidenWorkspaceAlertDialog(
            title = "Remove Workspace?",
            onDismissRequest = { showRemoveDialog = false },
            confirmText = "Remove",
            destructive = true,
            onConfirm = {
                showRemoveDialog = false
                removeWorkspace(target, managedWorktree = false)
            }
        ) {
            Text("Are you sure you want to remove \"${target.name}\" from Aiden? Local files on your paired desktop are preserved.")
        }
    }

    // Delete Managed Worktree Confirm Dialog
    if (showDeleteWorktreeDialog && worktreeToDelete != null) {
        val target = worktreeToDelete!!
        AidenWorkspaceAlertDialog(
            title = "Delete Managed Worktree?",
            onDismissRequest = { showDeleteWorktreeDialog = false },
            confirmText = "Delete Worktree",
            destructive = true,
            onConfirm = {
                showDeleteWorktreeDialog = false
                removeWorkspace(target, managedWorktree = true)
            }
        ) {
            Text("This will permanently remove the managed worktree folder and git worktree on your paired desktop.")
        }
    }

    // Folder Browser Sheet
    if (showFolderBrowserSheet) {
        ModalBottomSheet(
            onDismissRequest = { showFolderBrowserSheet = false },
            sheetState = rememberAidenFullSheetState(),
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
            sheetState = rememberAidenFullSheetState(),
            containerColor = palette.canvas
        ) {
            val settingsTarget = workspaceToEditSettings!!
            AidenWorkspaceSettingsSheet(
                workspace = settingsTarget,
                coordinator = coordinator,
                onDismiss = { showSettingsSheet = false },
                onRemove = {
                    showSettingsSheet = false
                    removeWorkspace(settingsTarget, managedWorktree = settingsTarget.isManagedWorktree)
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
    val client = coordinator.client.collectAsStateWithLifecycle().value

    var roots by remember { mutableStateOf<List<AidenBrowserRoot>>(emptyList()) }
    var currentPage by remember { mutableStateOf<AidenBrowserPage?>(null) }
    var currentLocation by remember { mutableStateOf<String?>(null) }
    var currentCursor by remember { mutableStateOf<String?>(null) }
    var isLoading by remember { mutableStateOf(false) }
    var isAdding by remember { mutableStateOf(false) }
    var addError by remember { mutableStateOf<String?>(null) }

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
                text = "Browse Desktop Folders",
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
            AidenFolderBreadcrumbs(
                crumbs = aidenFolderCrumbs(page.breadcrumbs),
                onSelect = { crumb ->
                    val location = crumb.location
                    if (location == null) {
                        currentPage = null
                        currentLocation = null
                    } else {
                        loadLocation(location)
                    }
                },
                modifier = Modifier.padding(vertical = 8.dp)
            )
        }

        HorizontalDivider(color = palette.raised, modifier = Modifier.padding(vertical = 4.dp))

        // Content
        if (page == null) {
            // Show Roots
            LazyColumn(
                modifier = Modifier
                    .weight(1f, fill = false)
                    .fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
            ) {
                if (roots.isEmpty() && isLoading) {
                    item(key = "roots-skeleton") {
                        AidenSkeletonList(count = 3, supporting = false, loadingDescription = "Loading folders")
                    }
                }
                itemsIndexed(roots, key = { _, root -> root.id }) { index, root ->
                    AidenGroupCard(
                        index = index,
                        count = roots.size,
                        onClick = { loadLocation(root.location) },
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp)
                    ) {
                        Icon(Icons.Default.Folder, contentDescription = null, tint = palette.accent)
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
        } else {
            // Show Page Entries
            LazyColumn(
                modifier = Modifier
                    .weight(1f, fill = false)
                    .fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
            ) {
                itemsIndexed(page.entries, key = { _, entry -> entry.id }) { index, entry ->
                    AidenGroupCard(
                        index = index,
                        count = page.entries.size,
                        onClick = { loadLocation(entry.location) },
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp)
                    ) {
                        Icon(Icons.Default.FolderOpen, contentDescription = null, tint = palette.accent)
                        Text(
                            text = entry.name,
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.foreground,
                            modifier = Modifier.weight(1f)
                        )
                        Icon(Icons.Default.ChevronRight, contentDescription = null, tint = palette.secondary)
                    }
                }

                if (page.nextCursor != null) {
                    item {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 8.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            AidenTonalButton(
                                text = "Load More",
                                onClick = {
                                    val loc = currentLocation
                                    if (loc != null) loadLocation(loc, page.nextCursor, append = true)
                                }
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Add This Folder Button
            val loc = currentLocation
            if (loc != null) {
                val addInteraction = remember { MutableInteractionSource() }
                Button(
                    onClick = {
                        if (client != null && !isAdding) {
                            isAdding = true
                            addError = null
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
                                } catch (error: CancellationException) {
                                    throw error
                                } catch (error: Exception) {
                                    addError = error.message ?: "Aiden couldn't add this folder."
                                } finally {
                                    isAdding = false
                                }
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = palette.accent,
                        contentColor = palette.onAccent,
                        disabledContainerColor = palette.accent.copy(alpha = 0.6f),
                        disabledContentColor = palette.onAccent
                    ),
                    shape = AidenShape.Button,
                    interactionSource = addInteraction,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .tactilePress(addInteraction),
                    enabled = !isAdding
                ) {
                    // An in-place pending label: adding creates a Workspace on the desktop.
                    Text(
                        if (isAdding) "Adding Folder…" else "Add This Folder as Workspace",
                        fontWeight = FontWeight.Bold
                    )
                }
                addError?.let { message ->
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.danger,
                        modifier = Modifier
                            .padding(top = 8.dp)
                            .semantics { liveRegion = LiveRegionMode.Polite }
                    )
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
    onRemove: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    var nameInput by remember { mutableStateOf(workspace.name) }
    var selectedPermission by remember { mutableStateOf(workspace.permission) }
    var memoryEnabled by remember { mutableStateOf(workspace.memoryEnabled) }
    var isSaving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }
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

        AidenWorkspacePermissionGroup(
            selected = selectedPermission,
            onSelect = { selectedPermission = it }
        )

        Spacer(modifier = Modifier.height(16.dp))

        AidenWorkspaceMemoryRow(
            checked = memoryEnabled,
            onCheckedChange = { memoryEnabled = it }
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Save Button
        // Permission and memory are access policy the desktop can refuse, so the sheet
        // waits for its answer with an in-place pending label instead of guessing.
        AidenPrimaryButton(
            text = if (isSaving) "Saving…" else "Save Changes",
            onClick = {
                val newName = nameInput.trim()
                if (newName.isNotEmpty() && !isSaving) {
                    isSaving = true
                    saveError = null
                    scope.launch {
                        try {
                            coordinator.updateWorkspace(
                                workspace = workspace,
                                name = newName,
                                permission = selectedPermission,
                                memoryEnabled = memoryEnabled
                            )
                            onDismiss()
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            saveError = error.message ?: "Aiden couldn't save these settings."
                        } finally {
                            isSaving = false
                        }
                    }
                }
            },
            enabled = !isSaving,
            modifier = Modifier.fillMaxWidth()
        )
        saveError?.let { message ->
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = palette.danger,
                modifier = Modifier
                    .padding(top = 8.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite }
            )
        }

        Spacer(modifier = Modifier.height(16.dp))
        HorizontalDivider(color = palette.raised)
        Spacer(modifier = Modifier.height(12.dp))

        // Destructive Actions
        AidenTonalButton(
            text = if (workspace.isManagedWorktree) "Delete Managed Worktree" else "Remove Workspace",
            onClick = { showDeleteConfirm = true },
            destructive = true,
            leadingIcon = Icons.Default.Delete,
            modifier = Modifier.fillMaxWidth()
        )
    }

    if (showDeleteConfirm) {
        AidenWorkspaceAlertDialog(
            title = if (workspace.isManagedWorktree) "Delete Worktree?" else "Remove Workspace?",
            onDismissRequest = { showDeleteConfirm = false },
            confirmText = if (workspace.isManagedWorktree) "Delete" else "Remove",
            destructive = true,
            onConfirm = {
                showDeleteConfirm = false
                onRemove()
            }
        ) {
            Text(
                if (workspace.isManagedWorktree) "This will permanently remove the managed worktree folder and git worktree on your paired desktop."
                else "Are you sure you want to remove \"${workspace.name}\" from Aiden? Local files on your paired desktop are preserved."
            )
        }
    }
}

/** The slice of a Workspace chat its row shows, small enough to keep per Workspace. */
@Serializable
internal data class AidenWorkspaceChatListing(
    val id: String,
    val title: String,
    val messageCount: Int
) {
    companion object {
        val listSerializer = ListSerializer(serializer())

        fun of(chats: List<AidenChat>): List<AidenWorkspaceChatListing> =
            chats.map { AidenWorkspaceChatListing(it.id, it.title, it.messages.size) }
    }
}

/** Shows each pending rename over the server's list until the desktop answers. */
internal fun aidenWorkspacesWithPendingNames(
    workspaces: List<AidenWorkspace>,
    pendingNames: Map<String, String>
): List<AidenWorkspace> =
    if (pendingNames.isEmpty()) workspaces
    else workspaces.map { workspace -> pendingNames[workspace.id]?.let { workspace.copy(name = it) } ?: workspace }

/**
 * A Workspace's chats. A saved listing renders at once and stays while it refreshes;
 * [chats] is null only when nothing is saved, which shows placeholders on a first read
 * and the error state if that read fails.
 */
@Composable
internal fun AidenWorkspaceChatList(
    chats: List<AidenWorkspaceChatListing>?,
    isRefreshing: Boolean,
    loadFailed: Boolean,
    canStartChat: Boolean,
    onOpenChat: (String) -> Unit,
    onStartChat: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val presentation = AidenReadPresentation.of(
        hasContent = chats != null,
        isFetching = isRefreshing,
        hasSettled = true,
        failed = loadFailed
    )
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
    ) {
        when (presentation) {
            AidenReadPresentation.SKELETON -> item(key = "workspace-chats-skeleton") {
                AidenSkeletonList(count = 5, loadingDescription = "Loading chats")
            }
            AidenReadPresentation.FAILED -> item(key = "workspace-chats-error") {
                AidenWorkspaceChatLoadErrorState(
                    message = "Reconnect and try again.",
                    onRetry = onRetry,
                    modifier = Modifier.padding(top = 32.dp)
                )
            }
            AidenReadPresentation.EMPTY, AidenReadPresentation.CONTENT -> {
                val listing = chats.orEmpty()
                if (listing.isEmpty()) {
                    item(key = "workspace-chats-empty") {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(40.dp)
                        ) {
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
                            AidenPrimaryButton(text = "Start a Chat", onClick = onStartChat, enabled = canStartChat)
                        }
                    }
                }
                itemsIndexed(listing, key = { _, chat -> chat.id }) { index, chat ->
                    AidenGroupCard(
                        index = index,
                        count = listing.size,
                        onClick = { onOpenChat(chat.id) },
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp)
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = null, tint = palette.accent)
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
                                text = if (chat.messageCount == 1) "1 message" else "${chat.messageCount} messages",
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.secondary
                            )
                        }
                        Icon(Icons.Default.ChevronRight, contentDescription = null, tint = palette.secondary)
                    }
                }
            }
        }
    }
}

/** Connected Files / Git Review action pair shown above a workspace's chats. */
@Composable
internal fun AidenWorkspaceQuickActions(
    uncommitted: Int,
    onFiles: () -> Unit,
    onGitReview: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
    ) {
        AidenConnectedActionSegment(
            index = 0,
            count = 2,
            label = "Files",
            icon = Icons.Default.FolderOpen,
            onClick = onFiles,
            modifier = Modifier.weight(1f)
        )
        AidenConnectedActionSegment(
            index = 1,
            count = 2,
            label = "Git Review",
            icon = Icons.Default.Commit,
            onClick = onGitReview,
            modifier = Modifier.weight(1f),
            trailing = if (uncommitted > 0) {
                {
                    Surface(color = palette.accent.copy(alpha = 0.14f), shape = CircleShape) {
                        Text(
                            text = if (uncommitted > 99) "99+" else uncommitted.toString(),
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = palette.accent,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp)
                        )
                    }
                }
            } else {
                null
            }
        )
    }
}

/**
 * Horizontally scrollable breadcrumb pills for the desktop folder browser. The trail keeps
 * its newest crumb in view, scrolling instantly when motion is reduced.
 */
@Composable
internal fun AidenFolderBreadcrumbs(
    crumbs: List<AidenFolderCrumb>,
    onSelect: (AidenFolderCrumb) -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val listState = rememberLazyListState()
    LaunchedEffect(crumbs.size, crumbs.lastOrNull()?.location) {
        if (crumbs.isEmpty()) return@LaunchedEffect
        if (reduceMotion) listState.scrollToItem(crumbs.lastIndex) else listState.animateScrollToItem(crumbs.lastIndex)
    }
    LazyRow(
        state = listState,
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        itemsIndexed(crumbs, key = { index, crumb -> crumb.location ?: "roots-$index" }) { index, crumb ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (index > 0) {
                    Icon(
                        Icons.Default.ChevronRight,
                        contentDescription = null,
                        tint = palette.secondary,
                        modifier = Modifier
                            .padding(horizontal = 2.dp)
                            .size(16.dp)
                    )
                }
                val interaction = remember { MutableInteractionSource() }
                Surface(
                    onClick = { onSelect(crumb) },
                    shape = CircleShape,
                    color = if (crumb.isCurrent) palette.accent.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHigh,
                    interactionSource = interaction,
                    modifier = Modifier
                        .tactilePress(interaction)
                        .semantics { role = Role.Button }
                ) {
                    Text(
                        text = crumb.label,
                        style = MaterialTheme.typography.labelMedium,
                        color = if (crumb.isCurrent) palette.accent else palette.foreground,
                        maxLines = 1,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp)
                    )
                }
            }
        }
    }
}

/**
 * Connected permission choices. Each card is a radio option: selection is carried by the
 * radio control and a tonal fill, never a border.
 */
@Composable
internal fun AidenWorkspacePermissionGroup(
    selected: AidenWorkspacePermission,
    onSelect: (AidenWorkspacePermission) -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val options = AidenWorkspacePermission.entries
    AidenConnectedColumn(modifier = modifier.selectableGroup()) {
        options.forEachIndexed { index, permission ->
            val isSelected = permission == selected
            AidenGroupCard(
                index = index,
                count = options.size,
                selected = isSelected,
                onClick = { onSelect(permission) },
                role = Role.RadioButton,
                modifier = Modifier.semantics { this.selected = isSelected },
                contentPadding = PaddingValues(start = 8.dp, end = 16.dp, top = 12.dp, bottom = 12.dp)
            ) {
                RadioButton(
                    selected = isSelected,
                    onClick = null,
                    colors = RadioButtonDefaults.colors(selectedColor = palette.accent)
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = permission.title,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                        color = palette.foreground
                    )
                    Text(
                        text = permission.detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary
                    )
                }
            }
        }
    }
}

/** Memory toggle card led by the SD-card memory icon. The whole card acts as the switch. */
@Composable
internal fun AidenWorkspaceMemoryRow(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    Surface(
        color = palette.raised,
        shape = RoundedCornerShape(AidenShape.GroupOuter),
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(AidenShape.GroupOuter))
            .toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp)
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .size(32.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(palette.accent.copy(alpha = 0.12f))
            ) {
                Icon(Icons.Default.SdStorage, contentDescription = null, tint = palette.accent, modifier = Modifier.size(18.dp))
            }
            Column(Modifier.weight(1f)) {
                Text("Use memory", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, color = palette.foreground)
                Text("When off, Aiden does not index this workspace or expose memory tools in its chats. Existing memory stays on your Mac.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            }
            Switch(checked = checked, onCheckedChange = null)
        }
    }
}
