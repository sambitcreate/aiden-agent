package sbtbiswas.AidenOnTheGo.features.simulators

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ScreenRotation
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.ViewCarousel
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorDevice
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorButton
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorTouchPhase
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

/**
 * The device button above the composer: one phone glyph, with a count badge
 * when the chat has several devices.
 *
 * Adapted from t3code apps/mobile/src/features/devices/device-preview-button.tsx (MIT).
 */
@Composable
fun AidenSimulatorDeviceButton(count: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val label = if (count == 1) {
        stringResource(R.string.simulator_view_device)
    } else {
        pluralStringResource(R.plurals.simulator_view_devices, count, count)
    }
    FilledTonalIconButton(
        onClick = onClick,
        shape = AidenShape.Button,
        modifier = modifier.semantics { contentDescription = label }
    ) {
        BadgedBox(badge = { if (count > 1) Badge { Text(count.toString()) } }) {
            Icon(Icons.Default.Smartphone, contentDescription = null, modifier = Modifier.size(20.dp))
        }
    }
}

/**
 * Full-screen, immersive simulator viewer. Controls live in an overlay that
 * the grabber handle, a shake, or Back reveals.
 *
 * Adapted from t3code apps/mobile/src/features/devices/DevicePreviewRouteScreen.tsx (MIT).
 */
@Composable
fun AidenSimulatorViewer(viewModel: AidenSimulatorsViewModel) {
    val state by viewModel.viewer.collectAsStateWithLifecycle()
    if (!state.open) return
    Dialog(
        onDismissRequest = viewModel::closeViewer,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
            dismissOnBackPress = false,
            dismissOnClickOutside = false
        )
    ) {
        AidenSimulatorViewerContent(viewModel, state)
    }
}

