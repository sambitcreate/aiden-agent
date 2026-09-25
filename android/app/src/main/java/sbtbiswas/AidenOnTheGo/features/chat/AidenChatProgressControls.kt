@file:OptIn(
    androidx.compose.foundation.layout.ExperimentalLayoutApi::class,
    androidx.compose.material3.ExperimentalMaterial3Api::class
)

package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.Pending
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sbtbiswas.AidenOnTheGo.models.AidenChatAgent
import sbtbiswas.AidenOnTheGo.models.AidenChatAgentRole
import sbtbiswas.AidenOnTheGo.models.AidenChatAgentRoster
import sbtbiswas.AidenOnTheGo.models.AidenChatAgentState
import sbtbiswas.AidenOnTheGo.models.AidenChatAgentUnavailableReason
import sbtbiswas.AidenOnTheGo.models.AidenChatProgressAvailability
import sbtbiswas.AidenOnTheGo.models.AidenChatTask
import sbtbiswas.AidenOnTheGo.models.AidenChatTaskProgress
import sbtbiswas.AidenOnTheGo.models.AidenChatTaskStatus
import sbtbiswas.AidenOnTheGo.models.AidenChatTaskUnavailableReason
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi

@Composable
fun AidenChatProgressControls(
    taskProgress: AidenChatTaskProgress?,
    currentRoster: AidenChatAgentRoster?,
    rosterHistory: List<AidenChatAgentRoster>,
    connectionState: AidenChatViewModel.ProgressConnectionState,
    onTasksClick: () -> Unit,
    onAgentsClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val tasks = taskProgress?.takeIf { it.availability == AidenChatProgressAvailability.READY }
        ?.tasks
        ?.filter { it.status != AidenChatTaskStatus.DELETED }
        .orEmpty()
    val agents = currentRoster?.takeIf { it.availability == AidenChatProgressAvailability.READY }
        ?.agents
        .orEmpty()
    val hasEarlierAgents = currentRoster?.previousTurns?.isNotEmpty() == true ||
        rosterHistory.any { it.previousTurns.isNotEmpty() || it.agents.isNotEmpty() && it.turnId != currentRoster?.turnId }
    val taskAvailabilityNote = taskProgress?.unavailableReason?.let(::taskUnavailableMessage)
    val agentAvailabilityNote = currentRoster?.unavailableReason?.let(::agentUnavailableMessage)
    var sawIncompleteTasks by remember { mutableStateOf(false) }
    var observedTaskEpoch by remember { mutableStateOf<String?>(null) }
    var announceCompletion by remember { mutableStateOf(false) }
    val taskEpoch = taskProgress?.epoch
    val allTasksCompleted = tasks.isNotEmpty() && tasks.all { it.status == AidenChatTaskStatus.COMPLETED }
    LaunchedEffect(taskEpoch, taskProgress?.revision) {
        val sameEpoch = observedTaskEpoch == null || observedTaskEpoch == taskEpoch
        if (sameEpoch && sawIncompleteTasks && allTasksCompleted) announceCompletion = true
        sawIncompleteTasks = tasks.any { it.status != AidenChatTaskStatus.COMPLETED }
        observedTaskEpoch = taskEpoch
    }
    LaunchedEffect(announceCompletion) {
        if (announceCompletion) {
            delay(2_000)
            announceCompletion = false
        }
    }
    // Keep the completion chip mounted for the short polite-live announcement
    // window; initial all-complete snapshots never set announceCompletion.
    val showTaskChip = tasks.any { it.status != AidenChatTaskStatus.COMPLETED } || announceCompletion
    if (!showTaskChip && agents.isEmpty() && !hasEarlierAgents &&
        taskAvailabilityNote == null && agentAvailabilityNote == null &&
        connectionState != AidenChatViewModel.ProgressConnectionState.LAST_KNOWN
    ) return

    Column(modifier = modifier) {
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (showTaskChip) {
                val currentIndex = tasks.indexOfFirst { it.status == AidenChatTaskStatus.IN_PROGRESS }
                val completed = tasks.count { it.status == AidenChatTaskStatus.COMPLETED }
                val title = if (currentIndex >= 0) {
                    "Step ${currentIndex + 1} / ${tasks.size}"
                } else {
                    "$completed / ${tasks.size} steps"
                }
                val activeTask = tasks.firstOrNull { it.status == AidenChatTaskStatus.IN_PROGRESS }
                AidenProgressChip(
                    icon = Icons.Default.TaskAlt,
                    label = title,
                    supportingLabel = activeTask?.activeForm ?: activeTask?.subject,
                    description = "Open task progress",
                    onClick = onTasksClick
                )
            }
            if (agents.isNotEmpty() || hasEarlierAgents) {
                AidenProgressChip(
                    icon = Icons.Default.Groups,
                    label = if (agents.isNotEmpty()) {
                        "${agents.size} agent${if (agents.size == 1) "" else "s"}"
                    } else {
                        "Earlier agents"
                    },
                    description = "Open agent progress",
                    onClick = onAgentsClick
                )
            }
            if (connectionState == AidenChatViewModel.ProgressConnectionState.LAST_KNOWN) {
                Spacer(modifier = Modifier.width(2.dp))
                Icon(Icons.Default.CloudOff, contentDescription = null, tint = palette.secondary)
                Text(
                    text = "Last known",
                    style = MaterialTheme.typography.labelSmall,
                    color = palette.secondary
                )
            }
        }
        listOfNotNull(taskAvailabilityNote, agentAvailabilityNote).takeIf { it.isNotEmpty() }?.let { messages ->
            Text(
                text = messages.joinToString(" · "),
                style = MaterialTheme.typography.labelSmall,
                color = palette.secondary,
                modifier = Modifier.padding(top = 4.dp),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
        if (announceCompletion) {
            Text(
                text = "All task steps complete",
                style = MaterialTheme.typography.labelSmall,
                color = palette.secondary,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
            )
        }
    }
}

@Composable
private fun AidenProgressChip(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    supportingLabel: String? = null,
    description: String,
    onClick: () -> Unit
) {
    val palette = AidenTheme.palette
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier
            .heightIn(min = AidenUi.MinimumTouchTarget)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics {
                role = Role.Button
                contentDescription = "$description: $label"
            }
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = palette.accent, modifier = Modifier.height(18.dp))
                Spacer(modifier = Modifier.width(7.dp))
                Text(label, style = MaterialTheme.typography.labelLarge, color = palette.foreground)
            }
            supportingLabel?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.labelSmall,
                    color = palette.secondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

