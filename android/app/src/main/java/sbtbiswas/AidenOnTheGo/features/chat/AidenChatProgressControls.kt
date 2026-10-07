@file:OptIn(
    androidx.compose.foundation.layout.ExperimentalLayoutApi::class,
    androidx.compose.material3.ExperimentalMaterial3Api::class
)

package sbtbiswas.AidenOnTheGo.features.chat

import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.activity.findViewTreeOnBackPressedDispatcherOwner
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalView
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import sbtbiswas.AidenOnTheGo.models.AidenAgentNavigation
import sbtbiswas.AidenOnTheGo.models.AidenAgentNavigationScope
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.TextButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.key
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.selected
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
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupOrientation
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenGroupItemShape
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource
import sbtbiswas.AidenOnTheGo.R

internal enum class AidenTaskStepTone { DONE, ACTIVE, PENDING }

/** Segments of the task sheet's connected step bar. Long plans fold into [MAX_SEGMENTS] buckets. */
internal object AidenTaskStepBar {
    const val MAX_SEGMENTS = 12

    fun segments(
        statuses: List<AidenChatTaskStatus>,
        maxSegments: Int = MAX_SEGMENTS
    ): List<AidenTaskStepTone> {
        val visible = statuses.filter { it != AidenChatTaskStatus.DELETED }
        if (visible.isEmpty() || maxSegments <= 0) return emptyList()
        if (visible.size <= maxSegments) return visible.map { tone(listOf(it)) }
        return List(maxSegments) { bucket ->
            val from = bucket * visible.size / maxSegments
            val to = (bucket + 1) * visible.size / maxSegments
            tone(visible.subList(from, to))
        }
    }

    fun completedFraction(statuses: List<AidenChatTaskStatus>): Float {
        val visible = statuses.filter { it != AidenChatTaskStatus.DELETED }
        if (visible.isEmpty()) return 0f
        return visible.count { it == AidenChatTaskStatus.COMPLETED }.toFloat() / visible.size
    }