@Composable
private fun AidenSimulatorViewerContent(viewModel: AidenSimulatorsViewModel, state: AidenSimulatorViewerUiState) {
    val reduceMotion = aidenReduceMotion()
    val controls by viewModel.controls.collectAsStateWithLifecycle()
    val session by viewModel.session.collectAsStateWithLifecycle()
    val frameFlow: StateFlow<ImageBitmap?> = remember(session) { session?.frame ?: MutableStateFlow(null) }
    val liveFrame by frameFlow.collectAsStateWithLifecycle()
    // The last frame stays on screen through a reload or a trip to the background.
    var shownFrame by remember(state.selectedDeviceId) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(liveFrame) { liveFrame?.let { shownFrame = it } }

    ImmersiveWindow(reduceMotion)
    StreamLifecycle(viewModel)
    ShakeToToggle(viewModel)
    BackHandler { if (viewModel.back()) viewModel.closeViewer() }

    var confirmShutdown by remember { mutableStateOf(false) }
    var showToolVersions by remember { mutableStateOf(false) }
    val device = state.selectedDevice

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(AidenTheme.palette.canvas)
    ) {
        val frame = shownFrame
        if (frame != null && device != null && device.isViewableOnPhone && state.error == null) {
            SimulatorFrame(
                frame = frame,
                deviceName = device.name,
                inputConnected = controls.inputConnected,
                onTouch = viewModel::touch
            )
        } else {
            SimulatorPlaceholder(state, device, onRetry = {
                if (state.offersHostRetry) viewModel.retryHost() else viewModel.reloadStream()
            })
        }

        AnimatedVisibility(
            visible = controls.visible,
            enter = if (reduceMotion) EnterTransition.None else fadeIn(tween(160)),
            exit = if (reduceMotion) ExitTransition.None else fadeOut(tween(120))
        ) {
            Box(Modifier.fillMaxSize()) {
                if (controls.inputConnected) {
                    val hide = stringResource(R.string.simulator_hide_controls)
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.3f))
                            .semantics { contentDescription = hide }
                            .clickable(role = Role.Button, onClick = viewModel::backdropTapped)
                    )
                }
                ControlsBar(
                    state = state,
                    inputConnected = controls.inputConnected,
                    onClose = viewModel::closeViewer,
                    onHome = { viewModel.press(AidenSimulatorButton.HOME) },
                    onSelectDevice = viewModel::selectDevice,
                    onReload = viewModel::reloadStream,
                    onAppSwitcher = { viewModel.press(AidenSimulatorButton.APP_SWITCHER) },
                    onRotate = viewModel::rotate,
                    onShutdown = { confirmShutdown = true },
                    onToolVersions = { showToolVersions = true },
                    onRetryHost = viewModel::retryHost,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                        .padding(12.dp)
                )
            }
        }
        if (!controls.visible) {
            Grabber(
                onClick = viewModel::showControls,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top))
            )
        }
    }

    if (confirmShutdown && device != null) {
        AlertDialog(
            onDismissRequest = { confirmShutdown = false },
            title = { Text(stringResource(R.string.simulator_shutdown_title, device.name)) },
            text = { Text(stringResource(R.string.simulator_shutdown_body)) },
            confirmButton = {
                AidenDialogConfirmButton(
                    text = stringResource(R.string.simulator_shutdown_confirm),
                    destructive = true,
                    onClick = {
                        confirmShutdown = false
                        viewModel.shutdownSelected()
                    }
                )
            },
            dismissButton = { AidenDialogDismissButton(onClick = { confirmShutdown = false }) },
            shape = AidenShape.Dialog
        )
    }
    if (showToolVersions) {
        val unknown = stringResource(R.string.simulator_tool_version_unknown)
        AlertDialog(
            onDismissRequest = { showToolVersions = false },
            title = { Text(stringResource(R.string.simulator_tool_versions)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(stringResource(R.string.simulator_tool_version_hub, state.toolVersions?.hub ?: unknown))
                    Text(stringResource(R.string.simulator_tool_version_agent, state.toolVersions?.agent ?: unknown))
                }
            },
            confirmButton = {
                AidenDialogDismissButton(text = stringResource(R.string.action_close), onClick = { showToolVersions = false })
            },
            shape = AidenShape.Dialog
        )
    }
    if (state.shutdownFailed) {
        AlertDialog(
            onDismissRequest = viewModel::dismissShutdownFailure,
            text = { Text(stringResource(R.string.simulator_shutdown_failed)) },
            confirmButton = {
                AidenDialogDismissButton(text = stringResource(R.string.action_done), onClick = viewModel::dismissShutdownFailure)
            },
            shape = AidenShape.Dialog
        )
    }
}

@Composable
private fun SimulatorFrame(
    frame: ImageBitmap,
    deviceName: String,
    inputConnected: Boolean,
    onTouch: (AidenSimulatorTouchPhase, Double, Double) -> Unit
) {
    val connected by rememberUpdatedState(inputConnected)
    val currentOnTouch by rememberUpdatedState(onTouch)
    val description = stringResource(R.string.simulator_screen_description, deviceName)
    Image(
        bitmap = frame,
        contentDescription = description,
        contentScale = ContentScale.Fit,
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(frame.width, frame.height) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val rect = AidenFittedRect.aspectFit(
                        size.width.toFloat(), size.height.toFloat(),
                        frame.width.toFloat(), frame.height.toFloat()
                    )
                    // Touches outside the fitted frame, or before input connects, are ignored.
                    val start = rect.normalized(down.position.x, down.position.y) ?: return@awaitEachGesture
                    if (!connected) return@awaitEachGesture
                    down.consume()
                    currentOnTouch(AidenSimulatorTouchPhase.BEGIN, start.first, start.second)
                    var last = start
                    var ended = false
                    try {
                        while (true) {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            last = rect.normalized(change.position.x, change.position.y, clamp = true) ?: last
                            if (!change.pressed) {
                                change.consume()
                                break
                            }
                            if (change.positionChanged()) {
                                change.consume()
                                currentOnTouch(AidenSimulatorTouchPhase.MOVE, last.first, last.second)
                            }
                        }
                        ended = true
                        currentOnTouch(AidenSimulatorTouchPhase.END, last.first, last.second)
                    } catch (error: CancellationException) {
                        // Never leave a finger down on the simulator.
                        if (!ended) currentOnTouch(AidenSimulatorTouchPhase.END, last.first, last.second)
                        throw error
                    }
                }
            }
    )
}

