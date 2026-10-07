package sbtbiswas.AidenOnTheGo.features.remote

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenPairingScreen(
    coordinator: AidenRemoteCoordinator,
    installationStore: AidenInstallationStore,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val installations by installationStore.installations.collectAsStateWithLifecycle()
    val activeId by installationStore.activeInstallationId.collectAsStateWithLifecycle()

    var manualCode by remember { mutableStateOf("") }
    var endpointUrl by remember { mutableStateOf("") }
    var qrJsonInput by remember { mutableStateOf("") }
    var selectedTab by remember { mutableIntStateOf(0) } // 0: Scan QR, 1: Setup Code, 2: Paste JSON
    var discoveryRefresh by remember { mutableIntStateOf(0) }
    val (nearbyDesktops, discoveryError) = rememberNearbyDesktops(selectedTab == 1, discoveryRefresh)
    var isPairing by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var installationPendingRemoval by remember { mutableStateOf<AidenInstallation?>(null) }

    fun formatCrockfordCode(input: String): String {
        val clean = input.uppercase().replace("-", "").filter { it in "0123456789ABCDEFGHJKMNPQRSTVWXYZIL" }.take(20)
        val chunks = clean.chunked(4)
        return chunks.joinToString("-")
    }

    fun handleScannedQRCode(scannedText: String) {
        scope.launch {
            isPairing = true
            errorMessage = null
            try {
                val json = Json { ignoreUnknownKeys = true }
                val payload = json.decodeFromString<AidenPairingPayload>(scannedText.trim())
                coordinator.pairWithQRCode(payload)
                onDismiss()
            } catch (e: Exception) {
                errorMessage = e.message ?: "Invalid QR Code payload format"
            } finally {
                isPairing = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Paired desktops", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = palette.foreground)
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
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
        ) {
            // Paired Macs List
            if (installations.isNotEmpty()) {
                Text(
                    text = "Active Installations",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = palette.secondary
                )
                Spacer(modifier = Modifier.height(8.dp))

                AidenConnectedColumn {
                    installations.forEachIndexed { index, install ->
                        val isActive = install.id == activeId
                        AidenGroupCard(
                            index = index,
                            count = installations.size,
                            selected = isActive,
                            onClick = {
                                installationStore.setActiveInstallation(install.id)
                                coordinator.refreshClient()
                            },
                            contentPadding = PaddingValues(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 10.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Laptop,
                                contentDescription = null,
                                tint = if (isActive) palette.accent else palette.secondary
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        text = install.name,
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.SemiBold,
                                        color = palette.foreground
                                    )
                                    if (isActive) {
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Surface(
                                            color = palette.accent.copy(alpha = 0.14f),
                                            shape = RoundedCornerShape(6.dp)
                                        ) {
                                            Text(
                                                text = "ACTIVE",
                                                style = MaterialTheme.typography.labelSmall,
                                                fontSize = 9.sp,
                                                fontWeight = FontWeight.SemiBold,
                                                color = palette.accent,
                                                modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp)
                                            )
                                        }
                                    }
                                }
                                Spacer(modifier = Modifier.height(2.dp))
                                Text(
                                    text = install.endpoint,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = palette.secondary
                                )
                            }
                            IconButton(
                                onClick = { installationPendingRemoval = install }
                            ) {
                                Icon(
                                    Icons.Default.DeleteOutline,
                                    contentDescription = "Remove ${install.name}",
                                    tint = palette.danger
                                )
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(24.dp))
            }

            // Pair New Mac Section
            Text(
                text = "Connect your desktop",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = palette.secondary
            )
            Spacer(modifier = Modifier.height(8.dp))

            Text(
                text = "On your desktop, open Settings → Aiden On The Go → Connect a device. Then scan its code here, or use the setup code with a nearby desktop or private Tailscale address.",
                style = MaterialTheme.typography.bodyMedium,
                color = palette.secondary
            )
            Spacer(modifier = Modifier.height(12.dp))

            // QR first, with a camera-free setup code fallback.
            AidenPairingModeTabs(selectedTab = selectedTab, onSelectTab = { selectedTab = it })

            Spacer(modifier = Modifier.height(16.dp))

            TextButton(onClick = { selectedTab = if (selectedTab == 2) 0 else 2 }, shape = AidenShape.Button) {
                Text(if (selectedTab == 2) "Back to scanning" else "Advanced: paste connection details")
            }

            errorMessage?.let { msg ->
                Surface(
                    color = palette.danger.copy(alpha = 0.12f),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = msg,
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.danger,
                        modifier = Modifier.padding(12.dp)
                    )
                }
                Spacer(modifier = Modifier.height(12.dp))
            }

            when (selectedTab) {
                0 -> {
                    // Live Camera QR Code Scanner
                    AidenQRCodeScanner(
                        onCodeScanned = { scanned ->
                            handleScannedQRCode(scanned)
                        }
                    )
                    if (isPairing) {
                        Spacer(modifier = Modifier.height(12.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            CircularProgressIndicator(color = palette.accent, modifier = Modifier.size(20.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Pairing with desktop...", style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
                        }
                    }
                }
                1 -> {
                    Text("Nearby desktops", style = MaterialTheme.typography.titleSmall)
                    Text(discoveryError ?: if (nearbyDesktops.isEmpty()) "Searching your local network. Keep Aiden open and enable device connections on your desktop. You can also enter its address below." else "Choose your desktop, then enter the setup code shown there.",
                        style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                    nearbyDesktops.forEach { desktop ->
                        TextButton(onClick = { endpointUrl = desktop.endpoint }, shape = AidenShape.Button) { Text(desktop.name) }
                    }
                    TextButton(onClick = { discoveryRefresh++ }, shape = AidenShape.Button) { Text("Search again") }
                    Spacer(modifier = Modifier.height(12.dp))
                    // Manual 20-character Crockford code
                    TextField(
                        colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                        value = manualCode,
                        onValueChange = { manualCode = formatCrockfordCode(it) },
                        label = { Text("20-Character Setup Code") },
                        placeholder = { Text("0123-4567-89AB-CDEF-GHJK") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace, letterSpacing = 2.sp),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    TextField(

                        colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                        value = endpointUrl,
                        onValueChange = { endpointUrl = it },
                        label = { Text("Desktop address") },
                        placeholder = { Text("https://your-desktop.local:8765/api/aiden/v1") },
                        singleLine = true,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    AidenPairingActionButton(
                        text = "Connect & Pair",
                        busy = isPairing,
                        enabled = manualCode.replace("-", "").length == 20 && endpointUrl.isNotBlank() && !isPairing,
                        onClick = {
                            scope.launch {
                                isPairing = true
                                errorMessage = null
                                try {
                                    coordinator.pairWithManualCode(manualCode, endpointUrl)
                                    onDismiss()
                                } catch (e: Exception) {
                                    errorMessage = e.message ?: "Failed to pair with setup code"
                                } finally {
                                    isPairing = false
                                }
                            }
                        }
                    )
                }
                2 -> {
                    // QR Payload JSON Input Fallback
                    TextField(
                        colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                        value = qrJsonInput,
                        onValueChange = { qrJsonInput = it },
                        label = { Text("QR Code Payload JSON") },
                        placeholder = { Text("Paste QR code JSON string from Aiden Agent") },
                        minLines = 4,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    AidenPairingActionButton(
                        text = "Import & Pair",
                        busy = isPairing,
                        enabled = qrJsonInput.trim().isNotEmpty() && !isPairing,
                        onClick = { handleScannedQRCode(qrJsonInput) }
                    )
                }
            }
        }
    }

    installationPendingRemoval?.let { installation ->
        AlertDialog(
            onDismissRequest = { installationPendingRemoval = null },
            title = { Text("Remove ${installation.name}?") },
            text = {
                Text("This removes the pairing credential and all cached chats, Bots, usage, drafts, and workspace data for this desktop from this device.")
            },
            confirmButton = {
                AidenDialogConfirmButton(
                    text = "Remove",
                    destructive = true,
                    onClick = {
                        coordinator.removeInstallation(installation.id)
                        installationPendingRemoval = null
                    }
                )
            },
            dismissButton = {
                AidenDialogDismissButton(onClick = { installationPendingRemoval = null })
            },
            shape = AidenShape.Dialog,
            containerColor = palette.raised,
            titleContentColor = palette.foreground,
            textContentColor = palette.secondary
        )
    }
}

internal val AidenPairingTabTitles = listOf("Scan QR", "Setup Code")

/** Tab the sliding indicator rests under, or null when the advanced paste flow is open. */
internal fun aidenPairingIndicatorTab(selectedTab: Int): Int? =
    selectedTab.takeIf { it in AidenPairingTabTitles.indices }

/**
 * Segmented pairing-mode tabs. A single accent indicator springs between tabs (snapping
 * when motion is reduced) and fades out while the advanced paste flow is open.
 */
@Composable
internal fun AidenPairingModeTabs(
    selectedTab: Int,
    onSelectTab: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val density = LocalDensity.current
    var trackWidthPx by remember { mutableIntStateOf(0) }
    val indicatorTab = aidenPairingIndicatorTab(selectedTab)
    val tabWidth = with(density) { (trackWidthPx / AidenPairingTabTitles.size).toDp() }
    val indicatorOffset by animateDpAsState(
        targetValue = tabWidth * (indicatorTab ?: 0),
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "pairing_tab_indicator"
    )
    val indicatorAlpha by animateFloatAsState(
        targetValue = if (indicatorTab != null) 1f else 0f,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "pairing_tab_indicator_alpha"
    )
    val tabShape = RoundedCornerShape(16.dp)
    Surface(
        color = palette.raised,
        shape = RoundedCornerShape(20.dp),
        modifier = modifier.fillMaxWidth()
    ) {
        Box(
            modifier = Modifier
                .padding(4.dp)
                .onSizeChanged { trackWidthPx = it.width }
        ) {
            Box(Modifier.matchParentSize()) {
                Box(
                    modifier = Modifier
                        .offset { IntOffset(indicatorOffset.roundToPx(), 0) }
                        .width(tabWidth)
                        .fillMaxHeight()
                        .graphicsLayer { alpha = indicatorAlpha }
                        .clip(tabShape)
                        .background(palette.accent)
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .selectableGroup()
            ) {
                AidenPairingTabTitles.forEachIndexed { index, title ->
                    val selected = selectedTab == index
                    val ink by animateColorAsState(
                        targetValue = if (selected) Color.White else palette.secondary,
                        animationSpec = AidenMotion.nonSpatial(reduceMotion),
                        label = "pairing_tab_ink"
                    )
                    val interaction = remember { MutableInteractionSource() }
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .weight(1f)
                            .tactilePress(interaction)
                            .clip(tabShape)
                            .selectable(
                                selected = selected,
                                role = Role.Tab,
                                interactionSource = interaction,
                                indication = ripple(),
                                onClick = { onSelectTab(index) }
                            )
                            .heightIn(min = 40.dp)
                            .padding(vertical = 8.dp)
                    ) {
                        Text(
                            text = title,
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            color = ink
                        )
                    }
                }
            }
        }
    }
}

/** Full-width squircle pairing action whose press compression shares the button's tap. */
@Composable
internal fun AidenPairingActionButton(
    text: String,
    busy: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Button(
        onClick = onClick,
        enabled = enabled,
        interactionSource = interaction,
        colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
        shape = AidenShape.Button,
        modifier = modifier
            .fillMaxWidth()
            .tactilePress(interaction)
    ) {
        if (busy) {
            CircularProgressIndicator(color = Color.White, modifier = Modifier.size(20.dp))
        } else {
            Text(text, color = Color.White, fontWeight = FontWeight.Bold)
        }
    }
}