@Composable
fun AidenTaskProgressSheet(
    progress: AidenChatTaskProgress,
    onDismiss: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = AidenTheme.palette.raised
    ) {
        AidenTaskProgressContent(progress)
    }
}

@Composable
private fun AidenTaskProgressContent(progress: AidenChatTaskProgress) {
    val palette = AidenTheme.palette
    val tasks = progress.tasks.filter { it.status != AidenChatTaskStatus.DELETED }
    val listState = rememberLazyListState()
    val didPinToEnd = rememberSaveable(progress.epoch) { mutableStateOf(false) }
    LaunchedEffect(progress.epoch, tasks.size) {
        if (AidenChatScroll.shouldPinTaskList(didPinToEnd.value, tasks.size)) {
            listState.scrollToItem(AidenChatScroll.taskListEndIndex(tasks.size))
            didPinToEnd.value = true
        }
    }
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
        Text("Task progress", style = MaterialTheme.typography.headlineSmall, color = palette.foreground, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.height(6.dp))
        Text(
            text = "${tasks.count { it.status == AidenChatTaskStatus.COMPLETED }} of ${tasks.size} steps complete",
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary
        )
        Spacer(modifier = Modifier.height(14.dp))
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            items(tasks, key = { it.id }) { task ->
                AidenTaskRow(task)
            }
        }
    }
}