@Composable
private fun SimulatorPlaceholder(state: AidenSimulatorViewerUiState, device: AidenSimulatorDevice?, onRetry: () -> Unit) {
    val palette = AidenTheme.palette
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        val error = state.error
        when {
            error != null -> {
                Text(
                    text = stringResource(error.messageRes),
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.secondary,
                    textAlign = TextAlign.Center
                )
                AidenTonalButton(text = stringResource(R.string.action_retry), onClick = onRetry)
            }
            device != null && !device.isViewableOnPhone -> {
                Icon(Icons.Default.Smartphone, contentDescription = null, tint = palette.secondary)
                Text(
                    text = stringResource(R.string.simulator_open_on_mac),
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.secondary,
                    textAlign = TextAlign.Center
                )
            }
            else -> {
                CircularProgressIndicator(color = palette.secondary, modifier = Modifier.size(28.dp))
                Text(
                    text = state.startingDeviceName?.let { stringResource(R.string.simulator_starting, it) }
                        ?: stringResource(R.string.simulator_connecting),
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.secondary,
                    textAlign = TextAlign.Center
                )
            }
        }
    }
}

private val AidenSimulatorViewerError.messageRes: Int
    get() = when (this) {
        AidenSimulatorViewerError.SHARING_OFF -> R.string.simulator_error_sharing_off
        AidenSimulatorViewerError.REFUSED -> R.string.simulator_error_refused
        AidenSimulatorViewerError.CAPACITY -> R.string.simulator_error_capacity
        AidenSimulatorViewerError.UNREACHABLE -> R.string.simulator_error_unreachable
    }

@Composable
private fun ControlsBar(
    state: AidenSimulatorViewerUiState,
    inputConnected: Boolean,
    onClose: () -> Unit,
    onHome: () -> Unit,
    onSelectDevice: (String) -> Unit,
    onReload: () -> Unit,
    onAppSwitcher: () -> Unit,
    onRotate: () -> Unit,
    onShutdown: () -> Unit,
    onToolVersions: () -> Unit,
    onRetryHost: () -> Unit,
    modifier: Modifier = Modifier
) {
    val device = state.selectedDevice
    Surface(
        shape = MaterialTheme.shapes.extraLarge,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = 3.dp,
        shadowElevation = 6.dp,
        modifier = modifier.fillMaxWidth()
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(4.dp)) {
            IconButton(onClick = onClose) {
                Icon(Icons.Default.Close, contentDescription = stringResource(R.string.simulator_close_viewer))
            }
            Text(
                text = device?.name ?: stringResource(R.string.simulator_default_title),
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = onHome, enabled = inputConnected) {
                Icon(Icons.Default.Home, contentDescription = stringResource(R.string.simulator_home))
            }
            Box {
                var expanded by remember { mutableStateOf(false) }
                IconButton(onClick = { expanded = true }) {
                    Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.simulator_options))
                }
                DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    fun dismissing(action: () -> Unit): () -> Unit = {
                        expanded = false
                        action()
                    }
                    if (state.devices.size > 1) {
                        Text(
                            text = stringResource(R.string.simulator_devices_section),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                        )
                        for (candidate in state.devices) {
                            DeviceMenuItem(
                                device = candidate,
                                selected = candidate.id == state.selectedDeviceId,
                                onClick = dismissing { onSelectDevice(candidate.id) }
                            )
                        }
                        HorizontalDivider()
                    }
                    MenuAction(R.string.simulator_reload, Icons.Default.Refresh, enabled = device != null && !state.shuttingDown, onClick = dismissing(onReload))
                    MenuAction(R.string.simulator_app_switcher, Icons.Default.ViewCarousel, enabled = inputConnected, onClick = dismissing(onAppSwitcher))
                    MenuAction(R.string.simulator_rotate, Icons.Default.ScreenRotation, enabled = inputConnected, onClick = dismissing(onRotate))
                    MenuAction(
                        if (state.shuttingDown) R.string.simulator_shutting_down else R.string.simulator_shutdown,
                        Icons.Default.PowerSettingsNew,
                        enabled = device?.isViewableOnPhone == true && device.booted && !state.shuttingDown,
                        onClick = dismissing(onShutdown)
                    )
                    MenuAction(R.string.simulator_tool_versions, Icons.Default.Info, enabled = true, onClick = dismissing(onToolVersions))
                    if (state.offersHostRetry) {
                        MenuAction(R.string.action_retry, Icons.Default.Refresh, enabled = true, onClick = dismissing(onRetryHost))
                    }
                }
            }
        }
    }
}

