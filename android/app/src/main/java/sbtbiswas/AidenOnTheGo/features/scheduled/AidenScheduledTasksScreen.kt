package sbtbiswas.AidenOnTheGo.features.scheduled

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSectionLabel
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenScheduledTasksScreen(
    coordinator: AidenRemoteCoordinator,
    pendingRunKeys: AidenScheduledRunIdempotencyKeys,
    onNavigateBack: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsState()
    val connectionState by coordinator.connectionState.collectAsState()
    val installations by coordinator.installationStore.installations.collectAsState()
    val activeInstallationId by coordinator.installationStore.activeInstallationId.collectAsState()
    val activeInstallation = installations.firstOrNull { it.id == activeInstallationId }
    val instanceId = activeInstallation?.instanceId
    val canReadSchedules = activeInstallation?.hasNegotiatedAccess(AidenRemoteCapability.SCHEDULE_READ) == true
    val canWriteSchedules = activeInstallation?.hasNegotiatedAccess(AidenRemoteCapability.SCHEDULE_WRITE) == true

    var tasks by remember(instanceId, canReadSchedules) {
        mutableStateOf(
            if (canReadSchedules && instanceId != null) {
                coordinator.scheduledCache.loadForScheduleReadAccess(instanceId, canRead = true)?.tasks.orEmpty()
            } else {
                emptyList()
            }
        )
    }
    var isLoading by remember { mutableStateOf(tasks.isEmpty() && client != null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var operationTaskId by remember { mutableStateOf<String?>(null) }
    var operationRequestId by remember { mutableStateOf<UUID?>(null) }
    var selectedTaskId by rememberSaveable { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(AidenScheduledTaskFilter.ALL) }
    var runs by remember { mutableStateOf<List<AidenScheduledRun>>(emptyList()) }
    var runsLoading by remember { mutableStateOf(false) }
    var showDeleteConfirmation by remember { mutableStateOf(false) }

    fun hasCurrentAccess(capability: AidenRemoteCapability): Boolean {
        val current = coordinator.installationStore.activeInstallation ?: return false
        return current.instanceId == instanceId && current.hasNegotiatedAccess(capability)
    }

    fun isCurrentRequest(activeClient: AidenRemoteClient, capability: AidenRemoteCapability): Boolean =
        coordinator.client.value === activeClient && hasCurrentAccess(capability)

    fun retainSnapshot(next: List<AidenScheduledTask>) {
        tasks = next
        instanceId?.let { coordinator.scheduledCache.store(it, next, settings = null) }
        if (selectedTaskId != null && next.none { it.id == selectedTaskId }) selectedTaskId = null
    }

    suspend fun refresh(showSpinner: Boolean = false) {
        val activeClient = client
        if (activeClient == null || !hasCurrentAccess(AidenRemoteCapability.SCHEDULE_READ)) {
            isLoading = false
            return
        }
        if (showSpinner) isLoading = true
        errorMessage = null
        try {
            val accepted = activeClient.scheduledTasks()
            if (isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_READ)) retainSnapshot(accepted)
        } catch (error: Exception) {
            if (error !is CancellationException && isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_READ)) {
                errorMessage = error.message ?: "Aiden couldn't load scheduled tasks."
            }
        } finally {
            if (isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_READ)) isLoading = false
        }
    }

    fun mutate(taskId: String, action: suspend () -> AidenScheduledTask) {
        val activeClient = client ?: return
        if (operationTaskId != null || !hasCurrentAccess(AidenRemoteCapability.SCHEDULE_WRITE)) return
        val requestId = UUID.randomUUID()
        operationTaskId = taskId
        operationRequestId = requestId
        errorMessage = null
        scope.launch {
            try {
                val updated = action()
                if (isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_WRITE)) {
                    retainSnapshot(tasks.map { if (it.id == updated.id) updated else it })
                }
            } catch (error: Exception) {
                if (error !is CancellationException && isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_WRITE)) {
                    errorMessage = error.message ?: "Aiden couldn't update this scheduled task."
                    refresh()
                }
            } finally {
                if (aidenScheduledOperationCanClear(operationRequestId, requestId)) {
                    operationTaskId = null
                    operationRequestId = null
                }
            }
        }
    }

    fun loadRuns(taskId: String) {
        runs = if (canReadSchedules) {
            instanceId?.let {
                coordinator.scheduledCache.loadForScheduleReadAccess(it, canRead = true)?.runs?.get(taskId)
            }.orEmpty()
        } else {
            emptyList()
        }
        val activeClient = client
        if (activeClient == null || !hasCurrentAccess(AidenRemoteCapability.SCHEDULE_READ)) {
            runsLoading = false
            return
        }
        runsLoading = true
        scope.launch {
            try {
                val accepted = activeClient.scheduledRuns(taskId)
                if (isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_READ) && selectedTaskId == taskId) {
                    runs = accepted
                    instanceId?.let { coordinator.scheduledCache.store(accepted, taskId, it) }
                }
            } catch (_: Exception) {
                // A retained run snapshot is preferable to replacing detail content with a transient error.
            } finally {
                if (isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_READ) && selectedTaskId == taskId) runsLoading = false
            }
        }
    }

    fun toggle(task: AidenScheduledTask) {
        val activeClient = client ?: return
        if (!hasCurrentAccess(AidenRemoteCapability.SCHEDULE_WRITE)) return
        val revision = task.revision
        if (task.enabled) {
            mutate(task.id) { activeClient.pauseScheduledTask(task.id, revision) }
        } else {
            mutate(task.id) { activeClient.resumeScheduledTask(task.id, revision) }
        }
    }

    LaunchedEffect(client, connectionState, instanceId, canReadSchedules) {
        if (!canReadSchedules) {
            instanceId?.let { coordinator.scheduledCache.loadForScheduleReadAccess(it, canRead = false) }
            tasks = emptyList()
            selectedTaskId = null
            runs = emptyList()
            operationTaskId = null
            operationRequestId = null
            isLoading = false
            return@LaunchedEffect
        }
        val cached = instanceId?.let {
            coordinator.scheduledCache.loadForScheduleReadAccess(it, canRead = true)?.tasks
        }.orEmpty()
        if (cached.isNotEmpty()) tasks = cached
        if (client != null && connectionState == AidenConnectionState.CONNECTED) refresh(showSpinner = tasks.isEmpty())
        else isLoading = false
    }

    LaunchedEffect(instanceId) {
        selectedTaskId = null
        query = ""
        filter = AidenScheduledTaskFilter.ALL
        errorMessage = null
        operationTaskId = null
        operationRequestId = null
        runs = emptyList()
    }

    LaunchedEffect(selectedTaskId, client) {
        selectedTaskId?.let(::loadRuns) ?: run { runs = emptyList() }
    }

    val selectedTask = tasks.firstOrNull { it.id == selectedTaskId }
    val visibleTasks = remember(tasks, query, filter) {
        AidenScheduledTaskPresentation.visible(tasks, query, filter)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        selectedTask?.name ?: "Scheduled Tasks",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                },
                navigationIcon = {
                    IconButton(onClick = {
                        if (selectedTaskId != null) selectedTaskId = null else onNavigateBack()
                    }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = palette.foreground)
                    }
                },
                actions = {
                    if (selectedTaskId == null && client != null && canReadSchedules) {
                        IconButton(
                            onClick = { scope.launch { refresh(showSpinner = tasks.isEmpty()) } },
                            enabled = !isLoading
                        ) {
                            Icon(Icons.Outlined.Refresh, contentDescription = "Refresh scheduled tasks", tint = palette.foreground)
                        }
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
        if (!canReadSchedules) {
            AidenEmptyState(
                icon = Icons.Outlined.Lock,
                title = "Scheduled task access unavailable",
                body = "This paired device doesn't have schedule read access.",
                modifier = Modifier.fillMaxSize().padding(padding)
            )
        } else if (selectedTask != null) {
            AidenScheduledTaskDetail(
                task = selectedTask,
                runs = runs,
                runsLoading = runsLoading,
                isConnected = client != null && connectionState == AidenConnectionState.CONNECTED,
                canManage = client != null && connectionState == AidenConnectionState.CONNECTED && canWriteSchedules,
                operationInProgress = operationTaskId == selectedTask.id,
                errorMessage = errorMessage,
                onToggleEnabled = { toggle(selectedTask) },
                onRunNow = {
                    val activeClient = client ?: return@AidenScheduledTaskDetail
                    if (operationTaskId != null || !hasCurrentAccess(AidenRemoteCapability.SCHEDULE_WRITE)) return@AidenScheduledTaskDetail
                    val requestId = UUID.randomUUID()
                    operationTaskId = selectedTask.id
                    operationRequestId = requestId
                    errorMessage = null
                    val runKey = pendingRunKeys.keyFor(selectedTask.id)
                    scope.launch {
                        try {
                            activeClient.runScheduledTask(selectedTask.id, selectedTask.revision, runKey)
                            pendingRunKeys.accepted(selectedTask.id)
                            if (!isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_WRITE)) return@launch
                            refresh()
                            loadRuns(selectedTask.id)
                        } catch (_: CancellationException) {
                            // Cancellation does not prove whether the Mac accepted the run.
                        } catch (error: Exception) {
                            pendingRunKeys.failed(selectedTask.id, error)
                            if (isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_WRITE)) {
                                errorMessage = error.message ?: "Aiden couldn't start this task."
                            }
                        } finally {
                            if (aidenScheduledOperationCanClear(operationRequestId, requestId)) {
                                operationTaskId = null
                                operationRequestId = null
                            }
                        }
                    }
                },
                onDelete = { showDeleteConfirmation = true },
                modifier = Modifier.padding(padding)
            )
        } else {
            AidenScheduledTaskList(
                tasks = visibleTasks,
                hasAnyTasks = tasks.isNotEmpty(),
                query = query,
                filter = filter,
                isLoading = isLoading,
                isConnected = client != null && connectionState == AidenConnectionState.CONNECTED,
                canManage = client != null && connectionState == AidenConnectionState.CONNECTED && canWriteSchedules,
                operationTaskId = operationTaskId,
                errorMessage = errorMessage,
                onQueryChanged = { query = it },
                onFilterChanged = { filter = it },
                onSelectTask = { selectedTaskId = it.id },
                onToggleEnabled = ::toggle,
                onRetry = { scope.launch { refresh(showSpinner = tasks.isEmpty()) } },
                modifier = Modifier.padding(padding)
            )
        }
    }

    if (showDeleteConfirmation && selectedTask != null) {
        AlertDialog(
            onDismissRequest = { if (operationTaskId == null) showDeleteConfirmation = false },
            title = { Text("Delete ${selectedTask.name}?") },
            text = { Text("This removes the automation and its saved run history from Aiden.") },
            dismissButton = {
                TextButton(
                    onClick = { showDeleteConfirmation = false },
                    enabled = operationTaskId == null
                ) { Text("Cancel") }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val activeClient = client ?: return@TextButton
                        if (operationTaskId != null || !hasCurrentAccess(AidenRemoteCapability.SCHEDULE_WRITE)) return@TextButton
                        val requestId = UUID.randomUUID()
                        operationTaskId = selectedTask.id
                        operationRequestId = requestId
                        scope.launch {
                            try {
                                activeClient.removeScheduledTask(selectedTask.id, selectedTask.revision)
                                if (!isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_WRITE)) return@launch
                                retainSnapshot(tasks.filterNot { it.id == selectedTask.id })
                                showDeleteConfirmation = false
                            } catch (error: Exception) {
                                if (error !is CancellationException && isCurrentRequest(activeClient, AidenRemoteCapability.SCHEDULE_WRITE)) {
                                    errorMessage = error.message ?: "Aiden couldn't delete this task."
                                    showDeleteConfirmation = false
                                    refresh()
                                }
                            } finally {
                                if (aidenScheduledOperationCanClear(operationRequestId, requestId)) {
                                    operationTaskId = null
                                    operationRequestId = null
                                }
                            }
                        }
                    },
                    enabled = operationTaskId == null && canWriteSchedules,
                    colors = ButtonDefaults.textButtonColors(contentColor = palette.danger)
                ) { Text("Delete") }
            },
            containerColor = palette.raised
        )
    }
}

