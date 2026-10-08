package sbtbiswas.AidenOnTheGo.features.remote

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.settings.AidenSettingsDefaults
import sbtbiswas.AidenOnTheGo.features.settings.AidenSettingsGroup
import sbtbiswas.AidenOnTheGo.features.settings.AidenSettingsListItem
import sbtbiswas.AidenOnTheGo.features.settings.AidenSettingsMessageRow
import sbtbiswas.AidenOnTheGo.features.settings.AidenSettingsNavigationRow
import sbtbiswas.AidenOnTheGo.features.settings.AidenSettingsScaffold
import sbtbiswas.AidenOnTheGo.models.AidenInstallation
import sbtbiswas.AidenOnTheGo.models.AidenPairingPayload
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/**
 * Paired desktops as one radio group of settings rows: tapping a row makes it active, the
 * active one carries a check and "Active", and removal asks for confirmation first.
 */
@Composable
fun AidenInstallationsScreen(
    coordinator: AidenRemoteCoordinator,
    installationStore: AidenInstallationStore,
    onPairDesktop: () -> Unit,
    onNavigateBack: () -> Unit
) {
    val installations by installationStore.installations.collectAsStateWithLifecycle()
    val activeId by installationStore.activeInstallationId.collectAsStateWithLifecycle()
    var pendingRemoval by remember { mutableStateOf<AidenInstallation?>(null) }

    AidenSettingsScaffold(
        title = stringResource(R.string.installations_title),
        onNavigateBack = onNavigateBack
    ) {
        item(key = "desktops") {
            AidenInstallationList(
                installations = installations,
                activeId = activeId,
                onActivate = { installation ->
                    if (installation.id != activeId) {
                        installationStore.setActiveInstallation(installation.id)
                        coordinator.refreshClient()
                    }
                },
                onRemove = { pendingRemoval = it }
            )
        }
        item(key = "pair") {
            AidenSettingsGroup(title = null) {
                row {
                    AidenSettingsNavigationRow(
                        headline = stringResource(R.string.installations_pair),
                        supporting = stringResource(R.string.installations_pair_supporting),
                        leadingIcon = Icons.Outlined.Add,
                        onClick = onPairDesktop
                    )
                }
            }
        }
    }

    pendingRemoval?.let { installation ->
        AidenRemoveInstallationDialog(
            installation = installation,
            onConfirm = {
                coordinator.removeInstallation(installation.id)
                pendingRemoval = null
            },
            onDismiss = { pendingRemoval = null }
        )
    }
}

@Composable
internal fun AidenInstallationList(
    installations: List<AidenInstallation>,
    activeId: String?,
    onActivate: (AidenInstallation) -> Unit,
    onRemove: (AidenInstallation) -> Unit
) {
    val palette = AidenTheme.palette
    AidenSettingsGroup(
        title = stringResource(R.string.installations_group),
        selectableGroup = true
    ) {
        if (installations.isEmpty()) {
            row(dividerInset = AidenSettingsDefaults.DividerInset) {
                AidenSettingsMessageRow(stringResource(R.string.installations_empty))
            }
        }
        installations.forEach { installation ->
            row {
                val isActive = installation.id == activeId
                val removeLabel = stringResource(R.string.installations_remove, installation.name)
                AidenSettingsListItem(
                    headline = installation.name,
                    modifier = Modifier.selectable(
                        selected = isActive,
                        role = Role.RadioButton,
                        onClick = { onActivate(installation) }
                    ),
                    supporting = {
                        Text(
                            if (isActive) stringResource(R.string.installations_active_endpoint, installation.endpoint)
                            else installation.endpoint
                        )
                    },
                    leading = {
                        Icon(Icons.Outlined.Laptop, contentDescription = null, tint = if (isActive) palette.accent else palette.secondary)
                    },
                    trailing = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (isActive) Icon(Icons.Default.Check, contentDescription = null, tint = palette.accent)
                            IconButton(onClick = { onRemove(installation) }) {
                                Icon(Icons.Outlined.DeleteOutline, contentDescription = removeLabel, tint = palette.danger)
                            }
                        }
                    }
                )
            }
        }
    }
}

@Composable
private fun AidenRemoveInstallationDialog(
    installation: AidenInstallation,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.installations_remove_title, installation.name)) },
        text = { Text(stringResource(R.string.installations_remove_body)) },
        confirmButton = {
            AidenDialogConfirmButton(text = stringResource(R.string.action_remove), destructive = true, onClick = onConfirm)
        },
        dismissButton = { AidenDialogDismissButton(text = stringResource(R.string.action_cancel), onClick = onDismiss) },
        shape = AidenShape.Dialog,
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        titleContentColor = palette.foreground,
        textContentColor = palette.secondary
    )
}

