package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.activity.compose.BackHandler
import androidx.compose.material3.BottomSheetDefaults
import sbtbiswas.AidenOnTheGo.ui.theme.rememberAidenFullSheetState
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material.icons.automirrored.outlined.ArrowForwardIos
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DataUsage
import androidx.compose.material.icons.outlined.FolderCopy
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.FolderSpecial
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductTopBar
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductTopBarAction
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductTopBarHeight
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.scheduled.AidenScheduledTasksScreen
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenUsageSummary
import sbtbiswas.AidenOnTheGo.models.AidenWorkspace
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceCreate
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenWorkspaceSidebarOrganization
import sbtbiswas.AidenOnTheGo.features.shared.AidenReadPresentation
import sbtbiswas.AidenOnTheGo.ui.theme.AidenActivityDot
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonList
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalResources
import sbtbiswas.AidenOnTheGo.R
import androidx.annotation.StringRes
import androidx.compose.ui.res.pluralStringResource

private enum class AidenWorkspaceDestination { HOME, DIRECTORY }
private const val AIDEN_WORKSPACE_SIDEBAR_PREVIEW_LIMIT = 20

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenWorkspaceShellScreen(
    coordinator: AidenRemoteCoordinator,
    viewModel: AidenWorkspaceHomeViewModel,
    navigationStore: AidenProductNavigationStore,
    onNavigateToChat: (String) -> Unit,
    onNavigateToFiles: (String) -> Unit,
    onNavigateToGit: (String) -> Unit,
    productSwitcher: @Composable () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
    isActive: Boolean = true
) {
    var destination by rememberSaveable { mutableStateOf(AidenWorkspaceDestination.HOME) }
    BackHandler(enabled = isActive && destination == AidenWorkspaceDestination.DIRECTORY) {
        destination = AidenWorkspaceDestination.HOME
    }

    AnimatedContent(
        targetState = destination,
        label = "WorkspaceDestination",
        modifier = modifier
    ) { target ->
        when (target) {
            AidenWorkspaceDestination.HOME -> AidenWorkspaceHome(
                coordinator = coordinator,
                viewModel = viewModel,
                navigationStore = navigationStore,
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
                onNavigateToGit = onNavigateToGit,
                isActive = isActive
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AidenWorkspaceHome(
    coordinator: AidenRemoteCoordinator,
    viewModel: AidenWorkspaceHomeViewModel,
    navigationStore: AidenProductNavigationStore,
    productSwitcher: @Composable () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenDirectory: () -> Unit,
    onNavigateToChat: (String) -> Unit
) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    val client by coordinator.client.collectAsStateWithLifecycle()
    val connectionState by coordinator.connectionState.collectAsStateWithLifecycle()
    val hasCompletedWorkspaceRefresh by coordinator.hasCompletedWorkspaceRefresh.collectAsStateWithLifecycle()
    val installations by coordinator.installationStore.installations.collectAsStateWithLifecycle()
    val activeInstallationId by coordinator.installationStore.activeInstallationId.collectAsStateWithLifecycle()
    val workspaces by coordinator.workspaces.collectAsStateWithLifecycle()
    val archivedByInstance by coordinator.archiveStore.workspaceIDsByInstance.collectAsStateWithLifecycle()
    val chats by viewModel.chats.collectAsStateWithLifecycle()
    val scheduledTasks by viewModel.scheduledTasks.collectAsStateWithLifecycle()
    val usage by viewModel.usage.collectAsStateWithLifecycle()
    val modelCatalog by viewModel.modelCatalog.collectAsStateWithLifecycle()
    val usageErrorMessage by viewModel.usageErrorMessage.collectAsStateWithLifecycle()
    val isLoading by viewModel.isLoading.collectAsStateWithLifecycle()
    val errorMessage by viewModel.errorMessage.collectAsStateWithLifecycle()
    val chatLoadErrorMessage by viewModel.chatLoadErrorMessage.collectAsStateWithLifecycle()
    val chatListLoadState by viewModel.chatListLoadState.collectAsStateWithLifecycle()
    val nextChatCursor by viewModel.nextChatCursor.collectAsStateWithLifecycle()
    val isLoadingMoreChats by viewModel.isLoadingMoreChats.collectAsStateWithLifecycle()
    val chatPaginationErrorMessage by viewModel.chatPaginationErrorMessage.collectAsStateWithLifecycle()
    val canReadSchedules = installations.firstOrNull { it.id == activeInstallationId }
        ?.hasNegotiatedAccess(AidenRemoteCapability.SCHEDULE_READ) == true

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
    val activeInstanceId = coordinator.activeInstanceId
    var sidebarOrganizationRaw by rememberSaveable(activeInstanceId) {
        mutableStateOf(
            activeInstanceId?.let(navigationStore::workspaceSidebarOrganization)?.name
                ?: AidenWorkspaceSidebarOrganization.WORKSPACE.name
        )
    }
    var expandedWorkspaceIds by rememberSaveable(activeInstanceId) {
        mutableStateOf(
            activeInstanceId?.let(navigationStore::expandedSidebarWorkspaceIds)?.toList()
                ?: emptyList()
        )
    }
    var fullyRevealedWorkspaceIds by rememberSaveable(activeInstanceId) {
        mutableStateOf(emptyList<String>())
    }
    var showSidebarOrganizationMenu by remember { mutableStateOf(false) }
    val usageSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val reduceMotion = aidenReduceMotion()

    val archivedIds = coordinator.activeInstanceId?.let { archivedByInstance[it] }.orEmpty()
    val activeWorkspaces = remember(workspaces, archivedIds) {
        workspaces.filterNot { archivedIds.contains(it.id) }
    }
    val activeById = remember(activeWorkspaces) { activeWorkspaces.associateBy { it.id } }
    val sidebarOrganization = runCatching {
        AidenWorkspaceSidebarOrganization.valueOf(sidebarOrganizationRaw)
    }.getOrDefault(AidenWorkspaceSidebarOrganization.WORKSPACE)
    val sidebarProjection = remember(activeWorkspaces, chats, searchQuery) {
        projectAidenWorkspaceSidebar(activeWorkspaces, chats, searchQuery)
    }
    val chatListUnavailable = chatListLoadState == AidenChatListLoadState.FAILED
    val chatCreationBlocked = chatListLoadState != AidenChatListLoadState.LOADED

    LaunchedEffect(workspaces, client, connectionState, canReadSchedules) {
        viewModel.hydrate(workspaces)
        if (client != null && connectionState == AidenConnectionState.CONNECTED) viewModel.load()
    }
    // Coming back to the app rereads stale data underneath what is already shown.
    LifecycleEventEffect(Lifecycle.Event.ON_START) { viewModel.revalidate() }
    LaunchedEffect(errorMessage) {
        errorMessage?.let {
            if (
                snackbarHostState.showSnackbar(it, actionLabel = resources.getString(R.string.action_retry)) ==
                SnackbarResult.ActionPerformed
            ) {
                viewModel.refresh(workspaces)
            }
        }
    }
    LaunchedEffect(chatListUnavailable) {
        if (chatListUnavailable) {
            showNewChatChoices = false
            showExistingWorkspacePicker = false
            showNewWorkspaceDialog = false
            showScratchConfirmation = false
        }
    }
    LaunchedEffect(
        activeInstanceId,
        activeWorkspaces.map(AidenWorkspace::id),
        connectionState,
        hasCompletedWorkspaceRefresh
    ) {
        val instanceId = activeInstanceId ?: return@LaunchedEffect
        if (connectionState != AidenConnectionState.CONNECTED || !hasCompletedWorkspaceRefresh) {
            return@LaunchedEffect
        }
        val validIds = activeWorkspaces.map(AidenWorkspace::id).toSet()
        var reconciled = expandedWorkspaceIds.filter(validIds::contains).toSet()
        if (reconciled.isEmpty() && activeWorkspaces.isNotEmpty()) {
            reconciled = setOf(activeWorkspaces.first().id)
        }
        if (reconciled != expandedWorkspaceIds.toSet()) {
            expandedWorkspaceIds = reconciled.toList()
            navigationStore.setExpandedSidebarWorkspaceIds(instanceId, reconciled)
        }
        fullyRevealedWorkspaceIds = fullyRevealedWorkspaceIds.filter(validIds::contains)
    }

    fun createChat(workspace: AidenWorkspace, status: String = resources.getString(R.string.workspace_home_opening_chat)) {
        if (chatCreationBlocked) {
            scope.launch {
                snackbarHostState.showSnackbar(
                    chatLoadErrorMessage ?: resources.getString(R.string.workspace_home_chats_still_loading)
                )
            }
            return
        }
        val activeClient = client ?: return
        creationStatus = status
        scope.launch {
            try {
                val chat = activeClient.createChat(workspace.id)
                viewModel.accept(chat)
                onNavigateToChat(chat.id)
            } catch (error: Exception) {
                snackbarHostState.showSnackbar(error.message ?: resources.getString(R.string.workspace_home_create_chat_failed))
            } finally {
                creationStatus = null
            }
        }
    }

    Scaffold(
        topBar = {
            AidenWorkspaceHomeHeader(
                isSearching = isSearching,
                searchQuery = searchQuery,
                connectionState = connectionState,
                onSearchQueryChanged = { searchQuery = it },
                onBeginSearch = { isSearching = true },
                onEndSearch = {
                    searchQuery = ""
                    isSearching = false
                },
                productSwitcher = productSwitcher,
                onOpenSettings = onOpenSettings
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            AnimatedVisibility(
                visible = !isSearching && !chatCreationBlocked,
                enter = fadeIn(),
                exit = fadeOut()
            ) {
                val newChatDescription = stringResource(R.string.workspace_home_new_chat_cd)
                FloatingActionButton(
                    onClick = {
                        if (connectionState == AidenConnectionState.CONNECTED) showNewChatChoices = true
                    },
                    containerColor = palette.accent,
                    contentColor = Color.White,
                    shape = CircleShape,
                    modifier = Modifier.semantics { contentDescription = newChatDescription }
                ) {
                    Icon(Icons.Outlined.Add, contentDescription = null)
                }
            }
        },
        containerColor = palette.canvas,
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0)
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).aidenReadableWidth()) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = 104.dp)
            ) {
                if (connectionState != AidenConnectionState.CONNECTED) {
                    item {
                        Surface(
                            color = palette.raised,
                            shape = MaterialTheme.shapes.large,
                            modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 6.dp)
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)
                            ) {
                                Icon(Icons.Outlined.WifiOff, null, tint = palette.secondary, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(10.dp))
                                Text(
                                    if (connectionState == AidenConnectionState.CONNECTING) stringResource(R.string.workspace_home_connecting) else stringResource(R.string.workspace_home_offline),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = palette.secondary,
                                    modifier = Modifier.weight(1f)
                                )
                                TextButton(onClick = coordinator::refreshClient) { Text(stringResource(R.string.action_retry)) }
                            }
                        }
                    }
                }

                if (!isSearching) {
                    item {
                        AidenConnectedColumn(
                            modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
                        ) {
                            AidenWorkspaceNavigationRow(
                                index = 0,
                                count = 3,
                                icon = Icons.Outlined.CalendarMonth,
                                title = stringResource(R.string.workspace_home_scheduled_tasks),
                                enabled = canReadSchedules &&
                                        (connectionState == AidenConnectionState.CONNECTED || scheduledTasks.isNotEmpty()),
                                onClick = { showScheduledTasks = true }
                            )
                            AidenWorkspaceNavigationRow(
                                index = 1,
                                count = 3,
                                icon = Icons.Outlined.DataUsage,
                                title = stringResource(R.string.workspace_home_usage),
                                enabled = connectionState == AidenConnectionState.CONNECTED || usage != null,
                                onClick = {
                                    if (usage != null) showUsage = true
                                    else {
                                        viewModel.load(force = true)
                                        scope.launch {
                                            snackbarHostState.showSnackbar(
                                                usageErrorMessage ?: resources.getString(R.string.workspace_home_usage_loading)
                                            )
                                        }
                                    }
                                }
                            )
                            AidenWorkspaceNavigationRow(
                                index = 2,
                                count = 3,
                                icon = Icons.Outlined.FolderOpen,
                                title = stringResource(R.string.workspace_home_manage),
                                showsChevron = false,
                                onClick = onOpenDirectory
                            )
                        }
                    }
                }

                item {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = AidenUi.ScreenGutter, vertical = 12.dp)
                    ) {
                        AnimatedContent(
                            targetState = sidebarOrganization,
                            transitionSpec = {
                                fadeIn(AidenMotion.nonSpatial(reduceMotion)) togetherWith
                                    fadeOut(AidenMotion.nonSpatial(reduceMotion))
                            },
                            label = "SidebarOrganizationTitle",
                            modifier = Modifier.weight(1f)
                        ) { organization ->
                            Text(
                                if (organization == AidenWorkspaceSidebarOrganization.WORKSPACE) {
                                    stringResource(R.string.workspace_directory_title)
                                } else {
                                    stringResource(R.string.workspace_home_recents)
                                },
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = palette.foreground
                            )
                        }
                        AidenSidebarOrganizationMenu(
                            selected = sidebarOrganization,
                            expanded = showSidebarOrganizationMenu,
                            onExpandedChange = { showSidebarOrganizationMenu = it },
                            onSelect = { organization ->
                                sidebarOrganizationRaw = organization.name
                                activeInstanceId?.let {
                                    navigationStore.setWorkspaceSidebarOrganization(it, organization)
                                }
                                showSidebarOrganizationMenu = false
                            }
                        )
                    }
                }

                val projectionIsEmpty = if (
                    sidebarOrganization == AidenWorkspaceSidebarOrganization.WORKSPACE
                ) {
                    sidebarProjection.sections.isEmpty()
                } else {
                    sidebarProjection.recents.isEmpty()
                }
                val listPresentation = aidenWorkspaceHomeListPresentation(
                    projectionIsEmpty = projectionIsEmpty,
                    isSearching = isSearching,
                    isLoading = isLoading,
                    connectionState = connectionState,
                    hasCompletedWorkspaceRefresh = hasCompletedWorkspaceRefresh,
                    chatListLoadState = chatListLoadState
                )
                if (listPresentation == AidenReadPresentation.FAILED) {
                    item {
                        AidenWorkspaceChatLoadErrorState(
                            message = chatLoadErrorMessage ?: stringResource(R.string.workspace_chats_reconnect),
                            onRetry = { viewModel.refresh(workspaces) },
                            modifier = Modifier.padding(top = 32.dp)
                        )
                    }
                } else if (listPresentation == AidenReadPresentation.SKELETON) {
                    item(key = "workspace-home-skeleton") {
                        // Chat rows are text-only, inset to line up with the real rows.
                        AidenSkeletonList(
                            count = 6,
                            leading = false,
                            loadingDescription = stringResource(R.string.workspace_chats_loading),
                            modifier = Modifier.padding(horizontal = 8.dp)
                        )
                    }
                } else {
                    // Saved chats stay on screen when a refresh fails; the error sits above them.
                    if (chatListUnavailable && !projectionIsEmpty) {
                        item(key = "chat-refresh-error") {
                            AidenWorkspaceInlineRefreshError(
                                message = chatLoadErrorMessage ?: stringResource(R.string.workspace_home_refresh_failed),
                                onRetry = { viewModel.refresh(workspaces) }
                            )
                        }
                    }
                    if (listPresentation == AidenReadPresentation.EMPTY) {
                        item {
                            AidenEmptyState(
                                icon = if (isSearching) Icons.Outlined.Search else Icons.Outlined.FolderOpen,
                                title = if (isSearching) {
                                    stringResource(R.string.workspace_home_empty_search_title)
                                } else if (sidebarOrganization == AidenWorkspaceSidebarOrganization.WORKSPACE) {
                                    stringResource(R.string.workspace_home_empty_workspaces_title)
                                } else {
                                    stringResource(R.string.workspace_home_empty_chats_title)
                                },
                                body = if (isSearching) {
                                    stringResource(R.string.workspace_home_empty_search_body)
                                } else if (sidebarOrganization == AidenWorkspaceSidebarOrganization.WORKSPACE) {
                                    stringResource(R.string.workspace_home_empty_workspaces_body)
                                } else {
                                    stringResource(R.string.workspace_home_empty_chats_body)
                                },
                                modifier = Modifier.padding(top = if (isSearching) 80.dp else 32.dp)
                            )
                        }
                    }

                    if (sidebarOrganization == AidenWorkspaceSidebarOrganization.WORKSPACE) {
                        items(sidebarProjection.sections, key = { it.workspace.id }) { section ->
                            AidenWorkspaceSidebarSectionRow(
                                section = section,
                                expanded = searchQuery.isNotBlank() ||
                                    expandedWorkspaceIds.contains(section.workspace.id),
                                canCreateChat = connectionState == AidenConnectionState.CONNECTED &&
                                    creationStatus == null &&
                                    !chatCreationBlocked,
                                onToggle = {
                                    val next = expandedWorkspaceIds.toMutableSet()
                                    if (!next.remove(section.workspace.id)) next.add(section.workspace.id)
                                    expandedWorkspaceIds = next.toList()
                                    activeInstanceId?.let {
                                        navigationStore.setExpandedSidebarWorkspaceIds(it, next)
                                    }
                                },
                                onCreateChat = { createChat(section.workspace) },
                                onNavigateToChat = onNavigateToChat,
                                revealsAllChats = fullyRevealedWorkspaceIds.contains(
                                    section.workspace.id
                                ),
                                onRevealAllChats = {
                                    fullyRevealedWorkspaceIds =
                                        fullyRevealedWorkspaceIds + section.workspace.id
                                }
                            )
                        }
                    } else {
                        items(sidebarProjection.recents, key = AidenChatSummary::id) { chat ->
                            AidenWorkspaceChatRow(
                                chat = chat,
                                workspaceName = activeById[chat.workspaceId]?.name.orEmpty(),
                                showsWorkspaceName = true,
                                indented = false,
                                onClick = { onNavigateToChat(chat.id) }
                            )
                        }
                    }
                    if (nextChatCursor != null) {
                        item(key = "chat-summary-pagination") {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = AidenUi.ScreenGutter, vertical = 12.dp)
                            ) {
                                chatPaginationErrorMessage?.let { message ->
                                    Text(
                                        text = message,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = palette.warning,
                                        modifier = Modifier.padding(bottom = 4.dp)
                                    )
                                }
                                if (isLoadingMoreChats) {
                                    // The next page arrives as rows, so it is previewed as rows.
                                    AidenSkeletonList(count = 2, leading = false, loadingDescription = stringResource(R.string.workspace_home_loading_more))
                                } else {
                                    TextButton(onClick = viewModel::loadMoreChats) {
                                        Text(if (chatPaginationErrorMessage == null) stringResource(R.string.workspace_home_load_more) else stringResource(R.string.action_retry))
                                    }
                                }
                            }
                        }
                    }
                }
            }

            creationStatus?.let { status ->
                Surface(
                    color = palette.raised,
                    shape = MaterialTheme.shapes.large,
                    shadowElevation = 4.dp,
                    modifier = Modifier.align(Alignment.Center)
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp)
                    ) {
                        AidenActivityDot()
                        Spacer(Modifier.width(12.dp))
                        Text(
                            status,
                            color = palette.foreground,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                        )
                    }
                }
            }
        }
    }

    if (showScheduledTasks) {
        ModalBottomSheet(
            onDismissRequest = { showScheduledTasks = false },
            sheetState = rememberAidenFullSheetState(),
            containerColor = palette.canvas,
            shape = BottomSheetDefaults.ExpandedShape,
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            Box(Modifier.fillMaxWidth().heightIn(min = 520.dp)) {
                AidenScheduledTasksScreen(
                    coordinator = coordinator,
                    pendingRunKeys = viewModel.pendingScheduledRunKeys(activeInstallationId.orEmpty()),
                    onNavigateBack = { showScheduledTasks = false }
                )
            }
        }
    }
    if (showUsage && usage != null) {
        ModalBottomSheet(
            onDismissRequest = { showUsage = false },
            containerColor = palette.canvas,
            shape = BottomSheetDefaults.ExpandedShape,
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
            shape = BottomSheetDefaults.ExpandedShape
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
            ) {
                Text(stringResource(R.string.workspace_home_new_chat_cd), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(10.dp))
                AidenNewChatChoice(
                    stringResource(R.string.workspace_home_choice_existing),
                    stringResource(R.string.workspace_home_choice_existing_detail),
                    Icons.Outlined.FolderOpen,
                    enabled = activeWorkspaces.isNotEmpty()
                ) {
                    showNewChatChoices = false
                    showExistingWorkspacePicker = true
                }
                AidenNewChatChoice(stringResource(R.string.workspace_menu_new), stringResource(R.string.workspace_home_choice_new_detail), Icons.Outlined.AddComment) {
                    showNewChatChoices = false
                    workspaceName = ""
                    showNewWorkspaceDialog = true
                }
                AidenNewChatChoice(stringResource(R.string.workspace_home_choice_scratch), stringResource(R.string.workspace_home_choice_scratch_detail), Icons.Outlined.FolderSpecial) {
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
            title = { Text(stringResource(R.string.workspace_home_choice_existing)) },
            text = {
                AidenConnectedColumn(modifier = Modifier.verticalScroll(rememberScrollState())) {
                    activeWorkspaces.forEachIndexed { index, workspace ->
                        AidenGroupCard(
                            index = index,
                            count = activeWorkspaces.size,
                            onClick = {
                                showExistingWorkspacePicker = false
                                createChat(workspace)
                            },
                            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh
                        ) {
                            Icon(
                                Icons.Outlined.FolderOpen,
                                contentDescription = null,
                                tint = palette.accent,
                                modifier = Modifier.size(20.dp)
                            )
                            Text(
                                workspace.name,
                                style = MaterialTheme.typography.bodyLarge,
                                color = palette.foreground,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { AidenDialogDismissButton(onClick = { showExistingWorkspacePicker = false }) },
            shape = AidenShape.Dialog,
            containerColor = palette.raised
        )
    }
    if (showNewWorkspaceDialog) {
        AidenWorkspaceNameDialog(
            name = workspaceName,
            onNameChanged = { workspaceName = it },
            onDismiss = { showNewWorkspaceDialog = false },
            onCreate = {
                if (chatCreationBlocked) {
                    scope.launch {
                        snackbarHostState.showSnackbar(
                            chatLoadErrorMessage ?: resources.getString(R.string.workspace_home_chats_still_loading)
                        )
                    }
                    return@AidenWorkspaceNameDialog
                }
                val name = workspaceName.trim()
                if (name.isEmpty()) return@AidenWorkspaceNameDialog
                showNewWorkspaceDialog = false
                creationStatus = resources.getString(R.string.workspace_home_creating_workspace)
                scope.launch {
                    try {
                        val workspace = coordinator.createWorkspace(AidenWorkspaceCreate.Folderless(name = name))
                        createChat(workspace, resources.getString(R.string.workspace_home_opening_chat))
                    } catch (error: Exception) {
                        creationStatus = null
                        snackbarHostState.showSnackbar(error.message ?: resources.getString(R.string.workspace_create_failed))
                    }
                }
            }
        )
    }
    if (showScratchConfirmation) {
        AlertDialog(
            onDismissRequest = { showScratchConfirmation = false },
            title = { Text(stringResource(R.string.workspace_home_choice_scratch)) },
            text = { Text(stringResource(R.string.workspace_home_scratch_body)) },
            confirmButton = {
                AidenDialogConfirmButton(
                    text = stringResource(R.string.action_create),
                    onClick = {
                        if (chatCreationBlocked) {
                            scope.launch {
                                snackbarHostState.showSnackbar(
                                    chatLoadErrorMessage ?: resources.getString(R.string.workspace_home_chats_still_loading)
                                )
                            }
                            return@AidenDialogConfirmButton
                        }
                        showScratchConfirmation = false
                        creationStatus = resources.getString(R.string.workspace_home_preparing_scratch)
                        scope.launch {
                            try {
                                val workspace = coordinator.createWorkspace(AidenWorkspaceCreate.Scratch())
                                createChat(workspace, resources.getString(R.string.workspace_home_opening_chat))
                            } catch (error: Exception) {
                                creationStatus = null
                                snackbarHostState.showSnackbar(error.message ?: resources.getString(R.string.workspace_home_create_scratch_failed))
                            }
                        }
                    }
                )
            },
            dismissButton = { AidenDialogDismissButton(onClick = { showScratchConfirmation = false }) },
            shape = AidenShape.Dialog,
            containerColor = palette.raised
        )
    }
}

@Composable
internal fun AidenWorkspaceChatLoadErrorState(
    message: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier
) {
    AidenEmptyState(
        icon = Icons.Outlined.WifiOff,
        title = stringResource(R.string.workspace_home_chats_load_failed_title),
        body = message,
        modifier = modifier.semantics { error(message) },
        action = {
            Button(onClick = onRetry) { Text(stringResource(R.string.action_try_again)) }
        }
    )
}

/** A compact refresh failure shown above saved rows instead of replacing them. */
@Composable
internal fun AidenWorkspaceInlineRefreshError(
    message: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = AidenUi.ScreenGutter, vertical = 4.dp)
            .semantics { error(message) }
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp)
        ) {
            Text(message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            TextButton(onClick = onRetry) { Text(stringResource(R.string.action_retry), color = palette.accent) }
        }
    }
}

/**
 * The Workspace home list shows saved rows whenever it has any, placeholders only while
 * a first read is pending, and the empty or error state once reads have settled.
 */
internal fun aidenWorkspaceHomeListPresentation(
    projectionIsEmpty: Boolean,
    isSearching: Boolean,
    isLoading: Boolean,
    connectionState: AidenConnectionState,
    hasCompletedWorkspaceRefresh: Boolean,
    chatListLoadState: AidenChatListLoadState
): AidenReadPresentation {
    // A search that matches nothing is an answer, not a pending read.
    if (isSearching) return if (projectionIsEmpty) AidenReadPresentation.EMPTY else AidenReadPresentation.CONTENT
    val readsSettled = when (connectionState) {
        AidenConnectionState.OFFLINE, AidenConnectionState.NEEDS_PAIRING -> true
        AidenConnectionState.CONNECTING -> false
        AidenConnectionState.CONNECTED -> hasCompletedWorkspaceRefresh &&
            chatListLoadState != AidenChatListLoadState.UNRESOLVED
    }
    return AidenReadPresentation.of(
        hasContent = !projectionIsEmpty,
        isFetching = isLoading,
        hasSettled = readsSettled,
        failed = chatListLoadState == AidenChatListLoadState.FAILED
    )
}

@Composable
private fun AidenWorkspaceHomeHeader(
    isSearching: Boolean,
    searchQuery: String,
    connectionState: AidenConnectionState,
    onSearchQueryChanged: (String) -> Unit,
    onBeginSearch: () -> Unit,
    onEndSearch: () -> Unit,
    productSwitcher: @Composable () -> Unit,
    onOpenSettings: () -> Unit
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val trailingEdge = if (LocalLayoutDirection.current == LayoutDirection.Rtl) 0f else 1f
    AnimatedContent(
        targetState = isSearching,
        transitionSpec = {
            val origin = TransformOrigin(trailingEdge, 0.5f)
            (fadeIn(AidenMotion.nonSpatial(reduceMotion)) +
                scaleIn(AidenMotion.spatial(reduceMotion), initialScale = 0.92f, transformOrigin = origin)) togetherWith
                (fadeOut(AidenMotion.nonSpatial(reduceMotion)) +
                    scaleOut(AidenMotion.spatial(reduceMotion), targetScale = 0.96f, transformOrigin = origin)) using
                SizeTransform(clip = false) { _, _ -> AidenMotion.spatial(reduceMotion) }
        },
        contentAlignment = Alignment.CenterEnd,
        label = "WorkspaceHeaderSearchMorph",
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.canvas)
    ) { searching ->
        if (!searching) {
            AidenProductTopBar(
                title = stringResource(R.string.workspace_directory_title),
                connectionState = connectionState,
                productSwitcher = productSwitcher
            ) {
                AidenProductTopBarAction(
                    icon = Icons.Outlined.Search,
                    contentDescription = stringResource(R.string.workspace_home_search_cd),
                    onClick = onBeginSearch
                )
                AidenProductTopBarAction(
                    icon = Icons.Outlined.Person,
                    contentDescription = stringResource(R.string.workspace_home_profile_cd),
                    onClick = onOpenSettings,
                    tint = palette.accent
                )
            }
        } else {
            AidenWorkspaceSearchField(
                query = searchQuery,
                onQueryChanged = onSearchQueryChanged,
                onClose = onEndSearch
            )
        }
    }
}

@Composable
private fun AidenWorkspaceSearchField(
    query: String,
    onQueryChanged: (String) -> Unit,
    onClose: () -> Unit
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val focusRequester = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    val fill by animateColorAsState(
        targetValue = if (focused) MaterialTheme.colorScheme.surfaceContainerHigh else MaterialTheme.colorScheme.surfaceContainer,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "WorkspaceSearchFill"
    )
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxWidth()
            .height(AidenProductTopBarHeight)
            .padding(horizontal = 12.dp)
    ) {
        Surface(
            color = fill,
            shape = CircleShape,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(start = 16.dp, end = 4.dp)
            ) {
                Icon(Icons.Outlined.Search, null, tint = palette.secondary)
                Spacer(Modifier.width(10.dp))
                BasicTextField(
                    value = query,
                    onValueChange = onQueryChanged,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = palette.foreground),
                    cursorBrush = SolidColor(palette.accent),
                    decorationBox = { innerTextField ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            if (query.isEmpty()) {
                                Text(
                                    stringResource(R.string.workspace_home_search_placeholder),
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = palette.secondary
                                )
                            }
                            innerTextField()
                        }
                    },
                    modifier = Modifier
                        .weight(1f)
                        .focusRequester(focusRequester)
                        .onFocusChanged { focused = it.isFocused }
                )
                IconButton(onClick = onClose) { Icon(Icons.Outlined.Close, stringResource(R.string.workspace_home_close_search)) }
            }
        }
    }
}