@Composable
private fun AidenTaskRow(task: AidenChatTask) {
    val palette = AidenTheme.palette
    val (icon, statusLabel, tint) = when (task.status) {
        AidenChatTaskStatus.COMPLETED -> Triple(Icons.Default.CheckCircle, "Completed", palette.success)
        AidenChatTaskStatus.IN_PROGRESS -> Triple(Icons.Default.PlayArrow, "In progress", palette.accent)
        AidenChatTaskStatus.PENDING -> Triple(Icons.Default.Pending, "Pending", palette.secondary)
        AidenChatTaskStatus.DELETED -> Triple(Icons.Default.ErrorOutline, "Deleted", palette.secondary)
    }
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = statusLabel, tint = tint, modifier = Modifier.height(20.dp))
            Spacer(modifier = Modifier.width(10.dp))
            Text(task.subject, style = MaterialTheme.typography.bodyMedium, color = palette.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Row(modifier = Modifier.padding(start = 30.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(statusLabel, style = MaterialTheme.typography.labelSmall, color = palette.secondary)
            if (task.status == AidenChatTaskStatus.IN_PROGRESS && task.activeForm != null) {
                Text(" · ${task.activeForm}", style = MaterialTheme.typography.labelSmall, color = palette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (!task.blockedBy.isNullOrEmpty()) {
                Text(" · Blocked by ${task.blockedBy.joinToString()}", style = MaterialTheme.typography.labelSmall, color = palette.secondary)
            }
        }
    }
}

@Composable
fun AidenAgentRosterSheet(
    currentRoster: AidenChatAgentRoster,
    selectedRoster: AidenChatAgentRoster,
    history: List<AidenChatAgentRoster>,
    onSelectTurn: (String?) -> Unit,
    onAgentClick: (AidenChatAgent) -> Unit,
    onDismiss: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = AidenTheme.palette.raised
    ) {
        AidenAgentRosterContent(currentRoster, selectedRoster, history, onSelectTurn, onAgentClick)
    }
}

@Composable
private fun AidenAgentRosterContent(
    currentRoster: AidenChatAgentRoster,
    selectedRoster: AidenChatAgentRoster,
    history: List<AidenChatAgentRoster>,
    onSelectTurn: (String?) -> Unit,
    onAgentClick: (AidenChatAgent) -> Unit
) {
    val palette = AidenTheme.palette
    val agents = selectedRoster.agents
    val working = agents.filter { it.state in setOf(AidenChatAgentState.QUEUED, AidenChatAgentState.STARTING, AidenChatAgentState.RUNNING) }
    val attention = agents.filter { it.state == AidenChatAgentState.NEEDS_ATTENTION }
    val finished = agents.filter { it.state in setOf(AidenChatAgentState.COMPLETED, AidenChatAgentState.FAILED, AidenChatAgentState.TIMED_OUT, AidenChatAgentState.INTERRUPTED, AidenChatAgentState.STOPPED, AidenChatAgentState.UNKNOWN) }
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
        Text("Agents", style = MaterialTheme.typography.headlineSmall, color = palette.foreground, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.height(10.dp))
        val historicalSnapshots = history.filter { roster ->
            roster.turnId != null && roster.turnId != currentRoster.turnId
        }
        val historicalSnapshotIds = historicalSnapshots.mapNotNull { it.turnId }.toSet()
        val hiddenTurnIds = historicalSnapshotIds + listOfNotNull(currentRoster.turnId)
        val turnOptions = buildList {
            currentRoster.previousTurns.forEach(::add)
            history.forEach { roster -> roster.previousTurns.forEach(::add) }
        }.distinctBy { it.turnId }.filterNot { it.turnId in hiddenTurnIds }
        if (history.size > 1 || turnOptions.isNotEmpty()) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 10.dp)) {
                item {
                    Surface(
                        color = if (selectedRoster.epoch == currentRoster.epoch && selectedRoster.turnId == currentRoster.turnId) {
                            MaterialTheme.colorScheme.primaryContainer
                        } else {
                            MaterialTheme.colorScheme.surfaceContainerLow
                        },
                        shape = MaterialTheme.shapes.large,
                        modifier = Modifier
                            .heightIn(min = AidenUi.MinimumTouchTarget)
                            .clickable(role = Role.Button) { onSelectTurn(null) }
                            .semantics { role = Role.Button }
                    ) {
                        Text(
                            text = "Current",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (selectedRoster.epoch == currentRoster.epoch && selectedRoster.turnId == currentRoster.turnId) palette.accent else palette.foreground,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 13.dp)
                        )
                    }
                }
                items(historicalSnapshots, key = { "snapshot:${it.epoch}:${it.turnId}" }) { roster ->
                    val isSelected = roster.epoch == selectedRoster.epoch && roster.turnId == selectedRoster.turnId
                    AidenRosterTurnChoice(
                        label = roster.agents.firstOrNull()?.startedAt?.let { "Earlier · ${formatRosterDate(it)}" }
                            ?: "Earlier session",
                        isSelected = isSelected,
                        onClick = { onSelectTurn(roster.turnId) }
                    )
                }
                items(turnOptions, key = { "previous:${it.turnId}" }) { turn ->
                    val isSelected = selectedRoster.turnId == turn.turnId
                    AidenRosterTurnChoice(
                        label = "Earlier · ${formatRosterDate(turn.startedAt)}",
                        isSelected = isSelected,
                        onClick = { onSelectTurn(turn.turnId) }
                    )
                }
            }
        }
        LazyColumn(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            if (working.isNotEmpty()) {
                item { AidenAgentGroupLabel("Working") }
                items(working, key = { it.agentId }) { agent -> AidenAgentRow(agent, onAgentClick) }
            }
            if (attention.isNotEmpty()) {
                item { AidenAgentGroupLabel("Needs attention") }
                items(attention, key = { it.agentId }) { agent -> AidenAgentRow(agent, onAgentClick) }
            }
            if (finished.isNotEmpty()) {
                item { AidenAgentGroupLabel("Finished") }
                items(finished, key = { it.agentId }) { agent -> AidenAgentRow(agent, onAgentClick) }
            }
            if (agents.isEmpty()) {
                item {
                    Text(
                        text = selectedRoster.unavailableReason?.let { agentUnavailableMessage(it) }
                            ?: if (turnOptions.isNotEmpty() || historicalSnapshots.isNotEmpty()) {
                                "No agents in this session. Choose an earlier session above."
                            } else {
                                "No agents in this session."
                            },
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary,
                        modifier = Modifier.padding(vertical = 12.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun AidenRosterTurnChoice(
    label: String,
    isSelected: Boolean,
    onClick: () -> Unit
) {
    Surface(
        color = if (isSelected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier
            .heightIn(min = AidenUi.MinimumTouchTarget)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { role = Role.Button }
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = if (isSelected) AidenTheme.palette.accent else AidenTheme.palette.foreground,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 13.dp)
        )
    }
}

private fun formatRosterDate(instant: java.time.Instant): String =
    java.time.format.DateTimeFormatter.ofPattern("MMM d")
        .withZone(java.time.ZoneId.systemDefault())
        .format(instant)

private fun taskUnavailableMessage(reason: AidenChatTaskUnavailableReason): String? = when (reason) {
    AidenChatTaskUnavailableReason.STORAGE_NOT_ENABLED -> "Task tracking is off on the Mac"
    AidenChatTaskUnavailableReason.INVALID_SNAPSHOT -> "Task progress is temporarily unavailable"
    AidenChatTaskUnavailableReason.UNSUPPORTED -> null
}

private fun agentUnavailableMessage(reason: AidenChatAgentUnavailableReason): String? = when (reason) {
    AidenChatAgentUnavailableReason.INVALID_SNAPSHOT -> "Agent progress is temporarily unavailable"
    AidenChatAgentUnavailableReason.UNSUPPORTED -> null
}

@Composable
private fun AidenAgentGroupLabel(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = AidenTheme.palette.secondary, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp, bottom = 3.dp))
}

@Composable
private fun AidenAgentRow(agent: AidenChatAgent, onClick: (AidenChatAgent) -> Unit) {
    val palette = AidenTheme.palette
    val icon = when (agent.state) {
        AidenChatAgentState.COMPLETED -> Icons.Default.CheckCircle
        AidenChatAgentState.FAILED, AidenChatAgentState.TIMED_OUT -> Icons.Default.ErrorOutline
        AidenChatAgentState.NEEDS_ATTENTION -> Icons.Default.ErrorOutline
        AidenChatAgentState.QUEUED, AidenChatAgentState.STARTING -> Icons.Default.HourglassEmpty
        AidenChatAgentState.INTERRUPTED, AidenChatAgentState.STOPPED -> Icons.Default.Cancel
        AidenChatAgentState.UNKNOWN -> Icons.AutoMirrored.Filled.HelpOutline
        AidenChatAgentState.RUNNING -> Icons.Default.PlayArrow
    }
    val status = agentStateLabel(agent.state)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = AidenUi.MinimumTouchTarget)
            .clickable(role = Role.Button) { onClick(agent) }
            .semantics { role = Role.Button; contentDescription = "${agent.label}, $status" }
            .padding(vertical = 8.dp, horizontal = ((agent.depth - 1).coerceAtMost(4) * 12).dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, contentDescription = null, tint = palette.accent, modifier = Modifier.height(20.dp))
        Spacer(modifier = Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(agent.label, style = MaterialTheme.typography.bodyMedium, color = palette.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${roleLabel(agent.role)} · $status${agent.activity?.let { " · $it" } ?: ""}", style = MaterialTheme.typography.labelSmall, color = palette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
fun AidenAgentDetailSheet(
    agent: AidenChatAgent,
    onDismiss: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = AidenTheme.palette.raised
    ) {
        val palette = AidenTheme.palette
        Column(modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 32.dp)) {
            Text(agent.label, style = MaterialTheme.typography.headlineSmall, color = palette.foreground, fontWeight = FontWeight.SemiBold)
            Spacer(modifier = Modifier.height(6.dp))
            Text("${roleLabel(agent.role)} · ${agentStateLabel(agent.state)}", style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
            agent.activity?.let {
                Spacer(modifier = Modifier.height(14.dp))
                Text(it, style = MaterialTheme.typography.bodyLarge, color = palette.foreground)
            }
            Spacer(modifier = Modifier.height(16.dp))
            Text("${agent.turns} turns · ${agent.tools} tools · ${agent.tokens} tokens", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            Spacer(modifier = Modifier.height(6.dp))
            Text("Updated ${agent.updatedAt}", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            if (agent.notices?.contains(sbtbiswas.AidenOnTheGo.models.AidenChatAgentNotice.DISPLAY_FILTERED) == true) {
                Spacer(modifier = Modifier.height(12.dp))
                Text("Some details are hidden for privacy.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            }
        }
    }
}

private fun roleLabel(role: AidenChatAgentRole): String = when (role) {
    AidenChatAgentRole.SCOUT -> "Scout"
    AidenChatAgentRole.PLANNER -> "Planner"
    AidenChatAgentRole.REVIEWER -> "Reviewer"
}

private fun agentStateLabel(state: AidenChatAgentState): String = when (state) {
    AidenChatAgentState.QUEUED -> "Queued"
    AidenChatAgentState.STARTING -> "Starting"
    AidenChatAgentState.RUNNING -> "Working"
    AidenChatAgentState.NEEDS_ATTENTION -> "Needs attention"
    AidenChatAgentState.COMPLETED -> "Completed"
    AidenChatAgentState.FAILED -> "Failed"
    AidenChatAgentState.TIMED_OUT -> "Timed out"
    AidenChatAgentState.INTERRUPTED -> "Interrupted"
    AidenChatAgentState.STOPPED -> "Stopped"
    AidenChatAgentState.UNKNOWN -> "Unknown"
}