/**
 * Pairs a desktop: short numbered steps, the camera first, a setup-code fallback, and an
 * advanced paste option. The first-run variant has no back action because there is nowhere
 * to go back to. Pairing never shows a spinner: the action disables and its label changes.
 *
 * When an [installationStore] is given and it still lists desktops (for example one whose
 * credential is missing), they stay switchable and removable above the pairing steps.
 */
@Composable
fun AidenPairDesktopScreen(
    coordinator: AidenRemoteCoordinator,
    firstRun: Boolean,
    onPaired: () -> Unit,
    onNavigateBack: (() -> Unit)?,
    installationStore: AidenInstallationStore? = null
) {
    val installations = installationStore?.installations?.collectAsStateWithLifecycle()?.value.orEmpty()
    val activeId = installationStore?.activeInstallationId?.collectAsStateWithLifecycle()?.value
    var pendingRemoval by remember { mutableStateOf<AidenInstallation?>(null) }
    val scope = rememberCoroutineScope()
    var isPairing by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val fallbackError = stringResource(R.string.pairing_failed)

    fun pair(block: suspend () -> Unit, onFailure: () -> Unit = {}) {
        if (isPairing) return
        isPairing = true
        errorMessage = null
        scope.launch {
            try {
                block()
                onPaired()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                errorMessage = error.message ?: fallbackError
                onFailure()
            } finally {
                isPairing = false
            }
        }
    }
    BackHandler(enabled = isPairing && onNavigateBack != null) {}

    AidenSettingsScaffold(
        title = stringResource(if (firstRun) R.string.pairing_first_run_title else R.string.pairing_title),
        onNavigateBack = onNavigateBack?.let { back -> { if (!isPairing) back() } }
    ) {
        if (installations.isNotEmpty() && installationStore != null) {
            item(key = "desktops") {
                AidenInstallationList(
                    installations = installations,
                    activeId = activeId,
                    onActivate = { installation ->
                        installationStore.setActiveInstallation(installation.id)
                        coordinator.refreshClient()
                    },
                    onRemove = { pendingRemoval = it }
                )
            }
        }
        item(key = "steps") { AidenPairingSteps() }
        item(key = "methods") {
            AidenPairingMethods(
                isPairing = isPairing,
                errorMessage = errorMessage,
                onScanned = { scanned, retry ->
                    pair({
                        val payload = pairingJson.decodeFromString<AidenPairingPayload>(scanned.trim())
                        coordinator.pairWithQRCode(payload)
                    }, onFailure = retry)
                },
                onManualCode = { code, endpoint -> pair({ coordinator.pairWithManualCode(code, endpoint) }) }
            )
        }
    }

    pendingRemoval?.let { installation ->
        AidenRemoveInstallationDialog(
            installation = installation,
            onConfirm = {
                coordinator.removeInstallation(installation.id)
                pendingRemoval = null
            },
            onDismiss = { pendingRemoval = null }
        )
    }
}

private val pairingJson = Json { ignoreUnknownKeys = true }

@Composable
private fun AidenPairingSteps() {
    val steps = listOf(
        stringResource(R.string.pairing_step_open),
        stringResource(R.string.pairing_step_settings),
        stringResource(R.string.pairing_step_scan)
    )
    AidenSettingsGroup(title = stringResource(R.string.pairing_steps_title)) {
        steps.forEachIndexed { index, step ->
            row {
                AidenSettingsListItem(
                    headline = step,
                    modifier = Modifier,
                    supporting = null,
                    leading = {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier
                                .size(24.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.primaryContainer)
                        ) {
                            Text(
                                "${index + 1}",
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onPrimaryContainer
                            )
                        }
                    },
                    trailing = null
                )
            }
        }
    }
}