@Composable
private fun AidenScheduledTaskList(
    tasks: List<AidenScheduledTask>,
    hasAnyTasks: Boolean,
    query: String,
    filter: AidenScheduledTaskFilter,
    isLoading: Boolean,
    isConnected: Boolean,
    canManage: Boolean,
    operationTaskId: String?,
    errorMessage: String?,
    onQueryChanged: (String) -> Unit,
    onFilterChanged: (AidenScheduledTaskFilter) -> Unit,
    onSelectTask: (AidenScheduledTask) -> Unit,
    onToggleEnabled: (AidenScheduledTask) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp)
    ) {
        item {
            Column(modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)) {
                Text(
                    "Ask Aiden in any chat to create or change an automation.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = palette.foreground
                )
                Spacer(Modifier.height(5.dp))
                Text(
                    "Aiden shows a permission review before saving unattended work. If a proposal can't be fully reviewed here, Aiden asks you to confirm it on your Mac.",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary
                )
                if (!isConnected) {
                    Spacer(Modifier.height(12.dp))
                    Surface(color = palette.raised, shape = RoundedCornerShape(12.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(Icons.Outlined.CloudOff, null, tint = palette.secondary, modifier = Modifier.size(17.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Offline — showing the last saved task list.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                        }
                    }
                }
                Spacer(Modifier.height(18.dp))
                AidenScheduleSearchField(query, onQueryChanged)
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AidenScheduledTaskFilter.entries.forEach { choice ->
                        Surface(
                            onClick = { onFilterChanged(choice) },
                            color = if (choice == filter) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent,
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier
                                .heightIn(min = AidenUi.MinimumTouchTarget)
                                .semantics {
                                    role = Role.RadioButton
                                    selected = choice == filter
                                    contentDescription = "${choice.title} scheduled tasks"
                                }
                        ) {
                            Text(
                                choice.title,
                                style = MaterialTheme.typography.labelLarge,
                                color = if (choice == filter) palette.foreground else palette.secondary,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp)
                            )
                        }
                    }
                }
            }
        }

        if (errorMessage != null) {
            item {
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(errorMessage, style = MaterialTheme.typography.bodySmall, color = palette.danger, modifier = Modifier.weight(1f))
                        if (isConnected) TextButton(onClick = onRetry) { Text("Retry") }
                    }
                }
            }
        }

        if (isLoading && !hasAnyTasks) {
            item {
                Box(modifier = Modifier.fillParentMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
                }
            }
        } else if (tasks.isEmpty()) {
            item {
                AidenEmptyState(
                    icon = if (hasAnyTasks) Icons.Outlined.SearchOff else Icons.Outlined.Schedule,
                    title = if (hasAnyTasks) "No matching tasks" else "No scheduled tasks",
                    body = if (hasAnyTasks) {
                        "Try another search or status."
                    } else {
                        "Open any Aiden chat and ask it to schedule, remind, or monitor something."
                    },
                    modifier = Modifier.fillParentMaxHeight()
                )
            }
        }

        items(tasks, key = AidenScheduledTask::id) { task ->
            AidenScheduledTaskRow(
                task = task,
                enabled = canManage && operationTaskId == null,
                operationInProgress = operationTaskId == task.id,
                onClick = { onSelectTask(task) },
                onToggleEnabled = { onToggleEnabled(task) }
            )
        }
    }
}

