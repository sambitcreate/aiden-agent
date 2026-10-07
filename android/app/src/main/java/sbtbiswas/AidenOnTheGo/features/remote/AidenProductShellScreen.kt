package sbtbiswas.AidenOnTheGo.features.remote

import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.focus.focusProperties
import androidx.compose.foundation.focusGroup
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.LayoutDirection
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
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.math.abs

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenProductShellScreen(
    coordinator: AidenRemoteCoordinator,
    navigationStore: AidenProductNavigationStore,
    installationStore: AidenInstallationStore,
    chatCache: AidenChatCache,
    appearanceStore: AidenAppearanceStore? = null,
    voiceInputStore: AidenVoiceInputStore,
    botsViewModel: AidenBotsViewModel,
    onNavigateToChat: (String) -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    onNavigateToBotChat: (String) -> Unit = {},
    onNavigateToBotEditor: (String?) -> Unit,
    onNavigateToWorkspaceFiles: (String) -> Unit,
    onNavigateToWorkspaceGit: (String) -> Unit
) {
    val activeArea by navigationStore.activeArea.collectAsStateWithLifecycle()
    val activeInstallationId by installationStore.activeInstallationId.collectAsStateWithLifecycle()
    val installations by installationStore.installations.collectAsStateWithLifecycle()
    val connectionState by coordinator.connectionState.collectAsStateWithLifecycle()
    val palette = AidenTheme.palette
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
    val botsAvailable = activeInstallation?.isBotsEligible == true
    val reduceMotion = aidenReduceMotion()
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val areaPosition = animateFloatAsState(
        targetValue = activeArea.ordinal.toFloat(),
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "ProductAreaPosition"
    )

    Scaffold(containerColor = palette.canvas) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            AidenWorkspaceShellScreen(
                coordinator = coordinator,
                viewModel = workspaceHomeViewModel,
                navigationStore = navigationStore,
                onNavigateToChat = onNavigateToChat,
                onNavigateToFiles = onNavigateToWorkspaceFiles,
                onNavigateToGit = onNavigateToWorkspaceGit,
                productSwitcher = {
                    AidenProductSwitcher(activeArea, botsAvailable, selectArea)
                },
                onOpenSettings = { showSettingsSheet = true },
                isActive = activeArea == AidenProductArea.WORKSPACES,
                modifier = Modifier
                    .fillMaxSize()
                    .productAreaLayer(AidenProductArea.WORKSPACES, rtl) { areaPosition.value }
                    .zIndex(if (activeArea == AidenProductArea.WORKSPACES) 1f else 0f)
                    .inactiveAreaGuard(activeArea == AidenProductArea.WORKSPACES)
                    .semantics { if (activeArea != AidenProductArea.WORKSPACES) hideFromAccessibility() }
            )

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .productAreaLayer(AidenProductArea.BOTS, rtl) { areaPosition.value }
                    .zIndex(if (activeArea == AidenProductArea.BOTS) 1f else 0f)
                    .inactiveAreaGuard(activeArea == AidenProductArea.BOTS)
                    .semantics { if (activeArea != AidenProductArea.BOTS) hideFromAccessibility() }
            ) {
                AidenProductTopBar(
                    title = "Bots",
                    connectionState = connectionState,
                    productSwitcher = {
                        AidenProductSwitcher(
                            activeArea = activeArea,
                            botsAvailable = botsAvailable,
                            onAreaSelected = selectArea
                        )
                    },
                    modifier = Modifier.background(palette.canvas),
                    primaryAction = {
                        AidenProductTopBarPrimaryAction(
                            icon = Icons.Outlined.Add,
                            contentDescription = "New Bot",
                            onClick = { onNavigateToBotEditor(null) }
                        )
                    }
                ) {
                    AidenProductTopBarAction(
                        icon = Icons.Outlined.Devices,
                        contentDescription = "Installations",
                        onClick = { showPairingDialog = true }
                    )
                    AidenProductTopBarAction(
                        icon = Icons.Outlined.Settings,
                        contentDescription = "Settings",
                        onClick = { showSettingsSheet = true }
                    )
                }
                Box(
                    Modifier
                        .fillMaxWidth()
                        .weight(1f)
                ) {
                    AidenBotsHomeScreen(
                        coordinator = coordinator,
                        viewModel = botsViewModel,
                        onNavigateToChat = onNavigateToChat,
                        onNavigateToBotProfile = onNavigateToBotProfile,
                        onNavigateToBotChat = onNavigateToBotChat,
                        botDeleter = sbtbiswas.AidenOnTheGo.features.bots.AidenRemoteBotDeleter,
                        onNavigateToCreateBot = { onNavigateToBotEditor(null) },
                        modifier = Modifier.fillMaxSize()
                    )
                }
            }
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
                remoteClient = coordinator.client.collectAsStateWithLifecycle().value,
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
    val reduceMotion = aidenReduceMotion()
    var expanded by remember { mutableStateOf(false) }
    val chevronRotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "ProductSwitcherChevron"
    )
    val interaction = remember { MutableInteractionSource() }

    Box {
        Surface(
            onClick = { expanded = true },
            color = androidx.compose.ui.graphics.Color.Transparent,
            shape = RoundedCornerShape(24.dp),
            interactionSource = interaction,
            modifier = Modifier
                .height(48.dp)
                .width(58.dp)
                .tactilePress(interaction)
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
                    modifier = Modifier
                        .size(14.dp)
                        .graphicsLayer { rotationZ = chevronRotation }
                )
            }
        }

        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            shape = AidenShape.Snackbar,
            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest
        ) {
            AidenProductArea.entries.forEach { area ->
                DropdownMenuItem(
                    text = { Text(area.displayTitle) },
                    leadingIcon = {
                        Icon(
                            imageVector = if (area == AidenProductArea.BOTS) Icons.Outlined.SmartToy else Icons.Outlined.FolderOpen,
                            contentDescription = null,
                            tint = if (area == activeArea) palette.accent else palette.secondary
                        )
                    },
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

/** Horizontal travel of an entering or leaving area, as a fraction of the shell width. */
private const val AidenProductAreaSlideFraction = 0.2f

internal data class AidenProductAreaLayerTransform(val offsetFraction: Float, val alpha: Float)

/**
 * Placement of the layer for the area at [areaIndex] while the shell's animated area
 * [position] travels between area indices. Areas after the active one wait on the trailing
 * side and earlier ones on the leading side, so the switch slides in area order.
 */
internal fun aidenProductAreaLayerTransform(areaIndex: Int, position: Float): AidenProductAreaLayerTransform {
    val distance = (areaIndex - position).coerceIn(-1f, 1f)
    return AidenProductAreaLayerTransform(
        offsetFraction = distance * AidenProductAreaSlideFraction,
        alpha = 1f - abs(distance)
    )
}

/**
 * The inactive area stays composed for the directional switch but must not take taps,
 * keyboard focus, or D-pad traversal; alpha alone does not stop hit testing.
 */
internal fun Modifier.inactiveAreaGuard(active: Boolean): Modifier =
    if (active) {
        this
    } else {
        this
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                    }
                }
            }
            .focusProperties { onEnter = { cancelFocusChange() } }
            .focusGroup()
    }

private fun Modifier.productAreaLayer(
    area: AidenProductArea,
    rtl: Boolean,
    position: () -> Float
): Modifier = graphicsLayer {
    val transform = aidenProductAreaLayerTransform(area.ordinal, position())
    translationX = transform.offsetFraction * size.width * (if (rtl) -1f else 1f)
    alpha = transform.alpha
}
