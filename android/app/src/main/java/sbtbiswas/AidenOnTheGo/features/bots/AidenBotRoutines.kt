package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.outlined.WbSunny
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.annotation.StringRes
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
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

/** The routine editor's first choice. */
enum class AidenBotRoutineFrequency(@StringRes val label: Int) {
    ONCE(R.string.bot_routine_once),
    DAILY(R.string.bot_routine_daily),
    WEEKDAYS(R.string.bot_routine_weekdays),
    WEEKLY(R.string.bot_routine_weekly),
    MONTHLY(R.string.bot_routine_monthly)
}

/** Sunday-first short day names; the index is the wire day (Sunday = 0). */
val AIDEN_BOT_ROUTINE_DAY_LABELS = listOf(
    R.string.bot_routine_day_sun,
    R.string.bot_routine_day_mon,
    R.string.bot_routine_day_tue,
    R.string.bot_routine_day_wed,
    R.string.bot_routine_day_thu,
    R.string.bot_routine_day_fri,
    R.string.bot_routine_day_sat
)

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
        fun from(routine: AidenBotRoutine): AidenBotRoutineDraft =
            scheduled(AidenBotRoutineDraft(name = routine.name, message = routine.message), routine.schedule)

        /** The editor prefilled from a suggestion (the daily check-in); nothing exists until Save. */
        fun from(suggestion: AidenBotRoutineSuggestion): AidenBotRoutineDraft =
            scheduled(
                AidenBotRoutineDraft(
                    name = suggestion.name.take(AidenBotRoutineWire.MAX_NAME_LENGTH),
                    message = suggestion.prompt.take(AidenBotRoutineWire.MAX_MESSAGE_LENGTH)
                ),
                suggestion.schedule
            )

        private fun scheduled(base: AidenBotRoutineDraft, schedule: AidenBotRoutineSchedule?): AidenBotRoutineDraft {
            if (schedule == null) return base
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

/** What a failed routine write means for the person, and whether the list is stale. */
data class AidenBotRoutineWriteFailure(val message: String, val reload: Boolean)

/**
 * A stale `If-Match` (`409 revision_conflict`) or a routine removed on the Mac means this
 * phone's copy is out of date: say so and reload, instead of failing every retry.
 */
fun aidenBotRoutineWriteFailure(error: Exception, fallback: String): AidenBotRoutineWriteFailure {
    val server = error as? AidenRemoteClientException.Server ?: return AidenBotRoutineWriteFailure(fallback, false)
    return when {
        server.statusCode == 409 && server.body.code == AidenRemoteErrorCode.REVISION_CONFLICT ->
            AidenBotRoutineWriteFailure("This routine changed on your Mac. Check it and try again.", true)
        server.statusCode == 404 ->
            AidenBotRoutineWriteFailure("This routine is no longer on your Mac.", true)
        else -> AidenBotRoutineWriteFailure(fallback, false)
    }
}

/**
 * Profile → Routines: each row shows the name and the Mac's own schedule label with an
 * enabled toggle, plus "+ Add routine".
 */
@Composable
fun AidenBotRoutinesSection(botId: String, client: AidenRemoteClient?, offersSuggestions: Boolean = false) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    var routines by remember(botId) { mutableStateOf<List<AidenBotRoutine>?>(null) }
    var error by remember(botId) { mutableStateOf<String?>(null) }
    var editing by remember(botId) { mutableStateOf<AidenBotRoutine?>(null) }
    var adding by remember(botId) { mutableStateOf(false) }
    // Revision 27: with no routines, "Try a daily check-in" opens the editor prefilled.
    var suggestions by remember(botId) { mutableStateOf<List<AidenBotRoutineSuggestion>>(emptyList()) }
    var addingDraft by remember(botId) { mutableStateOf<AidenBotRoutineDraft?>(null) }
    val togglingIds = remember(botId) { mutableStateListOf<String>() }
    val hasNoRoutines = routines?.isEmpty() == true

    LaunchedEffect(botId, client, offersSuggestions, hasNoRoutines) {
        val cl = client
        if (cl == null || !offersSuggestions || !hasNoRoutines) {
            suggestions = emptyList()
            return@LaunchedEffect
        }
        suggestions = try {
            cl.botRoutineSuggestions(botId).suggestions
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // A missing suggestion only hides the row.
            emptyList()
        }
    }

    /** Reloads the list; an open editor follows its routine's new revision. */
    suspend fun reload(cl: AidenRemoteClient, keepError: Boolean = false) {
        try {
            val fresh = cl.botRoutines(botId).routines
            routines = fresh
            editing = editing?.let { open -> fresh.firstOrNull { it.id == open.id } }
            if (!keepError) error = null
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            error = resources.getString(R.string.bot_routines_load_failed)
        }
    }

    LaunchedEffect(botId, client) {
        val cl = client ?: return@LaunchedEffect
        reload(cl)
    }

    fun replace(updated: AidenBotRoutine) {
        routines = routines.orEmpty().filterNot { it.id == updated.id } + updated
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.bot_routines_title), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = palette.secondary, modifier = Modifier.padding(horizontal = 4.dp))
        Surface(color = palette.raised, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
            Column {
                routines.orEmpty().forEachIndexed { index, routine ->
                    if (index > 0) HorizontalDivider(color = palette.canvas, modifier = Modifier.padding(start = 16.dp))
                    val toggleLabel = stringResource(R.string.bot_routine_toggle_cd, routine.name)
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
                                    } catch (e: Exception) {
                                        val failure = aidenBotRoutineWriteFailure(e, resources.getString(R.string.bot_routine_update_failed))
                                        error = failure.message
                                        if (failure.reload) reload(cl, keepError = true)
                                    } finally {
                                        togglingIds.remove(routine.id)
                                    }
                                }
                            },
                            modifier = Modifier.semantics { contentDescription = toggleLabel }
                        )
                    }
                }
                if (hasNoRoutines) {
                    suggestions.forEach { suggestion ->
                        TextButton(
                            onClick = {
                                addingDraft = AidenBotRoutineDraft.from(suggestion)
                                adding = true
                            },
                            enabled = client != null,
                            shape = AidenShape.Button,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp)
                        ) {
                            Icon(Icons.Outlined.WbSunny, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Column(Modifier.weight(1f)) {
                                Text(stringResource(R.string.bot_routine_suggestion_title), style = MaterialTheme.typography.bodyLarge, color = palette.foreground)
                                Text(suggestion.label, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                            }
                        }
                        HorizontalDivider(color = palette.canvas, modifier = Modifier.padding(start = 16.dp))
                    }
                }
                if (routines.orEmpty().isNotEmpty()) HorizontalDivider(color = palette.canvas, modifier = Modifier.padding(start = 16.dp))
                TextButton(
                    onClick = {
                        addingDraft = null
                        adding = true
                    },
                    enabled = client != null && routines != null,
                    shape = AidenShape.Button,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 4.dp)
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, tint = palette.accent, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.bot_routine_add), color = palette.accent, modifier = Modifier.weight(1f))
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
            initial = addingDraft.takeIf { editing == null },
            onDismiss = {
                adding = false
                addingDraft = null
                editing = null
            },
            onSaved = { saved ->
                replace(saved)
                adding = false
                addingDraft = null
                editing = null
            },
            onDeleted = { deletedId ->
                routines = routines.orEmpty().filterNot { it.id == deletedId }
                editing = null
            },
            onStale = { scope.launch { reload(cl, keepError = true) } }
        )
    }
}

