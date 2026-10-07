package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSegmentedPillRow
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

/** The routine editor's first choice. */
enum class AidenBotRoutineFrequency(val label: String) {
    ONCE("Once"),
    DAILY("Every day"),
    WEEKDAYS("Weekdays"),
    WEEKLY("Weekly"),
    MONTHLY("Monthly")
}

/** Sunday-first short day names; the index is the wire day (Sunday = 0). */
val AIDEN_BOT_ROUTINE_DAY_LABELS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

/** Editable form of one routine, frequency first. */
data class AidenBotRoutineDraft(
    val name: String = "",
    val frequency: AidenBotRoutineFrequency = AidenBotRoutineFrequency.DAILY,
    val hour: Int = 8,
    val minute: Int = 0,
    val weekdays: Set<Int> = setOf(1),
    val dayOfMonth: Int = 1,
    val date: LocalDate = LocalDate.now(),
    val message: String = ""
) {
    val time: String get() = "%02d:%02d".format(hour, minute)

    fun schedule(): AidenBotRoutineSchedule? = try {
        when (frequency) {
            AidenBotRoutineFrequency.ONCE -> AidenBotRoutineSchedule.Once(date.toString(), time)
            AidenBotRoutineFrequency.DAILY -> AidenBotRoutineSchedule.Daily(time)
            AidenBotRoutineFrequency.WEEKDAYS -> AidenBotRoutineSchedule.Weekdays(time)
            AidenBotRoutineFrequency.WEEKLY -> AidenBotRoutineSchedule.Weekly(weekdays.sorted(), time)
            AidenBotRoutineFrequency.MONTHLY -> AidenBotRoutineSchedule.Monthly(dayOfMonth, time)
        }
    } catch (_: AidenBotContractException) {
        null
    }

    val canSave: Boolean
        get() = name.isNotBlank() && message.isNotBlank() && schedule() != null

    fun createRequest(timezone: String): AidenBotRoutineCreateRequest? {
        val schedule = schedule() ?: return null
        if (!canSave) return null
        return AidenBotRoutineCreateRequest(
            name = name.trim().take(AidenBotRoutineWire.MAX_NAME_LENGTH),
            schedule = schedule,
            message = message.trim().take(AidenBotRoutineWire.MAX_MESSAGE_LENGTH),
            timezone = timezone
        )
    }

    /** Only the fields that differ from [routine]; null when nothing changed. */
    fun updateRequest(routine: AidenBotRoutine): AidenBotRoutineUpdateRequest? {
        val schedule = schedule() ?: return null
        if (!canSave) return null
        val nextName = name.trim().take(AidenBotRoutineWire.MAX_NAME_LENGTH)
        val nextMessage = message.trim().take(AidenBotRoutineWire.MAX_MESSAGE_LENGTH)
        val nameChanged = nextName != routine.name
        val messageChanged = nextMessage != routine.message
        val scheduleChanged = schedule != routine.schedule
        if (!nameChanged && !messageChanged && !scheduleChanged) return null
        return AidenBotRoutineUpdateRequest(
            name = nextName.takeIf { nameChanged },
            schedule = schedule.takeIf { scheduleChanged },
            message = nextMessage.takeIf { messageChanged }
        )
    }

    companion object {
        fun from(routine: AidenBotRoutine): AidenBotRoutineDraft {
            val base = AidenBotRoutineDraft(name = routine.name, message = routine.message)
            val schedule = routine.schedule ?: return base
            val (hour, minute) = schedule.time.split(":").map { it.toInt() }
            val timed = base.copy(hour = hour, minute = minute)
            return when (schedule) {
                is AidenBotRoutineSchedule.Once -> timed.copy(frequency = AidenBotRoutineFrequency.ONCE, date = LocalDate.parse(schedule.date))
                is AidenBotRoutineSchedule.Daily -> timed.copy(frequency = AidenBotRoutineFrequency.DAILY)
                is AidenBotRoutineSchedule.Weekdays -> timed.copy(frequency = AidenBotRoutineFrequency.WEEKDAYS)
                is AidenBotRoutineSchedule.Weekly -> timed.copy(frequency = AidenBotRoutineFrequency.WEEKLY, weekdays = schedule.days.toSet())
                is AidenBotRoutineSchedule.Monthly -> timed.copy(frequency = AidenBotRoutineFrequency.MONTHLY, dayOfMonth = schedule.day)
            }
        }
    }
}

/**
 * Profile → Routines: each row shows the name and the Mac's own schedule label with an
 * enabled toggle, plus "+ Add routine".
 */
