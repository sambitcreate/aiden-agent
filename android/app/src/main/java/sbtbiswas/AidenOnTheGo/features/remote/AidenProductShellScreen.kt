package sbtbiswas.AidenOnTheGo.features.remote

import androidx.compose.animation.*
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layoutId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.util.lerp
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotsHomeScreen
import sbtbiswas.AidenOnTheGo.features.settings.AidenAppearanceSettingsScreen
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceShellScreen
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenProductArea
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.hairlineBorder
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

enum class ShellNavTab(
    val area: AidenProductArea,
    val title: String,
    val activeIcon: ImageVector,
    val inactiveIcon: ImageVector
) {
    BOTS(AidenProductArea.BOTS, "Bots", Icons.Filled.SmartToy, Icons.Outlined.SmartToy),
    WORKSPACES(AidenProductArea.WORKSPACES, "Workspaces", Icons.Filled.Folder, Icons.Outlined.Folder)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenProductShellScreen(
    coordinator: AidenRemoteCoordinator,
    navigationStore: AidenProductNavigationStore,
    installationStore: AidenInstallationStore,
    appearanceStore: AidenAppearanceStore? = null,
    onNavigateToChat: (String) -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    onNavigateToBotEditor: (String?) -> Unit,
    onNavigateToWorkspaceFiles: (String) -> Unit,
    onNavigateToWorkspaceGit: (String) -> Unit
) {
    val activeArea by navigationStore.activeArea.collectAsState()
    val connectionState by coordinator.connectionState.collectAsState()
    val palette = AidenTheme.palette

    var showPairingDialog by remember { mutableStateOf(false) }
    var showSettingsSheet by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = if (activeArea == AidenProductArea.BOTS) "Aiden Bots" else "Workspaces",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                            color = palette.foreground
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        // Connection Dot / Status
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(
                                    when (connectionState) {
                                        AidenConnectionState.CONNECTED -> palette.success
                                        AidenConnectionState.CONNECTING -> palette.accent
                                        else -> palette.warning
                                    }
                                )
                        )
                    }
                },
                actions = {
                    IconButton(
                        onClick = { showPairingDialog = true },
                        modifier = Modifier.tactilePress { showPairingDialog = true }
                    ) {
                        Icon(
                            imageVector = Icons.Default.Devices,
                            contentDescription = "Installations",
                            tint = palette.foreground
                        )
                    }
                    IconButton(
                        onClick = { showSettingsSheet = true },
                        modifier = Modifier.tactilePress { showSettingsSheet = true }
                    ) {
                        Icon(
                            imageVector = Icons.Default.Settings,
                            contentDescription = "Settings",
                            tint = palette.foreground
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = palette.canvas,
                    titleContentColor = palette.foreground
                )
            )
        },
        bottomBar = {
            // Floating Island Navigation Pill
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(horizontal = 24.dp, vertical = 10.dp),
                contentAlignment = Alignment.Center
            ) {
                AidenFloatingNavBar(
                    activeArea = activeArea,
                    onTabSelected = { area -> navigationStore.switchArea(area) }
                )
            }
        },
        containerColor = palette.canvas
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            AnimatedContent(
                targetState = activeArea,
                label = "ProductAreaSwitch",
                transitionSpec = {
                    (slideInHorizontally(
                        initialOffsetX = { if (targetState == AidenProductArea.WORKSPACES) it else -it },
                        animationSpec = AidenMotion.spatialExpressiveSpring<IntOffset>()
                    ) + fadeIn(AidenMotion.nonSpatialExpressiveSpring<Float>())).togetherWith(
                        slideOutHorizontally(
                            targetOffsetX = { if (targetState == AidenProductArea.WORKSPACES) -it else it },
                            animationSpec = AidenMotion.spatialExpressiveSpring<IntOffset>()
                        ) + fadeOut(AidenMotion.nonSpatialExpressiveSpring<Float>())
                    )
                }
            ) { area ->
                when (area) {
                    AidenProductArea.BOTS -> {
                        AidenBotsHomeScreen(
                            coordinator = coordinator,
                            onNavigateToChat = onNavigateToChat,
                            onNavigateToBotProfile = onNavigateToBotProfile,
                            onNavigateToCreateBot = { onNavigateToBotEditor(null) }
                        )
                    }
                    AidenProductArea.WORKSPACES -> {
                        AidenWorkspaceShellScreen(
                            coordinator = coordinator,
                            onNavigateToChat = onNavigateToChat,
                            onNavigateToFiles = onNavigateToWorkspaceFiles,
                            onNavigateToGit = onNavigateToWorkspaceGit
                        )
                    }
                }
            }
        }
    }

    // Settings sheet
    if (showSettingsSheet) {
        ModalBottomSheet(
            onDismissRequest = { showSettingsSheet = false },
            containerColor = palette.raised,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
        ) {
            AidenAppearanceSettingsScreen(appearanceStore = appearanceStore)
        }
    }

    // Pairing sheet
    if (showPairingDialog) {
        ModalBottomSheet(
            onDismissRequest = { showPairingDialog = false },
            containerColor = palette.raised,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
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
private fun AidenFloatingNavBar(
    activeArea: AidenProductArea,
    onTabSelected: (AidenProductArea) -> Unit
) {
    val palette = AidenTheme.palette
    val tabs = remember { ShellNavTab.entries.toTypedArray() }
    val selectedIndex = tabs.indexOfFirst { it.area == activeArea }.coerceAtLeast(0)
    val springSpec = AidenMotion.spatialExpressiveSpring<Float>()

    Surface(
        shape = RoundedCornerShape(32.dp),
        color = palette.raised,
        border = BorderStroke(1.dp, palette.secondary.copy(alpha = 0.15f)),
        modifier = Modifier
            .shadow(elevation = 12.dp, shape = RoundedCornerShape(32.dp))
            .padding(4.dp)
    ) {
        AidenNavLayout(
            selectedIndex = selectedIndex,
            itemCount = tabs.size,
            animSpec = springSpec,
            indicator = {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(2.dp)
                        .clip(RoundedCornerShape(26.dp))
                        .background(palette.accent)
                )
            }
        ) {
            tabs.forEachIndexed { index, tab ->
                val isSelected = index == selectedIndex
                val progress by animateFloatAsState(
                    targetValue = if (isSelected) 1f else 0f,
                    animationSpec = springSpec,
                    label = "tab_progress"
                )

                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(26.dp))
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            onClick = { onTabSelected(tab.area) }
                        )
                        .padding(horizontal = 20.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center
                ) {
                    Icon(
                        imageVector = if (isSelected) tab.activeIcon else tab.inactiveIcon,
                        contentDescription = tab.title,
                        tint = if (isSelected) Color.White else palette.secondary,
                        modifier = Modifier.size(20.dp)
                    )
                    if (progress > 0.05f) {
                        Spacer(modifier = Modifier.width(8.dp * progress))
                        Text(
                            text = tab.title,
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.Bold,
                            color = Color.White,
                            modifier = Modifier.graphicsLayer {
                                alpha = progress
                                scaleX = progress
                                scaleY = progress
                            }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun AidenNavLayout(
    selectedIndex: Int,
    itemCount: Int,
    animSpec: androidx.compose.animation.core.AnimationSpec<Float>,
    indicator: @Composable BoxScope.() -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    val indicatorIndex = remember { Animatable(selectedIndex.toFloat()) }
    LaunchedEffect(selectedIndex) {
        indicatorIndex.animateTo(selectedIndex.toFloat(), animSpec)
    }

    Layout(
        modifier = modifier.height(44.dp),
        content = {
            content()
            Box(Modifier.layoutId("indicator"), content = indicator)
        }
    ) { measurables, constraints ->
        val indicatorMeasurable = measurables.first { it.layoutId == "indicator" }
        val itemMeasurables = measurables.filterNot { it == indicatorMeasurable }

        val itemPlaceables = itemMeasurables.map { it.measure(constraints.copy(minWidth = 0)) }
        val totalWidth = itemPlaceables.sumOf { it.width }
        val indicatorPlaceable = indicatorMeasurable.measure(
            constraints.copy(
                minWidth = itemPlaceables[selectedIndex].width,
                maxWidth = itemPlaceables[selectedIndex].width,
                minHeight = constraints.maxHeight,
                maxHeight = constraints.maxHeight
            )
        )

        layout(totalWidth, constraints.maxHeight) {
            var currentX = 0
            val xPositions = itemPlaceables.map { placeable ->
                val x = currentX
                currentX += placeable.width
                x
            }

            val curIndex = indicatorIndex.value.toInt().coerceIn(0, itemCount - 1)
            val nextIndex = (curIndex + 1).coerceIn(0, itemCount - 1)
            val fraction = indicatorIndex.value - curIndex
            val indicatorX = lerp(xPositions[curIndex].toFloat(), xPositions[nextIndex].toFloat(), fraction).toInt()

            indicatorPlaceable.placeRelative(indicatorX, 0)
            itemPlaceables.forEachIndexed { index, placeable ->
                placeable.placeRelative(xPositions[index], 0)
            }
        }
    }
}
