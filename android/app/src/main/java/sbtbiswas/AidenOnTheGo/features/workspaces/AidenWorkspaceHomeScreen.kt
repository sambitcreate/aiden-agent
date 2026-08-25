package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material.icons.outlined.ArrowForwardIos
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DataUsage
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.FolderSpecial
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.scheduled.AidenScheduledTasksScreen
import sbtbiswas.AidenOnTheGo.models.AidenChat
import sbtbiswas.AidenOnTheGo.models.AidenUsageSummary
import sbtbiswas.AidenOnTheGo.models.AidenWorkspace
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceCreate
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi

private enum class AidenWorkspaceDestination { HOME, DIRECTORY }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenWorkspaceShellScreen(
    coordinator: AidenRemoteCoordinator,
    viewModel: AidenWorkspaceHomeViewModel,
    onNavigateToChat: (String) -> Unit,
    onNavigateToFiles: (String) -> Unit,
    onNavigateToGit: (String) -> Unit,
    productSwitcher: @Composable () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier
) {
    var destination by rememberSaveable { mutableStateOf(AidenWorkspaceDestination.HOME) }

    AnimatedContent(
        targetState = destination,
        label = "WorkspaceDestination",
        modifier = modifier
    ) { target ->
        when (target) {
            AidenWorkspaceDestination.HOME -> AidenWorkspaceHome(
                coordinator = coordinator,
                viewModel = viewModel,
                productSwitcher = productSwitcher,
                onOpenSettings = onOpenSettings,
                onOpenDirectory = { destination = AidenWorkspaceDestination.DIRECTORY },
                onNavigateToChat = onNavigateToChat
            )
            AidenWorkspaceDestination.DIRECTORY -> AidenWorkspaceDirectoryScreen(
                coordinator = coordinator,
                onNavigateBack = { destination = AidenWorkspaceDestination.HOME },
                onNavigateToChat = onNavigateToChat,
                onNavigateToFiles = onNavigateToFiles,
                onNavigateToGit = onNavigateToGit
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AidenWorkspaceHome(
    coordinator: AidenRemoteCoordinator,
    viewModel: AidenWorkspaceHomeViewModel,
    productSwitcher: @Composable () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenDirectory: () -> Unit,
    onNavigateToChat: (String) -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    val client by coordinator.client.collectAsState()
    val connectionState by coordinator.connectionState.collectAsState()
    val workspaces by coordinator.workspaces.collectAsState()
    val archivedByInstance by coordinator.archiveStore.workspaceIDsByInstance.collectAsState()
    val chats by viewModel.chats.collectAsState()
    val usage by viewModel.usage.collectAsState()
    val modelCatalog by viewModel.modelCatalog.collectAsState()
    val usageErrorMessage by viewModel.usageErrorMessage.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val errorMessage by viewModel.errorMessage.collectAsState()

    var isSearching by rememberSaveable { mutableStateOf(false) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var showScheduledTasks by rememberSaveable { mutableStateOf(false) }
    var showUsage by rememberSaveable { mutableStateOf(false) }
    var showNewChatChoices by rememberSaveable { mutableStateOf(false) }
    var showExistingWorkspacePicker by rememberSaveable { mutableStateOf(false) }
    var showNewWorkspaceDialog by rememberSaveable { mutableStateOf(false) }
    var showScratchConfirmation by rememberSaveable { mutableStateOf(false) }
    var workspaceName by rememberSaveable { mutableStateOf("") }
    var creationStatus by remember { mutableStateOf<String?>(null) }
    val usageSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    val archivedIds = coordinator.activeInstanceId?.let { archivedByInstance[it] }.orEmpty()
    val activeWorkspaces = remember(workspaces, archivedIds) {
        workspaces.filterNot { archivedIds.contains(it.id) }
    }
    val activeById = remember(activeWorkspaces) { activeWorkspaces.associateBy { it.id } }
    val visibleChats = remember(chats, activeById, searchQuery) {
        chats.filter { chat ->
            activeById.containsKey(chat.workspaceId) &&
                (searchQuery.isBlank() || chat.title.contains(searchQuery.trim(), ignoreCase = true))
        }
    }

    LaunchedEffect(workspaces, client, connectionState) {
        viewModel.hydrate(workspaces)
        if (client != null && connectionState == AidenConnectionState.CONNECTED) viewModel.load()
    }
    LaunchedEffect(errorMessage) {
        errorMessage?.let { snackbarHostState.showSnackbar(it, actionLabel = "Retry") }
    }

    fun createChat(workspace: AidenWorkspace, status: String = "Opening chat…") {
        val activeClient = client ?: return
        creationStatus = status
        scope.launch {
            try {
                val chat = activeClient.createChat(workspace.id)
                viewModel.accept(chat)
                onNavigateToChat(chat.id)
            } catch (error: Exception) {
                snackbarHostState.showSnackbar(error.message ?: "Aiden couldn't create the chat.")
            } finally {
                creationStatus = null
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            AnimatedVisibility(visible = !isSearching, enter = fadeIn(), exit = fadeOut()) {
                FloatingActionButton(
                    onClick = {
                        if (connectionState == AidenConnectionState.CONNECTED) showNewChatChoices = true
                    },
                    containerColor = palette.accent,
                    contentColor = Color.White,
                    shape = CircleShape,
                    modifier = Modifier.semantics { contentDescription = "New Workspace Chat" }
                ) {
                    Icon(Icons.Outlined.Add, contentDescription = null)
                }
            }
        },
        containerColor = palette.canvas,
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0)
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 104.dp)
            ) {
                item {
                    AidenWorkspaceHomeHeader(
                        isSearching = isSearching,
                        searchQuery = searchQuery,
                        onSearchQueryChanged = { searchQuery = it },
                        onBeginSearch = { isSearching = true },
                        onEndSearch = {
                            searchQuery = ""
                            isSearching = false
                        },
                        productSwitcher = productSwitcher,
                        onOpenSettings = onOpenSettings
                    )
                }

                if (connectionState != AidenConnectionState.CONNECTED) {
                    item {
                        Surface(
                            color = palette.raised,
                            shape = RoundedCornerShape(18.dp),
                            modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 6.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)
                            ) {
                                Icon(Icons.Outlined.WifiOff, null, tint = palette.secondary, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(10.dp))
                                Text(
                                    if (connectionState == AidenConnectionState.CONNECTING) "Connecting to Aiden Agent…" else "Offline — showing saved chats",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = palette.secondary,
                                    modifier = Modifier.weight(1f)
                                )
                                TextButton(onClick = coordinator::refreshClient) { Text("Retry") }
                            }
                        }
                    }
                }

                if (!isSearching) {
                    item {
                        Column(modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)) {
                            AidenWorkspaceNavigationRow(
                                icon = Icons.Outlined.CalendarMonth,
                                title = "Scheduled Tasks",
                                enabled = connectionState == AidenConnectionState.CONNECTED,
                                onClick = { showScheduledTasks = true }
                            )
                            AidenWorkspaceNavigationRow(
                                icon = Icons.Outlined.DataUsage,
                                title = "Usage",
                                enabled = connectionState == AidenConnectionState.CONNECTED || usage != null,
                                onClick = {
                                    if (usage != null) showUsage = true
                                    else {
                                        viewModel.load(force = true)
                                        scope.launch {
                                            snackbarHostState.showSnackbar(
                                                usageErrorMessage ?: "Loading Usage from your Mac…"
                                            )
                                        }
                                    }
                                }
                            )
                            AidenWorkspaceNavigationRow(
                                icon = Icons.Outlined.FolderOpen,
                                title = "Workspaces",
                                showsChevron = false,
                                onClick = onOpenDirectory
                            )
                        }
                    }
                    item {
                        Text(
                            "Chats",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = palette.foreground,
                            modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 12.dp)
                        )
                    }
                }

                if (visibleChats.isEmpty() && !isLoading) {
                    item {
                        AidenEmptyState(
                            icon = if (isSearching) Icons.Outlined.Search else Icons.Outlined.AddComment,
                            title = if (isSearching) "No Matching Chats" else "No Chats Yet",
                            body = if (isSearching) "Try a different search term." else "Start a new Workspace chat to begin.",
                            modifier = Modifier.padding(top = if (isSearching) 80.dp else 32.dp)
                        )
                    }
                }

                items(visibleChats, key = AidenChat::id) { chat ->
                    AidenWorkspaceChatRow(
                        chat = chat,
                        workspaceName = activeById[chat.workspaceId]?.name.orEmpty(),
                        onClick = { onNavigateToChat(chat.id) }
                    )
                }
            }

            if (isLoading && chats.isEmpty()) {
                CircularProgressIndicator(
                    modifier = Modifier.align(Alignment.Center).size(28.dp),
                    strokeWidth = 2.dp,
                    color = palette.accent
                )
            }
            creationStatus?.let { status ->
                Surface(
                    color = palette.raised,
                    shape = RoundedCornerShape(22.dp),
                    shadowElevation = 4.dp,
                    modifier = Modifier.align(Alignment.Center)
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp)
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(12.dp))
                        Text(status, color = palette.foreground)
                    }
                }
            }
        }
    }

    if (showScheduledTasks) {
        ModalBottomSheet(
            onDismissRequest = { showScheduledTasks = false },
            containerColor = palette.canvas,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            Box(Modifier.fillMaxWidth().heightIn(min = 520.dp)) {
                AidenScheduledTasksScreen(coordinator) { showScheduledTasks = false }
            }
        }
    }
    if (showUsage && usage != null) {
        ModalBottomSheet(
            onDismissRequest = { showUsage = false },
            containerColor = palette.canvas,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            sheetState = usageSheetState,
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            AidenUsageSheet(
                summary = usage!!,
                providers = modelCatalog?.providers.orEmpty(),
                onDismiss = { showUsage = false }
            )
        }
    }
    if (showNewChatChoices) {
        ModalBottomSheet(
            onDismissRequest = { showNewChatChoices = false },
            containerColor = palette.canvas,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
            ) {
                Text("New Workspace Chat", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(10.dp))
                AidenNewChatChoice(
                    "Existing Workspace",
                    "Choose a workspace and open a new chat",
                    Icons.Outlined.FolderOpen,
                    enabled = activeWorkspaces.isNotEmpty()
                ) {
                    showNewChatChoices = false
                    showExistingWorkspacePicker = true
                }
                AidenNewChatChoice("New Workspace", "Create a reusable workspace and its first chat", Icons.Outlined.AddComment) {
                    showNewChatChoices = false
                    workspaceName = ""
                    showNewWorkspaceDialog = true
                }
                AidenNewChatChoice("Managed Scratch Workspace", "Create an isolated scratch workspace and chat", Icons.Outlined.FolderSpecial) {
                    showNewChatChoices = false
                    showScratchConfirmation = true
                }
                Spacer(Modifier.height(12.dp))
            }
        }
    }
    if (showExistingWorkspacePicker) {
        AlertDialog(
            onDismissRequest = { showExistingWorkspacePicker = false },
            title = { Text("Existing Workspace") },
            text = {
                Column {
                    activeWorkspaces.forEach { workspace ->
                        Surface(
                            onClick = {
                                showExistingWorkspacePicker = false
                                createChat(workspace)
                            },
                            color = Color.Transparent,
                            shape = RoundedCornerShape(16.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(workspace.name, modifier = Modifier.padding(horizontal = 10.dp, vertical = 14.dp))
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { showExistingWorkspacePicker = false }) { Text("Cancel") } },
            containerColor = palette.canvas
        )
    }
    if (showNewWorkspaceDialog) {
        AidenWorkspaceNameDialog(
            name = workspaceName,
            onNameChanged = { workspaceName = it },
            onDismiss = { showNewWorkspaceDialog = false },
            onCreate = {
                val name = workspaceName.trim()
                if (name.isEmpty()) return@AidenWorkspaceNameDialog
                showNewWorkspaceDialog = false
                creationStatus = "Creating workspace…"
                scope.launch {
                    try {
                        val workspace = coordinator.createWorkspace(AidenWorkspaceCreate.Folderless(name = name))
                        createChat(workspace, "Opening chat…")
                    } catch (error: Exception) {
                        creationStatus = null
                        snackbarHostState.showSnackbar(error.message ?: "Aiden couldn't create the workspace.")
                    }
                }
            }
        )
    }
    if (showScratchConfirmation) {
        AlertDialog(
            onDismissRequest = { showScratchConfirmation = false },
            title = { Text("Managed Scratch Workspace") },
            text = { Text("Create an isolated managed workspace and open its first chat?") },
            confirmButton = {
                Button(
                    onClick = {
                        showScratchConfirmation = false
                        creationStatus = "Preparing scratch workspace…"
                        scope.launch {
                            try {
                                val workspace = coordinator.createWorkspace(AidenWorkspaceCreate.Scratch())
                                createChat(workspace, "Opening chat…")
                            } catch (error: Exception) {
                                creationStatus = null
                                snackbarHostState.showSnackbar(error.message ?: "Aiden couldn't create the scratch workspace.")
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                ) { Text("Create") }
            },
            dismissButton = { TextButton(onClick = { showScratchConfirmation = false }) { Text("Cancel") } },
            containerColor = palette.canvas
        )
    }
}

@Composable
private fun AidenWorkspaceHomeHeader(
    isSearching: Boolean,
    searchQuery: String,
    onSearchQueryChanged: (String) -> Unit,
    onBeginSearch: () -> Unit,
    onEndSearch: () -> Unit,
    productSwitcher: @Composable () -> Unit,
    onOpenSettings: () -> Unit
) {
    val palette = AidenTheme.palette
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp)
    ) {
        if (!isSearching) {
            Box(modifier = Modifier.size(68.dp), contentAlignment = Alignment.CenterStart) { productSwitcher() }
            Spacer(Modifier.weight(1f))
            Surface(color = palette.raised, shape = RoundedCornerShape(28.dp), shadowElevation = 2.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBeginSearch, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Outlined.Search, "Search Workspace chats")
                    }
                    IconButton(onClick = onOpenSettings, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Outlined.Person, "Profile and settings", tint = palette.accent)
                    }
                }
            }
        } else {
            Surface(
                color = palette.raised,
                shape = RoundedCornerShape(28.dp),
                modifier = Modifier.fillMaxWidth().height(54.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 14.dp)) {
                    Icon(Icons.Outlined.Search, null, tint = palette.secondary)
                    Spacer(Modifier.width(10.dp))
                    BasicTextField(
                        value = searchQuery,
                        onValueChange = onSearchQueryChanged,
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = palette.foreground),
                        cursorBrush = SolidColor(palette.accent),
                        modifier = Modifier.weight(1f)
                    )
                    IconButton(onClick = onEndSearch) { Icon(Icons.Outlined.Close, "Close search") }
                }
            }
        }
    }
}