@Composable
fun AidenBotRoutinesSection(botId: String, client: AidenRemoteClient?) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    var routines by remember(botId) { mutableStateOf<List<AidenBotRoutine>?>(null) }
    var error by remember(botId) { mutableStateOf<String?>(null) }
    var editing by remember(botId) { mutableStateOf<AidenBotRoutine?>(null) }
    var adding by remember(botId) { mutableStateOf(false) }
    val togglingIds = remember(botId) { mutableStateListOf<String>() }

    LaunchedEffect(botId, client) {
        val cl = client ?: return@LaunchedEffect
        try {
            routines = cl.botRoutines(botId).routines
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            error = "Aiden couldn’t load routines."
        }
    }

    fun replace(updated: AidenBotRoutine) {
        routines = routines.orEmpty().filterNot { it.id == updated.id } + updated
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Routines", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = palette.secondary, modifier = Modifier.padding(horizontal = 4.dp))
        Surface(color = palette.raised, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
            Column {
                routines.orEmpty().forEachIndexed { index, routine ->
                    if (index > 0) HorizontalDivider(color = palette.canvas, modifier = Modifier.padding(start = 16.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 4.dp, end = 16.dp)
                    ) {
                        TextButton(onClick = { editing = routine }, modifier = Modifier.weight(1f), shape = AidenShape.Button) {
                            Column(Modifier.fillMaxWidth()) {
                                Text(routine.name, style = MaterialTheme.typography.bodyLarge, color = palette.foreground)
                                Text(routine.label, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                            }
                        }
                        Switch(
                            checked = routine.enabled,
                            enabled = client != null && routine.id !in togglingIds,
                            onCheckedChange = { checked ->
                                val cl = client ?: return@Switch
                                togglingIds.add(routine.id)
                                scope.launch {
                                    try {
                                        replace(cl.updateBotRoutine(botId, routine.id, routine.revision, AidenBotRoutineUpdateRequest(enabled = checked)))
                                        error = null
                                    } catch (e: CancellationException) {
                                        throw e
                                    } catch (_: Exception) {
                                        error = "Aiden couldn’t update this routine. Try again."
                                    } finally {
                                        togglingIds.remove(routine.id)
                                    }
                                }
                            },
                            modifier = Modifier.semantics { contentDescription = "${routine.name} on" }
                        )
                    }
                }
                if (routines.orEmpty().isNotEmpty()) HorizontalDivider(color = palette.canvas, modifier = Modifier.padding(start = 16.dp))
                TextButton(
                    onClick = { adding = true },
                    enabled = client != null && routines != null,
                    shape = AidenShape.Button,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 4.dp)
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, tint = palette.accent, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Add routine", color = palette.accent, modifier = Modifier.weight(1f))
                }
            }
        }
        error?.let { Text(it, color = palette.danger, style = MaterialTheme.typography.bodySmall) }
    }

    val cl = client
    if (cl != null && (adding || editing != null)) {
        AidenBotRoutineEditorDialog(
            botId = botId,
            client = cl,
            routine = editing,
            onDismiss = {
                adding = false
                editing = null
            },
            onSaved = { saved ->
                replace(saved)
                adding = false
                editing = null
            },
            onDeleted = { deletedId ->
                routines = routines.orEmpty().filterNot { it.id == deletedId }
                editing = null
            }
        )
    }
}