    private fun tone(group: List<AidenChatTaskStatus>): AidenTaskStepTone = when {
        group.any { it == AidenChatTaskStatus.IN_PROGRESS } -> AidenTaskStepTone.ACTIVE
        group.all { it == AidenChatTaskStatus.COMPLETED } -> AidenTaskStepTone.DONE
        else -> AidenTaskStepTone.PENDING
    }
}

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
    val taskAvailabilityNote = taskProgress?.unavailableReason?.let { taskUnavailableMessage(it) }
    val agentAvailabilityNote = currentRoster?.unavailableReason?.let { agentUnavailableMessage(it) }
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
                    stringResource(R.string.chat_progress_step, currentIndex + 1, tasks.size)
                } else {
                    stringResource(R.string.chat_progress_steps_done, completed, tasks.size)
                }
                val activeTask = tasks.firstOrNull { it.status == AidenChatTaskStatus.IN_PROGRESS }
                AidenProgressChip(
                    icon = Icons.Default.TaskAlt,
                    label = title,
                    supportingLabel = activeTask?.activeForm ?: activeTask?.subject,
                    description = stringResource(R.string.chat_progress_open_tasks_cd),
                    onClick = onTasksClick
                )
            }
            if (agents.isNotEmpty() || hasEarlierAgents) {
                AidenProgressChip(
                    icon = Icons.Default.Groups,
                    label = if (agents.isNotEmpty()) {
                        pluralStringResource(R.plurals.chat_progress_agent_count, agents.size, agents.size)
                    } else {
                        stringResource(R.string.chat_progress_earlier_agents)
                    },
                    description = stringResource(R.string.chat_progress_open_agents_cd),
                    onClick = onAgentsClick
                )
            }
            if (connectionState == AidenChatViewModel.ProgressConnectionState.LAST_KNOWN) {
                Spacer(modifier = Modifier.width(2.dp))
                Icon(Icons.Default.CloudOff, contentDescription = null, tint = palette.secondary)
                Text(
                    text = stringResource(R.string.chat_progress_last_known),
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
                text = stringResource(R.string.chat_progress_all_complete),
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
    val chipDescription = if (supportingLabel != null) {
        stringResource(R.string.chat_progress_chip_supporting_cd, description, label, supportingLabel)
    } else {
        stringResource(R.string.chat_progress_chip_cd, description, label)
    }
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = CircleShape,
        modifier = Modifier
            .heightIn(min = AidenUi.MinimumTouchTarget)
            .shadow(
                elevation = 2.dp,
                shape = CircleShape,
                ambientColor = Color.Black.copy(alpha = 0.08f),
                spotColor = Color.Black.copy(alpha = 0.08f)
            )
            .clickable(role = Role.Button, onClick = onClick)
            .semantics {
                role = Role.Button
                contentDescription = chipDescription
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
    var didPinToEnd by remember(listState) { mutableStateOf(false) }
    var followLatest by remember(listState) { mutableStateOf(true) }
    val taskFollowKey = AidenChatScroll.taskListFollowKey(tasks)
    LaunchedEffect(listState) {
        var wasScrolling = false
        snapshotFlow {
            // Live layout state only: `tasks` captured here would go stale after updates.
            val layout = listState.layoutInfo
            val last = layout.visibleItemsInfo.lastOrNull()
            listState.isScrollInProgress to AidenChatScroll.isFollowingTaskListEnd(
                lastVisibleItemIndex = last?.index ?: -1,
                lastVisibleItemEndOffset = last?.let { it.offset + it.size } ?: 0,
                viewportContentEndOffset = layout.viewportEndOffset - layout.afterContentPadding,
                totalItemCount = layout.totalItemsCount,
            )
        }.collect { (scrolling, atEnd) ->
            if (scrolling) {
                wasScrolling = true
                followLatest = atEnd
            } else if (wasScrolling) {
                wasScrolling = false
                followLatest = atEnd
            }
        }
    }
    LaunchedEffect(progress.epoch, taskFollowKey) {
        if (AidenChatScroll.shouldPinTaskList(didPinToEnd, tasks.size)) {
            listState.scrollToItem(AidenChatScroll.taskListEndIndex(tasks.size))
            didPinToEnd = true
            followLatest = true
            return@LaunchedEffect
        }
        if (AidenChatScroll.shouldPinLatestAfterContentChange(followLatest) && tasks.isNotEmpty()) {
            listState.scrollToItem(AidenChatScroll.taskListEndIndex(tasks.size))
            followLatest = true
        }
    }
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
        Text(stringResource(R.string.chat_progress_task_title), style = MaterialTheme.typography.headlineSmall, color = palette.foreground, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.height(6.dp))
        Text(
            text = pluralStringResource(R.plurals.chat_progress_steps_complete, tasks.size, tasks.count { it.status == AidenChatTaskStatus.COMPLETED }, tasks.size),
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary
        )
        Spacer(modifier = Modifier.height(12.dp))
        AidenTaskStepProgressBar(tasks.map { it.status })
        Spacer(modifier = Modifier.height(12.dp))
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
private fun AidenTaskStepProgressBar(statuses: List<AidenChatTaskStatus>) {
    val segments = AidenTaskStepBar.segments(statuses)
    if (segments.isEmpty()) return
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val fraction = AidenTaskStepBar.completedFraction(statuses)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(6.dp)
            .semantics { progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f) },
        horizontalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
    ) {
        segments.forEachIndexed { index, tone ->
            val fill by animateColorAsState(
                targetValue = when (tone) {
                    AidenTaskStepTone.DONE -> palette.success
                    AidenTaskStepTone.ACTIVE -> palette.accent
                    AidenTaskStepTone.PENDING -> MaterialTheme.colorScheme.surfaceContainerHighest
                },
                animationSpec = AidenMotion.nonSpatial(reduceMotion),
                label = "task_step_fill"
            )
            Spacer(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clip(
                        aidenGroupItemShape(
                            index,
                            segments.size,
                            outer = 3.dp,
                            inner = 1.dp,
                            orientation = AidenGroupOrientation.HORIZONTAL
                        )
                    )
                    .background(fill)
            )
        }
    }
}

@Composable
private fun AidenTaskRow(task: AidenChatTask) {
    val palette = AidenTheme.palette
    val (icon, statusLabel, tint) = when (task.status) {
        AidenChatTaskStatus.COMPLETED -> Triple(Icons.Default.CheckCircle, stringResource(R.string.chat_task_completed), palette.success)
        AidenChatTaskStatus.IN_PROGRESS -> Triple(Icons.Default.PlayArrow, stringResource(R.string.chat_task_in_progress), palette.accent)
        AidenChatTaskStatus.PENDING -> Triple(Icons.Default.Pending, stringResource(R.string.chat_task_pending), palette.secondary)
        AidenChatTaskStatus.DELETED -> Triple(Icons.Default.ErrorOutline, stringResource(R.string.chat_task_deleted), palette.secondary)
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
                Text(" · " + stringResource(R.string.chat_task_blocked_by, task.blockedBy.joinToString()), style = MaterialTheme.typography.labelSmall, color = palette.secondary)
            }
        }
    }
}

