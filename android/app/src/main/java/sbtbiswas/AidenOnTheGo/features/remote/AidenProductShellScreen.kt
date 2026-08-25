package sbtbiswas.AidenOnTheGo.features.remote

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.viewmodel.compose.viewModel
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotsHomeScreen
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotsViewModel
import sbtbiswas.AidenOnTheGo.features.settings.AidenAppearanceSettingsScreen
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceShellScreen
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceHomeViewModel
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenProductArea
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenToolbarAction
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenProductShellScreen(
    coordinator: AidenRemoteCoordinator,
    navigationStore: AidenProductNavigationStore,
    installationStore: AidenInstallationStore,
    chatCache: AidenChatCache,
    appearanceStore: AidenAppearanceStore? = null,
    voiceInputStore: AidenVoiceInputStore,
    onNavigateToChat: (String) -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    onNavigateToBotEditor: (String?) -> Unit,
    onNavigateToWorkspaceFiles: (String) -> Unit,
    onNavigateToWorkspaceGit: (String) -> Unit
) {
    val activeArea by navigationStore.activeArea.collectAsState()
    val activeInstallationId by installationStore.activeInstallationId.collectAsState()
    val installations by installationStore.installations.collectAsState()
    val connectionState by coordinator.connectionState.collectAsState()
    val palette = AidenTheme.palette
    val botsViewModel: AidenBotsViewModel = viewModel(
        factory = AidenBotsViewModel.factory(coordinator)
    )
    val workspaceHomeViewModel: AidenWorkspaceHomeViewModel = viewModel(
        factory = AidenWorkspaceHomeViewModel.factory(coordinator, chatCache)
    )

    var showPairingDialog by remember { mutableStateOf(false) }
    var showSettingsSheet by remember { mutableStateOf(false) }
    val activeInstallation = installations.firstOrNull { it.id == activeInstallationId }
    val selectArea: (AidenProductArea) -> Unit = { area ->
        val instanceId = activeInstallationId
        if (instanceId != null) navigationStore.setSelectedArea(instanceId, area)
        else navigationStore.switchArea(area)
    }
    LaunchedEffect(activeInstallationId, activeInstallation?.isBotsEligible) {
        val instanceId = activeInstallationId ?: return@LaunchedEffect
        navigationStore.activateSelectedArea(instanceId, activeInstallation?.isBotsEligible == true)
    }
    val connectionLabel = when (connectionState) {
        AidenConnectionState.CONNECTED -> "Connected"
        AidenConnectionState.CONNECTING -> "Connecting"
        AidenConnectionState.OFFLINE -> "Offline"
        AidenConnectionState.NEEDS_PAIRING -> "Needs pairing"
    }

    Scaffold(
        topBar = {
            if (activeArea == AidenProductArea.BOTS) TopAppBar(
                navigationIcon = {
                    AidenProductSwitcher(
                        activeArea = activeArea,
                        botsAvailable = activeInstallation?.isBotsEligible == true,
                        onAreaSelected = selectArea
                    )
                },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = if (activeArea == AidenProductArea.BOTS) "Bots" else "Workspaces",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Medium,
                            color = palette.foreground
                        )
                        Spacer(modifier = Modifier.width(9.dp))
                        Box(
                            modifier = Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(
                                    when (connectionState) {
                                        AidenConnectionState.CONNECTED -> palette.success
                                        AidenConnectionState.CONNECTING -> palette.accent
                                        else -> palette.warning
                                    }
                                )
                                .semantics { contentDescription = connectionLabel }
                        )
                    }
                },
                actions = {
                    if (activeArea == AidenProductArea.BOTS) {
                        AidenToolbarAction(
                            icon = Icons.Outlined.Add,
                            contentDescription = "New Bot",
                            onClick = { onNavigateToBotEditor(null) }
                        )
                        Spacer(Modifier.width(2.dp))
                    }
                    AidenToolbarAction(
                        icon = Icons.Outlined.Devices,
                        contentDescription = "Installations",
                        onClick = { showPairingDialog = true }
                    )
                    Spacer(Modifier.width(2.dp))
                    AidenToolbarAction(
                        icon = Icons.Outlined.Settings,
                        contentDescription = "Settings",
                        onClick = { showSettingsSheet = true }
                    )
                    Spacer(Modifier.width(6.dp))
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = palette.canvas,
                    titleContentColor = palette.foreground
                )
            )
        },
        containerColor = palette.canvas
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            val duration = if (AidenTheme.config.reduceMotion) 0 else 180
            val botsAlpha by animateFloatAsState(
                targetValue = if (activeArea == AidenProductArea.BOTS) 1f else 0f,
                animationSpec = tween(duration),
                label = "BotsAreaAlpha"
            )
            val workspacesAlpha by animateFloatAsState(
                targetValue = if (activeArea == AidenProductArea.WORKSPACES) 1f else 0f,
                animationSpec = tween(duration),
                label = "WorkspacesAreaAlpha"
            )

            AidenWorkspaceShellScreen(
                coordinator = coordinator,
                viewModel = workspaceHomeViewModel,
                onNavigateToChat = onNavigateToChat,
                onNavigateToFiles = onNavigateToWorkspaceFiles,
                onNavigateToGit = onNavigateToWorkspaceGit,
                productSwitcher = {
                    AidenProductSwitcher(activeArea, activeInstallation?.isBotsEligible == true, selectArea)
                },
                onOpenSettings = { showSettingsSheet = true },
                modifier = Modifier
                    .fillMaxSize()
                    .alpha(workspacesAlpha)
                    .zIndex(if (activeArea == AidenProductArea.WORKSPACES) 1f else 0f)
                    .semantics { if (activeArea != AidenProductArea.WORKSPACES) hideFromAccessibility() }
            )

            AidenBotsHomeScreen(
                coordinator = coordinator,
                viewModel = botsViewModel,
                onNavigateToChat = onNavigateToChat,
                onNavigateToBotProfile = onNavigateToBotProfile,
                onNavigateToCreateBot = { onNavigateToBotEditor(null) },
                modifier = Modifier
                    .fillMaxSize()
                    .alpha(botsAlpha)
                    .zIndex(if (activeArea == AidenProductArea.BOTS) 1f else 0f)
                    .semantics { if (activeArea != AidenProductArea.BOTS) hideFromAccessibility() }
            )
        }
    }

    // Settings sheet
    if (showSettingsSheet) {
        ModalBottomSheet(
            onDismissRequest = { showSettingsSheet = false },
            containerColor = palette.raised,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            AidenAppearanceSettingsScreen(
                appearanceStore = appearanceStore,
                voiceInputStore = voiceInputStore,
                remoteClient = coordinator.client.collectAsState().value,
                onOpenInstallations = {
                    showSettingsSheet = false
                    showPairingDialog = true
                }
            )
        }
    }

    // Pairing sheet
    if (showPairingDialog) {
        ModalBottomSheet(
            onDismissRequest = { showPairingDialog = false },
            containerColor = palette.raised,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            AidenPairingScreen(
                coordinator = coordinator,
                installationStore = installationStore,
                onDismiss = { showPairingDialog = false }
            )
        }
    }
}