@Composable
internal fun AidenScheduleSearchField(value: String, onValueChanged: (String) -> Unit) {
    val palette = AidenTheme.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = AidenUi.MinimumTouchTarget)
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Outlined.Search, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(19.dp))
        Spacer(Modifier.width(9.dp))
        BasicTextField(
            value = value,
            onValueChange = onValueChanged,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = palette.foreground),
            cursorBrush = SolidColor(palette.accent),
            modifier = Modifier
                .weight(1f)
                .semantics { contentDescription = "Search scheduled tasks" },
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) Text("Search scheduled tasks", style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                    inner()
                }
            }
        )
        if (value.isNotEmpty()) {
            IconButton(onClick = { onValueChanged("") }, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Default.Close, contentDescription = "Clear search", tint = palette.secondary, modifier = Modifier.size(17.dp))
            }
        }
    }
}

@Composable
private fun AidenScheduledTaskRow(
    task: AidenScheduledTask,
    enabled: Boolean,
    operationInProgress: Boolean,
    onClick: () -> Unit,
    onToggleEnabled: () -> Unit
) {
    val palette = AidenTheme.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = AidenUi.ScreenGutter, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier.size(34.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerLow),
            contentAlignment = Alignment.Center
        ) {
            if (operationInProgress) {
                CircularProgressIndicator(modifier = Modifier.size(17.dp), strokeWidth = 2.dp)
            } else {
                Icon(
                    if (task.enabled) Icons.Outlined.Schedule else Icons.Outlined.PauseCircle,
                    contentDescription = null,
                    tint = if (task.enabled) palette.accent else palette.secondary,
                    modifier = Modifier.size(19.dp)
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    task.name,
                    style = MaterialTheme.typography.titleMedium,
                    color = palette.foreground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                if (task.running) {
                    Spacer(Modifier.width(7.dp))
                    Text("Running", style = MaterialTheme.typography.labelSmall, color = palette.accent)
                }
            }
            Spacer(Modifier.height(3.dp))
            Text(
                AidenScheduledTaskPresentation.schedule(task),
                style = MaterialTheme.typography.bodySmall,
                color = palette.secondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Spacer(Modifier.width(8.dp))
        Switch(
            checked = task.enabled,
            onCheckedChange = { onToggleEnabled() },
            enabled = enabled,
            colors = SwitchDefaults.colors(checkedThumbColor = Color.White, checkedTrackColor = palette.accent),
            modifier = Modifier.semantics { contentDescription = if (task.enabled) "Pause ${task.name}" else "Resume ${task.name}" }
        )
    }
}

@Composable
private fun AidenScheduledTaskDetail(
    task: AidenScheduledTask,
    runs: List<AidenScheduledRun>,
    runsLoading: Boolean,
    isConnected: Boolean,
    canManage: Boolean,
    operationInProgress: Boolean,
    errorMessage: String?,
    onToggleEnabled: () -> Unit,
    onRunNow: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = AidenUi.ScreenGutter, vertical = 10.dp)
    ) {
        Surface(color = palette.raised, shape = RoundedCornerShape(16.dp)) {
            Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                AidenTaskMetadataRow("Status", AidenScheduledTaskPresentation.status(task))
                AidenTaskMetadataRow("Schedule", AidenScheduledTaskPresentation.schedule(task))
                AidenTaskMetadataRow("Timezone", task.timezone)
                AidenTaskMetadataRow("Access", task.permission.title)
                if (task.mode == AidenScheduledTaskMode.LLM) AidenTaskMetadataRow("Type", "Ask Aiden")
                AidenScheduledTaskPresentation.timestamp(task.nextRunAt)?.let { AidenTaskMetadataRow("Next run", it) }
                AidenScheduledTaskPresentation.timestamp(task.lastRunAt)?.let { AidenTaskMetadataRow("Last run", it) }
            }
        }

        task.prompt?.takeIf { it.isNotBlank() }?.let { prompt ->
            Spacer(Modifier.height(AidenUi.SectionGap))
            AidenSectionLabel("Instructions")
            Spacer(Modifier.height(9.dp))
            Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(14.dp)) {
                Text(prompt, style = MaterialTheme.typography.bodyMedium, color = palette.foreground, modifier = Modifier.fillMaxWidth().padding(14.dp))
            }
        }

        Spacer(Modifier.height(AidenUi.SectionGap))
        AidenSectionLabel("Controls")
        Spacer(Modifier.height(9.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = onRunNow,
                enabled = canManage && !operationInProgress && !task.running,
                colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                shape = RoundedCornerShape(11.dp)
            ) {
                Icon(Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(if (task.running) "Running" else "Run now")
            }
            FilledTonalButton(
                onClick = onToggleEnabled,
                enabled = canManage && !operationInProgress,
                shape = RoundedCornerShape(11.dp)
            ) {
                Icon(if (task.enabled) Icons.Default.Pause else Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(if (task.enabled) "Pause" else "Resume")
            }
        }
        TextButton(
            onClick = onDelete,
            enabled = canManage && !operationInProgress,
            colors = ButtonDefaults.textButtonColors(contentColor = palette.danger),
            contentPadding = PaddingValues(horizontal = 0.dp)
        ) { Text("Delete automation") }

        if (!isConnected) {
            Text("Connect to your Mac to run or change this task.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        } else if (!canManage) {
            Text("This paired device has read-only scheduled task access.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        }
        if (errorMessage != null) {
            Spacer(Modifier.height(8.dp))
            Text(errorMessage, style = MaterialTheme.typography.bodySmall, color = palette.danger)
        }

        Spacer(Modifier.height(AidenUi.SectionGap))
        AidenSectionLabel("Recent runs")
        Spacer(Modifier.height(9.dp))
        if (runsLoading && runs.isEmpty()) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
        } else if (runs.isEmpty()) {
            Text("No runs yet.", style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
        } else {
            runs.take(20).forEach { run ->
                Surface(color = Color.Transparent, shape = RoundedCornerShape(12.dp)) {
                    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.Top) {
                        Icon(
                            if (run.status == "succeeded") Icons.Outlined.CheckCircle else Icons.Outlined.ErrorOutline,
                            contentDescription = null,
                            tint = if (run.status == "succeeded") palette.success else palette.warning,
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                AidenScheduledTaskPresentation.timestamp(run.startedAt) ?: run.status,
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.foreground
                            )
                            run.summary?.takeIf { it.isNotBlank() }?.let {
                                Spacer(Modifier.height(3.dp))
                                Text(it, style = MaterialTheme.typography.bodySmall, color = palette.secondary, maxLines = 3, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(28.dp))
    }
}

@Composable
private fun AidenTaskMetadataRow(label: String, value: String) {
    val palette = AidenTheme.palette
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = palette.secondary, modifier = Modifier.width(76.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = palette.foreground, modifier = Modifier.weight(1f))
    }
}