@get:StringRes
private val AidenWorkspaceSidebarOrganization.menuTitle: Int
    get() = when (this) {
        AidenWorkspaceSidebarOrganization.WORKSPACE -> R.string.workspace_home_organize_by_workspace
        AidenWorkspaceSidebarOrganization.RECENT -> R.string.workspace_home_organize_recent
    }

private val AidenWorkspaceSidebarOrganization.icon: ImageVector
    get() = when (this) {
        AidenWorkspaceSidebarOrganization.WORKSPACE -> Icons.Outlined.FolderCopy
        AidenWorkspaceSidebarOrganization.RECENT -> Icons.Outlined.History
    }

@Composable
private fun AidenSidebarOrganizationMenu(
    selected: AidenWorkspaceSidebarOrganization,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onSelect: (AidenWorkspaceSidebarOrganization) -> Unit
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val organizeDescription = stringResource(R.string.workspace_home_organize_cd)
    val interaction = remember { MutableInteractionSource() }
    Box {
        IconButton(
            onClick = { onExpandedChange(true) },
            interactionSource = interaction,
            modifier = Modifier
                .tactilePress(interaction, targetScale = 0.9f)
                .semantics { contentDescription = organizeDescription }
        ) {
            AnimatedContent(
                targetState = selected,
                transitionSpec = {
                    (fadeIn(AidenMotion.nonSpatial(reduceMotion)) +
                        scaleIn(AidenMotion.spatial(reduceMotion), initialScale = 0.6f)) togetherWith
                        (fadeOut(AidenMotion.nonSpatial(reduceMotion)) +
                            scaleOut(AidenMotion.spatial(reduceMotion), targetScale = 0.6f))
                },
                label = "SidebarOrganizationIcon"
            ) { organization ->
                Icon(organization.icon, contentDescription = null, tint = palette.secondary)
            }
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { onExpandedChange(false) },
            shape = AidenShape.Snackbar,
            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest
        ) {
            AidenWorkspaceSidebarOrganization.entries.forEach { organization ->
                val isSelected = organization == selected
                DropdownMenuItem(
                    text = { Text(stringResource(organization.menuTitle)) },
                    leadingIcon = {
                        Icon(
                            organization.icon,
                            contentDescription = null,
                            tint = if (isSelected) palette.accent else palette.secondary
                        )
                    },
                    trailingIcon = {
                        if (isSelected) {
                            Icon(Icons.Outlined.Check, contentDescription = stringResource(R.string.state_selected), tint = palette.accent)
                        }
                    },
                    onClick = { onSelect(organization) }
                )
            }
        }
    }
}