/** Camera, setup code, or pasted details. [onScanned] gets a retry callback that re-arms the camera. */
@Composable
private fun AidenPairingMethods(
    isPairing: Boolean,
    errorMessage: String?,
    onScanned: (String, () -> Unit) -> Unit,
    onManualCode: (String, String) -> Unit
) {
    val palette = AidenTheme.palette
    var selectedTab by rememberSaveable { mutableIntStateOf(0) } // 0: Scan QR, 1: Setup code, 2: Paste
    var manualCode by rememberSaveable { mutableStateOf("") }
    var endpointUrl by rememberSaveable { mutableStateOf(DEFAULT_PAIRING_ENDPOINT) }
    var qrJsonInput by rememberSaveable { mutableStateOf("") }
    var scanAttempt by remember { mutableIntStateOf(0) }

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        AidenPairingModeTabs(selectedTab = selectedTab, onSelectTab = { selectedTab = it })

        errorMessage?.let { AidenPairingError(it) }

        when (selectedTab) {
            0 -> {
                key(scanAttempt) {
                    AidenQRCodeScanner(
                        onCodeScanned = { scanned -> onScanned(scanned) { scanAttempt += 1 } }
                    )
                }
                if (isPairing) {
                    Text(
                        stringResource(R.string.pairing_in_progress),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.foreground,
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { liveRegion = LiveRegionMode.Polite }
                    )
                }
            }
            1 -> {
                TextField(
                    colors = aidenTextFieldColors(),
                    value = manualCode,
                    onValueChange = { manualCode = formatCrockfordCode(it) },
                    label = { Text(stringResource(R.string.pairing_setup_code)) },
                    placeholder = { Text("0123-4567-89AB-CDEF-GHJK") },
                    singleLine = true,
                    enabled = !isPairing,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                    textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace, letterSpacing = 2.sp),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth()
                )
                TextField(
                    colors = aidenTextFieldColors(),
                    value = endpointUrl,
                    onValueChange = { endpointUrl = it },
                    label = { Text(stringResource(R.string.pairing_desktop_address)) },
                    singleLine = true,
                    enabled = !isPairing,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth()
                )
                AidenPairingActionButton(
                    text = stringResource(R.string.pairing_connect),
                    busy = isPairing,
                    enabled = manualCode.replace("-", "").length == 20,
                    onClick = { onManualCode(manualCode, endpointUrl) }
                )
            }
            2 -> {
                TextField(
                    colors = aidenTextFieldColors(),
                    value = qrJsonInput,
                    onValueChange = { qrJsonInput = it },
                    label = { Text(stringResource(R.string.pairing_paste_label)) },
                    placeholder = { Text(stringResource(R.string.pairing_paste_placeholder)) },
                    minLines = 4,
                    enabled = !isPairing,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth()
                )
                AidenPairingActionButton(
                    text = stringResource(R.string.pairing_import),
                    busy = isPairing,
                    enabled = qrJsonInput.isNotBlank(),
                    onClick = { onScanned(qrJsonInput) {} }
                )
            }
        }

        TextButton(
            onClick = { selectedTab = if (selectedTab == 2) 0 else 2 },
            shape = AidenShape.Button,
            modifier = Modifier.heightIn(min = AidenUi.MinimumTouchTarget)
        ) {
            Text(stringResource(if (selectedTab == 2) R.string.pairing_back_to_scanning else R.string.pairing_paste_details))
        }
    }
}

@Composable
private fun AidenPairingError(message: String) {
    val palette = AidenTheme.palette
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite }
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(16.dp)
        ) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = palette.danger)
            Text(message, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

internal const val DEFAULT_PAIRING_ENDPOINT = "https://127.0.0.1:8765/api/aiden/v1"

/** Normalizes a typed setup code to Crockford base32 in dash-separated groups of four. */
internal fun formatCrockfordCode(input: String): String =
    input.uppercase()
        .replace("-", "")
        .filter { it in "0123456789ABCDEFGHJKMNPQRSTVWXYZIL" }
        .take(20)
        .chunked(4)
        .joinToString("-")

internal val AidenPairingTabTitles = listOf(R.string.pairing_tab_scan, R.string.pairing_tab_code)

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
    val tabShape = MaterialTheme.shapes.large
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.extraLarge,
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
                AidenPairingTabTitles.forEachIndexed { index, titleRes ->
                    val selected = selectedTab == index
                    val ink by animateColorAsState(
                        targetValue = if (selected) palette.onAccent else palette.secondary,
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
                            .heightIn(min = AidenUi.MinimumTouchTarget)
                            .padding(vertical = 8.dp)
                    ) {
                        Text(
                            text = stringResource(titleRes),
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.SemiBold,
                            color = ink
                        )
                    }
                }
            }
        }
    }
}

/**
 * Full-width squircle pairing action whose press compression shares the button's tap.
 * While [busy] it disables and reads [busyText] instead of spinning.
 */
@Composable
internal fun AidenPairingActionButton(
    text: String,
    busy: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    busyText: String = stringResource(R.string.pairing_in_progress_short)
) {
    val palette = AidenTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        interactionSource = interaction,
        colors = ButtonDefaults.buttonColors(containerColor = palette.accent, contentColor = palette.onAccent),
        shape = AidenShape.Button,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = AidenUi.MinimumTouchTarget)
            .tactilePress(interaction)
    ) {
        Text(if (busy) busyText else text, fontWeight = FontWeight.SemiBold)
    }
}