@Composable
fun AidenAgentRosterSheet(
    currentRoster: AidenChatAgentRoster?,
    selectedRoster: AidenChatAgentRoster?,
    history: List<AidenChatAgentRoster>,
    onSelectTurn: (String?) -> Unit,
    onAgentClick: (AidenChatAgent) -> Unit = {},
    onDismiss: () -> Unit,
    instanceId: String? = "",
    deviceId: String? = "",
    requested: Boolean = true,
    // Null means negotiation is still loading, not an authoritative denial.
    canRead: Boolean? = true,
    chatId: String = selectedRoster?.chatId.orEmpty(),
    stopControl: (AidenChatAgent) -> AidenAgentStopControl = { AidenAgentStopControl.HIDDEN },
    onStop: (AidenChatAgent) -> Unit = {}
) {
    // This owner is always composed by the chat screen, even while the sheet
    // is hidden for negotiation or roster loading. Save intent independently
    // of the conditional ModalBottomSheet so process restoration can wait.
    var savedNavigation by rememberSaveable { mutableStateOf<String?>(null) }
    val navigation = remember(savedNavigation) {
        savedNavigation?.let { runCatching { Json.decodeFromString<AidenAgentNavigation>(it) }.getOrNull() }
    }
    val identityChanged = navigation != null && (
        navigation.scope.instanceId != instanceId || navigation.scope.deviceId != deviceId ||
            navigation.scope.chatId != chatId
    )
    val invalidated = instanceId == null || deviceId == null || identityChanged || canRead == false
    LaunchedEffect(requested, invalidated) {
        if (!requested || invalidated) savedNavigation = null
        if (requested && invalidated) onDismiss()
    }
    if (!requested || invalidated || canRead != true || selectedRoster == null || currentRoster == null) return

    val navigationScope = AidenAgentNavigationScope(requireNotNull(instanceId), requireNotNull(deviceId), chatId, selectedRoster.epoch, selectedRoster.turnId)
    val current = (navigation ?: AidenAgentNavigation(navigationScope)).reconcile(navigationScope, selectedRoster.agents)
    val save: (AidenAgentNavigation) -> Unit = { savedNavigation = Json.encodeToString(it) }
    LaunchedEffect(current) { save(current) }
    val agent = selectedRoster.agents.firstOrNull { it.agentId == current.path.lastOrNull() }
    val openAgent: (AidenChatAgent) -> Unit = {
        save(current.open(it.agentId, selectedRoster.agents))
        onAgentClick(it)
    }
    val back = { save(current.back() ?: current) }
    val dismiss = { savedNavigation = null; onDismiss() }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = dismiss,
        sheetState = sheetState,
        containerColor = AidenTheme.palette.raised
    ) {
        // The sheet is a ComponentDialog with its own back dispatcher. Bind
        // inside that window so system Back pops details, while scrim/drag dismiss.
        CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides requireNotNull(LocalView.current.findViewTreeOnBackPressedDispatcherOwner())) {
            BackHandler(enabled = agent != null) { back() }
            if (agent == null) {
                AidenAgentRosterContent(currentRoster, selectedRoster, history, { turnId ->
                    savedNavigation = null
                    onSelectTurn(turnId)
                }, openAgent)
            } else {
                key(agent.agentId) {
                    AidenAgentDetailContent(agent, selectedRoster.agents, openAgent, back, stopControl(agent)) { onStop(agent) }
                }
            }
        }
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
        Text(stringResource(R.string.chat_agents_title), style = MaterialTheme.typography.headlineSmall, color = palette.foreground, fontWeight = FontWeight.SemiBold)
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
            val choices = buildList {
                add(
                    AidenRosterTurnOption(
                        key = "current",
                        label = stringResource(R.string.chat_agents_current),
                        isSelected = selectedRoster.epoch == currentRoster.epoch && selectedRoster.turnId == currentRoster.turnId,
                        turnId = null
                    )
                )
                historicalSnapshots.forEach { roster ->
                    add(
                        AidenRosterTurnOption(
                            key = "snapshot:${roster.epoch}:${roster.turnId}",
                            label = roster.agents.firstOrNull()?.startedAt?.let { stringResource(R.string.chat_agents_earlier_on, formatRosterDate(it)) }
                                ?: stringResource(R.string.chat_agents_earlier_session),
                            isSelected = roster.epoch == selectedRoster.epoch && roster.turnId == selectedRoster.turnId,
                            turnId = roster.turnId
                        )
                    )
                }
                turnOptions.forEach { turn ->
                    add(
                        AidenRosterTurnOption(
                            key = "previous:${turn.turnId}",
                            label = stringResource(R.string.chat_agents_earlier_on, formatRosterDate(turn.startedAt)),
                            isSelected = selectedRoster.turnId == turn.turnId,
                            turnId = turn.turnId
                        )
                    )
                }
            }
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(AidenShape.GroupGap),
                contentPadding = PaddingValues(bottom = 10.dp)
            ) {
                itemsIndexed(choices, key = { _, choice -> choice.key }) { index, choice ->
                    AidenRosterTurnChoice(
                        label = choice.label,
                        isSelected = choice.isSelected,
                        index = index,
                        count = choices.size,
                        onClick = { onSelectTurn(choice.turnId) }
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
                item { AidenAgentGroupLabel(stringResource(R.string.chat_agents_group_working)) }
                items(working, key = { it.agentId }) { agent -> AidenAgentRow(agent, onAgentClick) }
            }
            if (attention.isNotEmpty()) {
                item { AidenAgentGroupLabel(stringResource(R.string.chat_agents_group_attention)) }
                items(attention, key = { it.agentId }) { agent -> AidenAgentRow(agent, onAgentClick) }
            }
            if (finished.isNotEmpty()) {
                item { AidenAgentGroupLabel(stringResource(R.string.chat_agents_group_finished)) }
                items(finished, key = { it.agentId }) { agent -> AidenAgentRow(agent, onAgentClick) }
            }
            if (agents.isEmpty()) {
                item {
                    Text(
                        text = selectedRoster.unavailableReason?.let { agentUnavailableMessage(it) }
                            ?: if (turnOptions.isNotEmpty() || historicalSnapshots.isNotEmpty()) {
                                stringResource(R.string.chat_agents_none_choose_earlier)
                            } else {
                                stringResource(R.string.chat_agents_none)
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

private data class AidenRosterTurnOption(
    val key: String,
    val label: String,
    val isSelected: Boolean,
    val turnId: String?
)

/** One pill in the connected turn selector; selection is a tonal fill, never a border. */
@Composable
private fun AidenRosterTurnChoice(
    label: String,
    isSelected: Boolean,
    index: Int,
    count: Int,
    onClick: () -> Unit
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val fill by animateColorAsState(
        targetValue = if (isSelected) palette.accent.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHigh,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "roster_turn_fill"
    )
    val ink by animateColorAsState(
        targetValue = if (isSelected) palette.accent else palette.foreground,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "roster_turn_ink"
    )
    val interaction = remember { MutableInteractionSource() }
    Surface(
        color = fill,
        shape = aidenGroupItemShape(index, count, orientation = AidenGroupOrientation.HORIZONTAL),
        modifier = Modifier
            .heightIn(min = AidenUi.MinimumTouchTarget)
            .tactilePress(interaction)
            .clickable(
                interactionSource = interaction,
                indication = androidx.compose.material3.ripple(),
                role = Role.Button,
                onClick = onClick
            )
            .semantics {
                role = Role.Button
                selected = isSelected
            }
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
            color = ink,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 15.dp)
        )
    }
}

private fun formatRosterDate(instant: java.time.Instant): String =
    java.time.format.DateTimeFormatter.ofPattern("MMM d")
        .withZone(java.time.ZoneId.systemDefault())
        .format(instant)

@Composable
private fun taskUnavailableMessage(reason: AidenChatTaskUnavailableReason): String? = when (reason) {
    AidenChatTaskUnavailableReason.STORAGE_NOT_ENABLED -> stringResource(R.string.chat_tasks_storage_off)
    AidenChatTaskUnavailableReason.INVALID_SNAPSHOT -> stringResource(R.string.chat_tasks_unavailable)
    AidenChatTaskUnavailableReason.UNSUPPORTED -> null
}

@Composable
private fun agentUnavailableMessage(reason: AidenChatAgentUnavailableReason): String? = when (reason) {
    AidenChatAgentUnavailableReason.INVALID_SNAPSHOT -> stringResource(R.string.chat_agents_unavailable)
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
    val rowDescription = stringResource(R.string.chat_agent_row_cd, agent.label, status)
    val roleAndStatus = listOfNotNull(roleLabel(agent.role), status, agent.activity).joinToString(" · ")
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = AidenUi.MinimumTouchTarget)
            .clickable(role = Role.Button) { onClick(agent) }
            .semantics { role = Role.Button; contentDescription = rowDescription }
            .padding(vertical = 8.dp, horizontal = ((agent.depth - 1).coerceAtMost(4) * 12).dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, contentDescription = null, tint = palette.accent, modifier = Modifier.height(20.dp))
        Spacer(modifier = Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(agent.label, style = MaterialTheme.typography.bodyMedium, color = palette.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(roleAndStatus, style = MaterialTheme.typography.labelSmall, color = palette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Whether the agent detail sheet offers Stop, and whether a stop is in flight. */
enum class AidenAgentStopControl { HIDDEN, AVAILABLE, STOPPING }

@Composable
private fun AidenAgentDetailContent(
    agent: AidenChatAgent,
    agents: List<AidenChatAgent>,
    openAgent: (AidenChatAgent) -> Unit,
    onBack: () -> Unit,
    stopControl: AidenAgentStopControl,
    onStop: () -> Unit
) {
    var confirmsStop by remember(agent.agentId) { mutableStateOf(false) }
    val palette = AidenTheme.palette
    Column(modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 32.dp)) {
        TextButton(onClick = onBack) { Text(stringResource(R.string.action_back), color = palette.foreground) }
        agents.firstOrNull { it.agentId == agent.parentAgentId }?.let { parent ->
            val parentDescription = stringResource(R.string.chat_agent_open_parent_cd, parent.label)
            TextButton(onClick = { openAgent(parent) }, modifier = Modifier.semantics { contentDescription = parentDescription }) {
                Text(stringResource(R.string.chat_agent_started_by, parent.label), color = palette.foreground)
            }
        }
        Text(agent.label, style = MaterialTheme.typography.headlineSmall, color = palette.foreground, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.height(6.dp))
        Text("${roleLabel(agent.role)} · ${agentStateLabel(agent.state)}", style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
        agent.activity?.let {
            Spacer(modifier = Modifier.height(14.dp))
            Text(it, style = MaterialTheme.typography.bodyLarge, color = palette.foreground)
        }
        Spacer(modifier = Modifier.height(16.dp))
        Text(aidenAgentStats(agent), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        Spacer(modifier = Modifier.height(6.dp))
        Text(stringResource(R.string.chat_agent_updated, agent.updatedAt.toString()), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        if (agent.notices?.contains(sbtbiswas.AidenOnTheGo.models.AidenChatAgentNotice.DISPLAY_FILTERED) == true) {
            Spacer(modifier = Modifier.height(12.dp))
            Text(stringResource(R.string.chat_agent_privacy_hidden), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        }
        val children = AidenAgentNavigation.children(agent.agentId, agents)
        if (children.isNotEmpty()) {
            Text(stringResource(R.string.chat_agent_sub_agents), style = MaterialTheme.typography.titleMedium, color = palette.foreground)
            children.forEach { child -> AidenAgentRow(child, openAgent) }
        }
        if (stopControl != AidenAgentStopControl.HIDDEN) {
            Spacer(modifier = Modifier.height(20.dp))
            TextButton(
                onClick = { confirmsStop = true },
                enabled = stopControl == AidenAgentStopControl.AVAILABLE
            ) {
                Text(
                    if (stopControl == AidenAgentStopControl.STOPPING) stringResource(R.string.chat_agent_stopping) else stringResource(R.string.chat_agent_stop),
                    color = if (stopControl == AidenAgentStopControl.AVAILABLE) palette.danger else palette.secondary
                )
            }
            Text(
                stringResource(R.string.chat_agent_stop_note),
                style = MaterialTheme.typography.bodySmall,
                color = palette.secondary
            )
        }
    }
    if (confirmsStop) {
        val palette = AidenTheme.palette
        AlertDialog(
            onDismissRequest = { confirmsStop = false },
            title = { Text(stringResource(R.string.chat_agent_stop_title, agent.label), fontWeight = FontWeight.Bold) },
            text = {
                Text(
                    stringResource(R.string.chat_agent_stop_body),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary
                )
            },
            confirmButton = {
                AidenDialogConfirmButton(
                    text = stringResource(R.string.chat_agent_stop),
                    onClick = {
                        confirmsStop = false
                        onStop()
                    },
                    destructive = true
                )
            },
            dismissButton = {
                AidenDialogDismissButton(text = stringResource(R.string.chat_agent_keep_running), onClick = { confirmsStop = false })
            },
            shape = AidenShape.Dialog,
            containerColor = palette.raised
        )
    }
}

/** "3 turns · 5 tools · 1,200 tokens" for an agent's detail header. */
@Composable
private fun aidenAgentStats(agent: AidenChatAgent): String = listOf(
    pluralStringResource(R.plurals.chat_agent_turns, agent.turns.toPluralQuantity(), agent.turns),
    pluralStringResource(R.plurals.chat_agent_tools, agent.tools.toPluralQuantity(), agent.tools),
    pluralStringResource(R.plurals.chat_agent_tokens, agent.tokens.toPluralQuantity(), agent.tokens)
).joinToString(" · ")

/** Plural quantities are Ints; any count past Int range selects the same "other" form. */
private fun Long.toPluralQuantity(): Int = coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()

@Composable
private fun roleLabel(role: AidenChatAgentRole): String = stringResource(
    when (role) {
        AidenChatAgentRole.SCOUT -> R.string.chat_agent_role_scout
        AidenChatAgentRole.PLANNER -> R.string.chat_agent_role_planner
        AidenChatAgentRole.REVIEWER -> R.string.chat_agent_role_reviewer
        AidenChatAgentRole.IMPLEMENTER -> R.string.chat_agent_role_implementer
    }
)

@Composable
private fun agentStateLabel(state: AidenChatAgentState): String = stringResource(
    when (state) {
        AidenChatAgentState.QUEUED -> R.string.chat_agent_state_queued
        AidenChatAgentState.STARTING -> R.string.chat_agent_state_starting
        AidenChatAgentState.RUNNING -> R.string.chat_agent_state_working
        AidenChatAgentState.NEEDS_ATTENTION -> R.string.chat_agent_state_needs_attention
        AidenChatAgentState.COMPLETED -> R.string.chat_agent_state_completed
        AidenChatAgentState.FAILED -> R.string.chat_agent_state_failed
        AidenChatAgentState.TIMED_OUT -> R.string.chat_agent_state_timed_out
        AidenChatAgentState.INTERRUPTED -> R.string.chat_agent_state_interrupted
        AidenChatAgentState.STOPPED -> R.string.chat_agent_state_stopped
        AidenChatAgentState.UNKNOWN -> R.string.chat_agent_state_unknown
    }
)