@Composable
private fun AidenWorkspaceNavigationRow(
    index: Int,
    count: Int,
    icon: ImageVector,
    title: String,
    enabled: Boolean = true,
    showsChevron: Boolean = true,
    onClick: () -> Unit
) {
    val palette = AidenTheme.palette
    AidenGroupCard(
        index = index,
        count = count,
        onClick = onClick,
        enabled = enabled,
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(36.dp)
                .background(
                    if (enabled) palette.accent.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceContainerHigh,
                    AidenShape.Button
                )
        ) {
            Icon(
                icon,
                null,
                tint = if (enabled) palette.accent else palette.secondary.copy(alpha = .45f),
                modifier = Modifier.size(20.dp)
            )
        }
        Text(
            title,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
            color = if (enabled) palette.foreground else palette.secondary,
            modifier = Modifier.weight(1f)
        )
        if (showsChevron) {
            Icon(Icons.AutoMirrored.Outlined.ArrowForwardIos, null, tint = palette.secondary, modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
internal fun AidenWorkspaceSidebarSectionRow(
    section: AidenWorkspaceSidebarSection,
    expanded: Boolean,
    canCreateChat: Boolean,
    onToggle: () -> Unit,
    onCreateChat: () -> Unit,
    onNavigateToChat: (String) -> Unit,
    revealsAllChats: Boolean = false,
    onRevealAllChats: () -> Unit = {}
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val chevronRotation by animateFloatAsState(
        targetValue = if (expanded) 0f else if (rtl) 90f else -90f,
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "WorkspaceDisclosureChevron"
    )
    val visibleChats = if (revealsAllChats) {
        section.chats
    } else {
        section.chats.take(AIDEN_WORKSPACE_SIDEBAR_PREVIEW_LIMIT)
    }
    val remainingChatCount = section.chats.size - visibleChats.size
    val disclosureState = stringResource(if (expanded) R.string.state_expanded else R.string.state_collapsed)
    Column(Modifier.fillMaxWidth()) {
        Surface(
            onClick = onToggle,
            color = Color.Transparent,
            shape = MaterialTheme.shapes.large,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 1.dp)
                .testTag("workspace_disclosure_${section.workspace.id}")
                .semantics {
                    stateDescription = disclosureState
                }
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 10.dp)
            ) {
                Icon(
                    Icons.Outlined.KeyboardArrowDown,
                    contentDescription = null,
                    tint = palette.secondary,
                    modifier = Modifier
                        .size(18.dp)
                        .graphicsLayer { rotationZ = chevronRotation }
                )
                Spacer(Modifier.width(4.dp))
                Icon(
                    Icons.Outlined.FolderOpen,
                    contentDescription = null,
                    tint = palette.accent,
                    modifier = Modifier.size(21.dp)
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    section.workspace.name,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (section.chats.isNotEmpty()) {
                    Spacer(Modifier.width(8.dp))
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceContainerHigh,
                        shape = CircleShape
                    ) {
                        Text(
                            section.chats.size.toString(),
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = palette.secondary,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                        )
                    }
                }
            }
        }

        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(AidenMotion.spatial(reduceMotion)) + fadeIn(AidenMotion.nonSpatial(reduceMotion)),
            exit = shrinkVertically(AidenMotion.spatial(reduceMotion)) + fadeOut(AidenMotion.nonSpatial(reduceMotion))
        ) {
            Column(Modifier.fillMaxWidth()) {
                visibleChats.forEach { chat ->
                    key(chat.id) {
                        AidenWorkspaceChatRow(
                            chat = chat,
                            workspaceName = section.workspace.name,
                            showsWorkspaceName = false,
                            indented = true,
                            onClick = { onNavigateToChat(chat.id) }
                        )
                    }
                }
                if (section.chats.isEmpty()) {
                    Surface(
                        onClick = onCreateChat,
                        enabled = canCreateChat,
                        color = Color.Transparent,
                        shape = MaterialTheme.shapes.large,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 44.dp, end = 14.dp, top = 1.dp, bottom = 1.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 11.dp)
                        ) {
                            Icon(
                                Icons.Outlined.AddComment,
                                contentDescription = null,
                                tint = palette.secondary,
                                modifier = Modifier.size(19.dp)
                            )
                            Spacer(Modifier.width(10.dp))
                            Text(
                                stringResource(R.string.workspace_home_new_chat),
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.secondary
                            )
                        }
                    }
                }
                if (remainingChatCount > 0) {
                    Surface(
                        onClick = onRevealAllChats,
                        color = Color.Transparent,
                        shape = MaterialTheme.shapes.large,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 44.dp, end = 14.dp, top = 1.dp, bottom = 1.dp)
                    ) {
                        Text(
                            pluralStringResource(R.plurals.workspace_home_show_more, remainingChatCount, remainingChatCount),
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.secondary,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 11.dp)
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun AidenWorkspaceChatRow(
    chat: AidenChatSummary,
    workspaceName: String,
    showsWorkspaceName: Boolean,
    indented: Boolean,
    onClick: () -> Unit
) {
    val palette = AidenTheme.palette
    Surface(
        onClick = onClick,
        color = Color.Transparent,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier
            .fillMaxWidth()
            .padding(
                start = if (indented) 42.dp else 14.dp,
                end = 14.dp,
                top = 1.dp,
                bottom = 1.dp
            )
    ) {
        Row(
            verticalAlignment = Alignment.Top,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 12.dp)
        ) {
            if (chat.forkedFrom != null) {
                Icon(
                    Icons.AutoMirrored.Filled.CallSplit,
                    contentDescription = stringResource(R.string.workspace_home_forked_chat_cd),
                    tint = palette.secondary,
                    modifier = Modifier.padding(top = 3.dp, end = 6.dp).size(16.dp)
                )
            }
            Column(Modifier.weight(1f)) {
                Text(
                    chat.title.ifBlank { stringResource(R.string.workspace_new_chat) },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium,
                    color = palette.foreground,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                if (showsWorkspaceName) {
                    Spacer(Modifier.height(3.dp))
                    Text(
                        workspaceName,
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            Spacer(Modifier.width(12.dp))
            AidenChatRowStatus(state = chat.displayRowState, unread = chat.unread, palette = palette)
            Spacer(Modifier.width(8.dp))
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
    Surface(onClick = onClick, enabled = enabled, color = Color.Transparent, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
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
    val reduceMotion = aidenReduceMotion()
    var focused by remember { mutableStateOf(false) }
    val fieldColor by animateColorAsState(
        targetValue = if (focused) MaterialTheme.colorScheme.surfaceContainer else MaterialTheme.colorScheme.surfaceContainerLow,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "WorkspaceNameFieldFill"
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.workspace_menu_new)) },
        text = {
            Surface(color = fieldColor, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().height(54.dp)) {
                BasicTextField(
                    value = name,
                    onValueChange = onNameChanged,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = palette.foreground),
                    cursorBrush = SolidColor(palette.accent),
                    modifier = Modifier
                        .padding(horizontal = 16.dp, vertical = 16.dp)
                        .onFocusChanged { focused = it.isFocused }
                )
            }
        },
        confirmButton = { AidenDialogConfirmButton(text = stringResource(R.string.action_create), onClick = onCreate, enabled = name.trim().isNotEmpty()) },
        dismissButton = { AidenDialogDismissButton(onClick = onDismiss) },
        shape = AidenShape.Dialog,
        containerColor = palette.raised
    )
}