@Composable
private fun DeviceMenuItem(device: AidenSimulatorDevice, selected: Boolean, onClick: () -> Unit) {
    val detail = when {
        !device.isViewableOnPhone -> stringResource(R.string.simulator_open_on_mac)
        !device.booted -> stringResource(R.string.simulator_device_subtitle, device.version, stringResource(R.string.simulator_not_running))
        else -> device.version
    }
    DropdownMenuItem(
        text = {
            Column {
                Text(device.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        trailingIcon = if (selected) {
            { Icon(Icons.Default.Check, contentDescription = stringResource(R.string.state_selected)) }
        } else null,
        enabled = device.isViewableOnPhone,
        onClick = onClick
    )
}

@Composable
private fun MenuAction(label: Int, icon: androidx.compose.ui.graphics.vector.ImageVector, enabled: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(stringResource(label)) },
        leadingIcon = { Icon(icon, contentDescription = null) },
        enabled = enabled,
        onClick = onClick
    )
}

@Composable
private fun Grabber(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val description = stringResource(R.string.simulator_show_controls) + ". " +
        stringResource(R.string.simulator_show_controls_hint)
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(width = 64.dp, height = 32.dp)
            .semantics { contentDescription = description }
            .clickable(role = Role.Button, onClick = onClick)
    ) {
        Box(
            Modifier
                .size(width = 40.dp, height = 6.dp)
                .background(AidenTheme.palette.foreground.copy(alpha = 0.4f), CircleShape)
        )
    }
}

/** Hides the status and navigation bars while the viewer shows; a swipe reveals them briefly. */
@Composable
private fun ImmersiveWindow(reduceMotion: Boolean) {
    val view = LocalView.current
    val window = (view.parent as? DialogWindowProvider)?.window
    DisposableEffect(window, reduceMotion) {
        if (window == null) return@DisposableEffect onDispose { }
        window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        if (reduceMotion) window.setWindowAnimations(0)
        val controller = WindowCompat.getInsetsController(window, view)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
        onDispose { controller.show(WindowInsetsCompat.Type.systemBars()) }
    }
}

/** Streams run only while the app is started; they reconnect on return. */
@Composable
private fun StreamLifecycle(viewModel: AidenSimulatorsViewModel) {
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, viewModel) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> viewModel.resumeStreaming()
                Lifecycle.Event.ON_STOP -> viewModel.pauseStreaming()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
}

/** Samples the accelerometer at ~20 Hz only while the viewer is visible and resumed. */
@Composable
private fun ShakeToToggle(viewModel: AidenSimulatorsViewModel) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val resumed = lifecycleState.isAtLeast(Lifecycle.State.RESUMED)
    DisposableEffect(resumed, context, viewModel) {
        val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val accelerometer = sensors?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        if (!resumed || sensors == null || accelerometer == null) return@DisposableEffect onDispose { }
        val detector = AidenShakeDetector()
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                if (detector.onSensorSample(event.values[0], event.values[1], event.values[2], event.timestamp)) {
                    haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    viewModel.toggleControls()
                }
            }

            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        }
        sensors.registerListener(listener, accelerometer, AidenShakeDetector.SAMPLING_PERIOD_MICROS)
        onDispose { sensors.unregisterListener(listener) }
    }
}