@Composable
fun AidenProductSwitcher(
    activeArea: AidenProductArea,
    botsAvailable: Boolean = true,
    onAreaSelected: (AidenProductArea) -> Unit
) {
    val palette = AidenTheme.palette
    var expanded by remember { mutableStateOf(false) }

    Box {
        Surface(
            onClick = { expanded = true },
            color = androidx.compose.ui.graphics.Color.Transparent,
            shape = RoundedCornerShape(24.dp),
            modifier = Modifier
                .height(48.dp)
                .width(58.dp)
                .semantics {
                    contentDescription = "Aiden. Current area: ${activeArea.displayTitle}. Choose Bots or Workspaces."
                }
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
                modifier = Modifier.padding(start = 7.dp, end = 5.dp)
            ) {
                androidx.compose.foundation.Image(
                    painter = painterResource(R.drawable.aiden_app_icon),
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.size(28.dp)
                )
                Spacer(Modifier.width(3.dp))
                Icon(
                    imageVector = Icons.Outlined.KeyboardArrowDown,
                    contentDescription = null,
                    tint = palette.secondary,
                    modifier = Modifier.size(14.dp)
                )
            }
        }

        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            shape = RoundedCornerShape(18.dp),
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow
        ) {
            AidenProductArea.entries.forEach { area ->
                DropdownMenuItem(
                    text = { Text(area.displayTitle) },
                    trailingIcon = {
                        if (area == activeArea) {
                            Icon(Icons.Outlined.Check, contentDescription = "Selected", tint = palette.accent)
                        }
                    },
                    onClick = {
                        expanded = false
                        onAreaSelected(area)
                    },
                    enabled = area != AidenProductArea.BOTS || botsAvailable,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
                )
            }
        }
    }
}

private val AidenProductArea.displayTitle: String
    get() = if (this == AidenProductArea.BOTS) "Bots" else "Workspaces"