@Composable
private fun AidenBotRoutineEditorDialog(
    botId: String,
    client: AidenRemoteClient,
    routine: AidenBotRoutine?,
    onDismiss: () -> Unit,
    onSaved: (AidenBotRoutine) -> Unit,
    onDeleted: (String) -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    var draft by remember(routine?.id) { mutableStateOf(routine?.let(AidenBotRoutineDraft::from) ?: AidenBotRoutineDraft()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // One key per editor session so a retried Add never makes two routines.
    val createKey = remember { UUID.randomUUID() }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (routine == null) "New routine" else "Edit routine") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                TextField(
                    value = draft.name,
                    onValueChange = { draft = draft.copy(name = it.take(AidenBotRoutineWire.MAX_NAME_LENGTH)) },
                    placeholder = { Text("Name") },
                    singleLine = true,
                    colors = aidenTextFieldColors(),
                    shape = RoundedCornerShape(16.dp),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.fillMaxWidth()
                )
                Text("How often?", style = MaterialTheme.typography.labelLarge, color = palette.secondary)
                AidenSegmentedPillRow(
                    options = AidenBotRoutineFrequency.entries,
                    selected = draft.frequency,
                    label = { it.label },
                    onSelect = { draft = draft.copy(frequency = it) }
                )
                when (draft.frequency) {
                    AidenBotRoutineFrequency.WEEKLY -> Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        AIDEN_BOT_ROUTINE_DAY_LABELS.forEachIndexed { day, label ->
                            val selected = day in draft.weekdays
                            FilterChip(
                                selected = selected,
                                onClick = {
                                    val next = if (selected) draft.weekdays - day else draft.weekdays + day
                                    if (next.isNotEmpty()) draft = draft.copy(weekdays = next)
                                },
                                label = { Text(label.take(2)) },
                                border = null
                            )
                        }
                    }
                    AidenBotRoutineFrequency.MONTHLY -> AidenBotRoutineStepper(
                        label = "Day of the month",
                        value = draft.dayOfMonth,
                        range = 1..31,
                        format = { it.toString() },
                        onChange = { draft = draft.copy(dayOfMonth = it) }
                    )
                    AidenBotRoutineFrequency.ONCE -> AidenBotRoutineStepper(
                        label = "Date",
                        value = draft.date.toEpochDay().toInt(),
                        range = LocalDate.now().toEpochDay().toInt()..LocalDate.now().plusYears(2).toEpochDay().toInt(),
                        format = { LocalDate.ofEpochDay(it.toLong()).toString() },
                        onChange = { draft = draft.copy(date = LocalDate.ofEpochDay(it.toLong())) }
                    )
                    else -> {}
                }
                AidenBotRoutineStepper(
                    label = "Time",
                    value = draft.hour * 60 + draft.minute,
                    range = 0..(23 * 60 + 45),
                    step = 15,
                    format = { "%02d:%02d".format(it / 60, it % 60) },
                    onChange = { draft = draft.copy(hour = it / 60, minute = it % 60) }
                )
                Text("What should it do?", style = MaterialTheme.typography.labelLarge, color = palette.secondary)
                TextField(
                    value = draft.message,
                    onValueChange = { draft = draft.copy(message = it.take(AidenBotRoutineWire.MAX_MESSAGE_LENGTH)) },
                    placeholder = { Text("Give me a short brief for today") },
                    minLines = 3,
                    colors = aidenTextFieldColors(),
                    shape = RoundedCornerShape(16.dp),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.fillMaxWidth()
                )
                if (routine != null) {
                    AidenTonalButton(
                        text = "Delete routine",
                        destructive = true,
                        enabled = !busy,
                        onClick = {
                            busy = true
                            scope.launch {
                                try {
                                    client.deleteBotRoutine(botId, routine.id, routine.revision)
                                    onDeleted(routine.id)
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (_: Exception) {
                                    error = "Aiden couldn’t delete this routine. Try again."
                                } finally {
                                    busy = false
                                }
                            }
                        }
                    )
                }
                error?.let { Text(it, color = palette.danger, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            AidenDialogConfirmButton(
                text = if (busy) "Saving…" else "Save",
                enabled = !busy && draft.canSave,
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            if (routine == null) {
                                val request = draft.createRequest(ZoneId.systemDefault().id) ?: return@launch
                                onSaved(client.createBotRoutine(botId, request, createKey))
                            } else {
                                val update = draft.updateRequest(routine)
                                onSaved(if (update == null) routine else client.updateBotRoutine(botId, routine.id, routine.revision, update))
                            }
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            error = "Aiden couldn’t save this routine. Try again."
                        } finally {
                            busy = false
                        }
                    }
                }
            )
        },
        dismissButton = { AidenDialogDismissButton(onClick = { if (!busy) onDismiss() }) },
        shape = AidenShape.Dialog,
        containerColor = palette.raised
    )
}

@Composable
private fun AidenBotRoutineStepper(
    label: String,
    value: Int,
    range: IntRange,
    step: Int = 1,
    format: (Int) -> String,
    onChange: (Int) -> Unit
) {
    val palette = AidenTheme.palette
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = palette.foreground, modifier = Modifier.weight(1f))
        IconButton(onClick = { onChange((value - step).coerceIn(range)) }, enabled = value - step >= range.first) {
            Icon(Icons.Default.Remove, contentDescription = "Earlier $label")
        }
        Text(format(value), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = palette.foreground)
        IconButton(onClick = { onChange((value + step).coerceIn(range)) }, enabled = value + step <= range.last) {
            Icon(Icons.Default.Add, contentDescription = "Later $label")
        }
    }
}