@Composable
private fun AidenWorkspaceNavigationRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    enabled: Boolean = true,
    showsChevron: Boolean = true,
    onClick: () -> Unit
) {
    val palette = AidenTheme.palette
    Surface(
        onClick = onClick,
        enabled = enabled,
        color = Color.Transparent,
        shape = RoundedCornerShape(18.dp),
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 6.dp, vertical = 8.dp)) {
            Icon(icon, null, tint = if (enabled) palette.accent else palette.secondary.copy(alpha = .45f), modifier = Modifier.size(24.dp))
            Spacer(Modifier.width(16.dp))
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                color = if (enabled) palette.foreground else palette.secondary,
                modifier = Modifier.weight(1f)
            )
            if (showsChevron) {
                Icon(Icons.Outlined.ArrowForwardIos, null, tint = palette.secondary, modifier = Modifier.size(14.dp))
            }
        }
    }
}

@Composable
private fun AidenWorkspaceChatRow(chat: AidenChat, workspaceName: String, onClick: () -> Unit) {
    val palette = AidenTheme.palette
    Surface(
        onClick = onClick,
        color = Color.Transparent,
        shape = RoundedCornerShape(18.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 1.dp)
    ) {
        Row(
            verticalAlignment = Alignment.Top,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 12.dp)
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    chat.title.ifBlank { "New Chat" },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium,
                    color = palette.foreground,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(Modifier.height(3.dp))
                Text(workspaceName, style = MaterialTheme.typography.bodySmall, color = palette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(12.dp))
            Text(aidenRelativeTimestamp(chat.updatedAt), style = MaterialTheme.typography.labelMedium, color = palette.secondary)
        }
    }
}

@Composable
private fun AidenNewChatChoice(
    title: String,
    detail: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    enabled: Boolean = true,
    onClick: () -> Unit
) {
    val palette = AidenTheme.palette
    Surface(onClick = onClick, enabled = enabled, color = Color.Transparent, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 6.dp, vertical = 12.dp)) {
            Icon(icon, null, tint = if (enabled) palette.foreground else palette.secondary.copy(alpha = .45f))
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = if (enabled) palette.foreground else palette.secondary)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            }
        }
    }
}

@Composable
private fun AidenWorkspaceNameDialog(
    name: String,
    onNameChanged: (String) -> Unit,
    onDismiss: () -> Unit,
    onCreate: () -> Unit
) {
    val palette = AidenTheme.palette
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New Workspace") },
        text = {
            Surface(color = palette.raised, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth().height(54.dp)) {
                BasicTextField(
                    value = name,
                    onValueChange = onNameChanged,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = palette.foreground),
                    cursorBrush = SolidColor(palette.accent),
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 16.dp)
                )
            }
        },
        confirmButton = { TextButton(onClick = onCreate, enabled = name.trim().isNotEmpty()) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = palette.canvas
    )
}