@Composable
private fun AidenBotRoutineEditorDialog(
    botId: String,
    client: AidenRemoteClient,
    routine: AidenBotRoutine?,
    /** A new routine's starting point, such as the daily check-in suggestion. */
    initial: AidenBotRoutineDraft? = null,
    onDismiss: () -> Unit,
    onSaved: (AidenBotRoutine) -> Unit,
    onDeleted: (String) -> Unit,
    onStale: () -> Unit
) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    var draft by remember(routine?.id) {
        mutableStateOf(routine?.let { AidenBotRoutineDraft.from(it) } ?: initial ?: AidenBotRoutineDraft())
    }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // A retried Add of the same routine reuses its key, so it never makes two; a changed
    // routine is a new request with a new key.
    val createKeys = remember { AidenBotActionKeys() }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (routine == null) stringResource(R.string.bot_routine_new) else stringResource(R.string.bot_routine_edit)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                TextField(
                    value = draft.name,
                    onValueChange = { draft = draft.copy(name = it.take(AidenBotRoutineWire.MAX_NAME_LENGTH)) },
                    placeholder = { Text(stringResource(R.string.bot_field_name)) },
                    singleLine = true,
                    colors = aidenTextFieldColors(),
                    shape = MaterialTheme.shapes.large,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.fillMaxWidth()
                )
                Text(stringResource(R.string.bot_routine_how_often), style = MaterialTheme.typography.labelLarge, color = palette.secondary)
                val frequencyLabels = AidenBotRoutineFrequency.entries.associateWith { stringResource(it.label) }
                AidenSegmentedPillRow(
                    options = AidenBotRoutineFrequency.entries,
                    selected = draft.frequency,
                    label = { frequencyLabels.getValue(it) },
                    onSelect = { draft = draft.copy(frequency = it) }
                )
                when (draft.frequency) {
                    AidenBotRoutineFrequency.WEEKLY -> Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        AIDEN_BOT_ROUTINE_DAY_LABELS.forEachIndexed { day, labelRes ->
                            val label = stringResource(labelRes)
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
                        label = stringResource(R.string.bot_routine_day_of_month),
                        value = draft.dayOfMonth,
                        range = 1..28,
                        format = { it.toString() },
                        onChange = { draft = draft.copy(dayOfMonth = it) }
                    )
                    AidenBotRoutineFrequency.ONCE -> AidenBotRoutineStepper(
                        label = stringResource(R.string.bot_routine_date),
                        value = draft.date.toEpochDay().toInt(),
                        range = LocalDate.now().toEpochDay().toInt()..LocalDate.now().plusYears(2).toEpochDay().toInt(),
                        format = { LocalDate.ofEpochDay(it.toLong()).toString() },
                        onChange = { draft = draft.copy(date = LocalDate.ofEpochDay(it.toLong())) }
                    )
                    else -> {}
                }
                AidenBotRoutineStepper(
                    label = stringResource(R.string.bot_routine_time),
                    value = draft.hour * 60 + draft.minute,
                    range = 0..(23 * 60 + 45),
                    step = 15,
                    format = { "%02d:%02d".format(it / 60, it % 60) },
                    onChange = { draft = draft.copy(hour = it / 60, minute = it % 60) }
                )
                Text(stringResource(R.string.bot_routine_message_label), style = MaterialTheme.typography.labelLarge, color = palette.secondary)
                TextField(
                    value = draft.message,
                    onValueChange = { draft = draft.copy(message = it.take(AidenBotRoutineWire.MAX_MESSAGE_LENGTH)) },
                    placeholder = { Text(stringResource(R.string.bot_routine_message_placeholder)) },
                    minLines = 3,
                    colors = aidenTextFieldColors(),
                    shape = MaterialTheme.shapes.large,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.fillMaxWidth()
                )
                if (routine != null) {
                    AidenTonalButton(
                        text = stringResource(R.string.bot_routine_delete),
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
                                } catch (e: Exception) {
                                    val failure = aidenBotRoutineWriteFailure(e, resources.getString(R.string.bot_routine_delete_failed))
                                    error = failure.message
                                    if (failure.reload) onStale()
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
                text = if (busy) stringResource(R.string.action_saving) else stringResource(R.string.action_save),
                enabled = !busy && draft.canSave,
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            if (routine == null) {
                                val request = draft.createRequest(ZoneId.systemDefault().id) ?: return@launch
                                val action = request.toString()
                                try {
                                    val created = client.createBotRoutine(botId, request, createKeys.key(action))
                                    createKeys.complete(action)
                                    onSaved(created)
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    createKeys.failed(action, e)
                                    throw e
                                }
                            } else {
                                val update = draft.updateRequest(routine)
                                onSaved(if (update == null) routine else client.updateBotRoutine(botId, routine.id, routine.revision, update))
                            }
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            val failure = aidenBotRoutineWriteFailure(e, resources.getString(R.string.bot_routine_save_failed))
                            error = failure.message
                            if (failure.reload) onStale()
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
            Icon(Icons.Default.Remove, contentDescription = stringResource(R.string.bot_routine_earlier_cd, label))
        }
        Text(format(value), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = palette.foreground)
        IconButton(onClick = { onChange((value + step).coerceIn(range)) }, enabled = value + step <= range.last) {
            Icon(Icons.Default.Add, contentDescription = stringResource(R.string.bot_routine_later_cd, label))
        }
    }
}
