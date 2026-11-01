package sbtbiswas.AidenOnTheGo.features.workspaces

import android.content.res.Resources
import android.view.accessibility.AccessibilityManager
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.MarkEmailRead
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageChange
import sbtbiswas.AidenOnTheGo.models.AidenInbox
import sbtbiswas.AidenOnTheGo.models.AidenInboxDuration
import sbtbiswas.AidenOnTheGo.models.AidenInboxProjection
import sbtbiswas.AidenOnTheGo.models.AidenInboxRow
import sbtbiswas.AidenOnTheGo.models.AidenInboxRowOffer
import sbtbiswas.AidenOnTheGo.models.AidenInboxSection
import sbtbiswas.AidenOnTheGo.models.AidenSnoozeOption
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.AidenWorkingIndicator
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.chrono.IsoChronology
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale
import java.util.UUID
import kotlin.math.roundToInt
import kotlin.math.sign

/**
 * What an Inbox row's trailing status says, as on iOS and the desktop. The
 * words come from strings.xml ([label], [spokenLabel]); [time] is the
 * snooze end or run length they carry.
 */
data class AidenInboxRowStatus(
    val kind: Kind? = null,
    val tone: Tone,
    val time: String? = null,
    val wait: String? = null
) {
    enum class Kind { APPROVAL, QUESTION, FAILED, WORKING, DONE, SNOOZED }
    enum class Tone { WARNING, DANGER, WORKING, PLAIN }

    fun label(res: Resources): String? = when (kind) {
        Kind.APPROVAL -> res.getString(R.string.inbox_status_approval)
        Kind.QUESTION -> res.getString(R.string.inbox_status_question)
        Kind.FAILED -> res.getString(R.string.inbox_status_failed)
        Kind.WORKING -> time?.let { res.getString(R.string.inbox_status_working_for, it) }
            ?: res.getString(R.string.inbox_status_working)
        Kind.DONE -> res.getString(R.string.inbox_status_done)
        Kind.SNOOZED -> res.getString(R.string.inbox_status_until, time)
        null -> null
    }

    fun spokenLabel(res: Resources): String? =
        if (kind == Kind.SNOOZED) res.getString(R.string.inbox_status_snoozed_until, time) else label(res)

    companion object {
        fun make(
            row: AidenInboxRow,
            now: Instant,
            zone: ZoneId = ZoneId.systemDefault(),
            locale: Locale = Locale.getDefault()
        ): AidenInboxRowStatus {
            val chat = row.summary
            return when (val section = row.placement.section) {
                AidenInboxSection.NEEDS_YOU -> {
                    val since = chat.attentionSince ?: chat.lastAssistantAt ?: chat.updatedAt
                    val wait = AidenInboxDuration.text(since, now)
                    when (row.placement.tier) {
                        AidenInbox.TIER_APPROVAL -> AidenInboxRowStatus(Kind.APPROVAL, Tone.WARNING, wait = wait)
                        AidenInbox.TIER_INPUT -> AidenInboxRowStatus(Kind.QUESTION, Tone.WARNING, wait = wait)
                        else -> AidenInboxRowStatus(Kind.FAILED, Tone.DANGER, wait = wait)
                    }
                }
                AidenInboxSection.WORKING -> AidenInboxRowStatus(
                    Kind.WORKING,
                    Tone.WORKING,
                    time = chat.runStartedAt?.let { AidenInboxDuration.text(it, now) }
                )
                AidenInboxSection.PINNED, AidenInboxSection.UPDATES, AidenInboxSection.EARLIER, null -> {
                    // Done comes first, as on the desktop: a row the host still
                    // holds done says so even while a snooze runs.
                    val snoozed = chat.snoozedUntil?.takeIf { AidenInbox.holdsSnooze(it, now) }
                    when {
                        AidenInbox.holdsDone(AidenInbox.Signals.of(chat, isOpen = false)) ->
                            AidenInboxRowStatus(Kind.DONE, Tone.PLAIN)
                        snoozed != null ->
                            AidenInboxRowStatus(Kind.SNOOZED, Tone.PLAIN, time = AidenInboxTimeText.weekdayTime(snoozed, zone, locale))
                        else -> {
                            // Updates wait on the reply; Pinned and Earlier on the last change.
                            val since = if (section == AidenInboxSection.UPDATES) chat.lastAssistantAt ?: chat.updatedAt
                            else chat.updatedAt
                            AidenInboxRowStatus(tone = Tone.PLAIN, wait = AidenInboxDuration.text(since, now))
                        }
                    }
                }
            }
        }

        /** "Title, workspace, status, wait, Unread", as the desktop names it. */
        fun accessibilityName(
            title: String,
            workspaceName: String?,
            spokenStatus: String?,
            wait: String?,
            unreadLabel: String?
        ): String =
            listOfNotNull(title, workspaceName, spokenStatus, wait, unreadLabel)
                .filter { it.isNotEmpty() }
                .joinToString(", ")
    }
}

/** Locale-aware Inbox times: the locale's short time, after a short weekday when it is not today. */
object AidenInboxTimeText {
    fun time(instant: Instant, zone: ZoneId, locale: Locale): String =
        DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).withZone(zone).format(instant)

    fun weekdayTime(instant: Instant, zone: ZoneId, locale: Locale): String {
        val timePattern = DateTimeFormatterBuilder.getLocalizedDateTimePattern(
            null, FormatStyle.SHORT, IsoChronology.INSTANCE, locale
        )
        return DateTimeFormatter.ofPattern("EEE $timePattern", locale).withZone(zone).format(instant)
    }
}

/** The snackbar line for an Inbox notice, matching the iOS banner. */
object AidenInboxNoticeText {
    /** What a landed change confirms, before it is worded. */
    sealed interface Confirmation {
        data object Done : Confirmation
        data class SnoozedToday(val time: String) : Confirmation
        data class SnoozedOn(val day: String, val time: String) : Confirmation
        data object Updated : Confirmation
    }

    fun message(
        res: Resources,
        notice: AidenInboxNotice,
        now: Instant,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault()
    ): String = when (notice) {
        is AidenInboxNotice.Changed -> when (val confirmation = confirmation(notice.change, now, zone, locale)) {
            Confirmation.Done -> res.getString(R.string.inbox_notice_done)
            is Confirmation.SnoozedToday -> res.getString(R.string.inbox_notice_snoozed_today, confirmation.time)
            is Confirmation.SnoozedOn -> res.getString(R.string.inbox_notice_snoozed_day, confirmation.day, confirmation.time)
            Confirmation.Updated -> res.getString(R.string.inbox_notice_updated)
        }
        is AidenInboxNotice.Conflict -> res.getString(R.string.inbox_notice_conflict)
        is AidenInboxNotice.TriageFailed -> res.getString(R.string.inbox_notice_triage_failed)
        is AidenInboxNotice.MarkReadFailed -> res.getString(R.string.inbox_notice_mark_read_failed)
    }

    fun confirmation(change: AidenChatTriageChange, now: Instant, zone: ZoneId, locale: Locale): Confirmation {
        if (change.done == true) return Confirmation.Done
        val snooze = change.snooze
        if (snooze is AidenChatTriageChange.Snooze.Until) {
            val date = snooze.at.atZone(zone)
            val time = AidenInboxTimeText.time(snooze.at, zone, locale)
            return if (date.toLocalDate() == LocalDate.ofInstant(now, zone)) Confirmation.SnoozedToday(time)
            else Confirmation.SnoozedOn(date.dayOfWeek.getDisplayName(TextStyle.FULL, locale), time)
        }
        return Confirmation.Updated
    }

    fun optionTime(option: AidenSnoozeOption, zone: ZoneId, locale: Locale = Locale.getDefault()): String =
        when (option.preset) {
            AidenSnoozeOption.Preset.HOUR, AidenSnoozeOption.Preset.EVENING ->
                AidenInboxTimeText.time(option.until, zone, locale)
            AidenSnoozeOption.Preset.TOMORROW, AidenSnoozeOption.Preset.NEXT_WEEK ->
                AidenInboxTimeText.weekdayTime(option.until, zone, locale)
        }
}

/**
 * Shows an Inbox notice as a snackbar, with Undo when the change can be put
 * back. Long enough to reach Undo; with TalkBack it stays until dismissed.
 * A confirmation first shown past its Undo window is dropped instead.
 * [onUndo] runs the inverse write; [onDismissed] gets the notice's id.
 */
@Composable
fun AidenInboxNoticeEffect(
    notice: AidenInboxNotice?,
    snackbarHostState: SnackbarHostState,
    onUndo: suspend (chatId: String, undo: AidenChatTriageChange) -> Unit,
    onDismissed: (UUID) -> Unit
) {
    val context = LocalContext.current
    val resources = context.resources
    val accessibilityManager = remember(context) { context.getSystemService(AccessibilityManager::class.java) }
    val undoLabel = stringResource(R.string.inbox_action_undo)
    val currentOnUndo by rememberUpdatedState(onUndo)
    val currentOnDismissed by rememberUpdatedState(onDismissed)
    LaunchedEffect(notice?.id) {
        val shown = notice ?: return@LaunchedEffect
        // Back on the screen after the Undo window: the confirmation is stale.
        if (shown is AidenInboxNotice.Changed && shown.isStale(Instant.now())) {
            currentOnDismissed(shown.id)
            return@LaunchedEffect
        }
        val undo = (shown as? AidenInboxNotice.Changed)?.undo
        val duration = if (accessibilityManager?.isTouchExplorationEnabled == true) SnackbarDuration.Indefinite
        else SnackbarDuration.Long
        val result = snackbarHostState.showSnackbar(
            message = AidenInboxNoticeText.message(resources, shown, Instant.now()),
            actionLabel = if (undo != null) undoLabel else null,
            withDismissAction = true,
            duration = duration
        )
        if (result == SnackbarResult.ActionPerformed && shown is AidenInboxNotice.Changed && undo != null) {
            currentOnUndo(shown.chatId, undo)
        }
        currentOnDismissed(shown.id)
    }
}

/** A small Beta capsule beside the Inbox title: secondary ink on a 12% fill. */
@Composable
fun AidenInboxBetaBadge(modifier: Modifier = Modifier) {
    val palette = AidenTheme.palette
    Text(
        stringResource(R.string.inbox_beta),
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.SemiBold,
        color = palette.secondary,
        modifier = modifier
            .background(palette.secondary.copy(alpha = 0.12f), RoundedCornerShape(50))
            .padding(horizontal = 7.dp, vertical = 2.dp)
    )
}

@Composable
fun AidenInboxSectionHeader(section: AidenInboxSection, count: Int, modifier: Modifier = Modifier) {
    val palette = AidenTheme.palette
    val title = stringResource(section.titleRes)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = modifier
            .fillMaxWidth()
            .padding(start = AidenUi.ScreenGutter + 8.dp, end = AidenUi.ScreenGutter, top = 14.dp, bottom = 4.dp)
            .semantics(mergeDescendants = true) { heading() }
    ) {
        if (section == AidenInboxSection.WORKING) AidenWorkingIndicator(size = 10.dp)
        Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = palette.secondary)
        Text(count.toString(), style = MaterialTheme.typography.labelMedium, color = palette.secondary.copy(alpha = 0.7f))
    }
}

internal val AidenInboxSection.titleRes: Int
    get() = when (this) {
        AidenInboxSection.NEEDS_YOU -> R.string.inbox_section_needs_you
        AidenInboxSection.PINNED -> R.string.inbox_section_pinned
        AidenInboxSection.UPDATES -> R.string.inbox_section_updates
        AidenInboxSection.EARLIER -> R.string.inbox_section_earlier
        AidenInboxSection.WORKING -> R.string.inbox_section_working
    }

/** One action behind a swiped Inbox row. */
data class AidenInboxSwipeAction(
    val label: String,
    val icon: ImageVector,
    val tint: Color,
    val testTag: String,
    val onClick: () -> Unit
)

/**
 * One compact Inbox row: unread dot, title, workspace, status and wait.
 * Swiping toward the end reveals Mark read; toward the start reveals Done
 * and Snooze. TalkBack gets the same actions as custom actions.
 */
@Composable
fun AidenInboxRowView(
    row: AidenInboxRow,
    workspaceName: String?,
    now: Instant,
    offer: AidenInboxRowOffer,
    onOpen: () -> Unit,
    onMarkRead: () -> Unit,
    onDone: () -> Unit,
    onSnooze: () -> Unit,
    modifier: Modifier = Modifier,
    swipe: AidenInboxSwipeState = remember { AidenInboxSwipeState() }
) {
    val palette = AidenTheme.palette
    val res = LocalContext.current.resources
    val chat = row.summary
    val title = chat.title.ifBlank { stringResource(R.string.workspace_new_chat) }
    val status = AidenInboxRowStatus.make(row, now)
    val statusLabel = status.label(res)
    val name = AidenInboxRowStatus.accessibilityName(
        title,
        workspaceName,
        status.spokenLabel(res),
        status.wait,
        if (chat.unread) stringResource(R.string.inbox_status_unread) else null
    )
    val workingLabel = stringResource(R.string.inbox_status_working)
    val markReadLabel = stringResource(R.string.inbox_action_mark_read)
    val doneLabel = stringResource(R.string.inbox_action_done)
    val snoozeLabel = stringResource(R.string.inbox_action_snooze)
    val openLabel = stringResource(R.string.inbox_action_open)
    val leading = buildList {
        if (offer.markRead) add(AidenInboxSwipeAction(markReadLabel, Icons.Outlined.MarkEmailRead, palette.accent, "inbox_mark_read_${chat.id}", onMarkRead))
    }
    val trailing = buildList {
        if (offer.done) add(AidenInboxSwipeAction(doneLabel, Icons.Outlined.CheckCircle, palette.success, "inbox_done_${chat.id}", onDone))
        if (offer.snooze) add(AidenInboxSwipeAction(snoozeLabel, Icons.Outlined.Schedule, palette.warning, "inbox_snooze_${chat.id}", onSnooze))
    }
    AidenInboxSwipeRow(
        key = chat.id,
        swipe = swipe,
        leading = leading,
        trailing = trailing,
        modifier = modifier.testTag("inbox_row_${chat.id}")
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clickable(onClick = onOpen)
                .clearAndSetSemantics {
                    contentDescription = name
                    role = Role.Button
                    onClick(label = openLabel) { onOpen(); true }
                    customActions = (leading + trailing).map { action ->
                        CustomAccessibilityAction(action.label) { action.onClick(); true }
                    }
                }
                .padding(horizontal = AidenUi.ScreenGutter + 8.dp, vertical = 7.dp)
        ) {
            Box(
                Modifier
                    .size(7.dp)
                    .background(if (chat.unread) palette.accent else Color.Transparent, CircleShape)
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    title,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (chat.unread) FontWeight.SemiBold else FontWeight.Medium,
                    color = palette.foreground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (!workspaceName.isNullOrEmpty()) {
                    Text(
                        workspaceName,
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            if (status.tone == AidenInboxRowStatus.Tone.WORKING) {
                AidenWorkingIndicator(size = 12.dp, contentDescription = workingLabel)
            }
            statusLabel?.let { label ->
                when (status.tone) {
                    AidenInboxRowStatus.Tone.WARNING, AidenInboxRowStatus.Tone.DANGER -> {
                        val tint = if (status.tone == AidenInboxRowStatus.Tone.DANGER) palette.danger else palette.warning
                        Text(
                            label,
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = tint,
                            maxLines = 1,
                            modifier = Modifier
                                .background(tint.copy(alpha = 0.12f), RoundedCornerShape(50))
                                .padding(horizontal = 7.dp, vertical = 2.dp)
                        )
                    }
                    AidenInboxRowStatus.Tone.WORKING, AidenInboxRowStatus.Tone.PLAIN ->
                        Text(label, style = MaterialTheme.typography.labelMedium, color = palette.secondary, maxLines = 1)
                }
            }
            status.wait?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = palette.secondary, maxLines = 1) }
        }
    }
}

private val SwipeActionWidth = 84.dp

/**
 * Which Inbox row is swiped open. Opening one row closes the others, as
 * in a mail list.
 */
@Stable
class AidenInboxSwipeState {
    var openKey by mutableStateOf<String?>(null)
}

/**
 * A row that slides to reveal its actions and settles open or closed. The
 * offset is logical, so the leading actions sit at the start in either
 * layout direction. Reduce Motion snaps instead of springing.
 */
@Composable
private fun AidenInboxSwipeRow(
    key: String,
    swipe: AidenInboxSwipeState,
    leading: List<AidenInboxSwipeAction>,
    trailing: List<AidenInboxSwipeAction>,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    val palette = AidenTheme.palette
    val density = LocalDensity.current
    val direction = if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1f else 1f
    val leadingPx = with(density) { (SwipeActionWidth * leading.size).toPx() }
    val trailingPx = with(density) { (SwipeActionWidth * trailing.size).toPx() }
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val reduceMotion = aidenReduceMotion()
    fun settle(target: Float) {
        if (target != 0f) swipe.openKey = key
        else if (swipe.openKey == key) swipe.openKey = null
        scope.launch { offset.animateTo(target, AidenMotion.spatial(reduceMotion)) }
    }
    // Another row opening closes this one.
    LaunchedEffect(swipe.openKey) {
        if (swipe.openKey != key && offset.value != 0f) offset.animateTo(0f, AidenMotion.spatial(reduceMotion))
    }
    // A row that loses its actions (it moved section) closes.
    LaunchedEffect(leadingPx, trailingPx) {
        if (offset.value > leadingPx || offset.value < -trailingPx) {
            offset.snapTo(0f)
            if (swipe.openKey == key) swipe.openKey = null
        }
    }
    val dragState = rememberDraggableState { delta ->
        scope.launch { offset.snapTo((offset.value + delta * direction).coerceIn(-trailingPx, leadingPx)) }
    }
    // Only the side that shows is read in composition; the offset itself is
    // read in the layout phase, so dragging doesn't recompose the row.
    val shown by remember { derivedStateOf { sign(offset.value) } }
    Box(modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        if (shown > 0f) {
            Row(Modifier.fillMaxHeight().fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
                leading.forEach { action -> AidenInboxSwipeButton(action) { settle(0f); action.onClick() } }
            }
        } else if (shown < 0f) {
            Row(Modifier.fillMaxHeight().fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                trailing.forEach { action -> AidenInboxSwipeButton(action) { settle(0f); action.onClick() } }
            }
        }
        Box(
            Modifier
                .offset { IntOffset((offset.value * direction).roundToInt(), 0) }
                .draggable(
                    state = dragState,
                    orientation = Orientation.Horizontal,
                    enabled = leading.isNotEmpty() || trailing.isNotEmpty(),
                    onDragStarted = { swipe.openKey = key },
                    onDragStopped = { velocity ->
                        val logicalVelocity = velocity * direction
                        val value = offset.value
                        val target = when {
                            value > 0f && (value > leadingPx / 2 || logicalVelocity > 1200f) -> leadingPx
                            value < 0f && (value < -trailingPx / 2 || logicalVelocity < -1200f) -> -trailingPx
                            else -> 0f
                        }
                        settle(target)
                    }
                )
                .background(palette.canvas)
        ) { content() }
    }
}

@Composable
private fun AidenInboxSwipeButton(action: AidenInboxSwipeAction, onClick: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = Modifier
            .width(SwipeActionWidth)
            .fillMaxHeight()
            .background(action.tint.copy(alpha = 0.16f))
            .clickable(onClickLabel = action.label, role = Role.Button, onClick = onClick)
            .testTag(action.testTag)
    ) {
        Icon(action.icon, contentDescription = null, tint = action.tint, modifier = Modifier.size(20.dp))
        Spacer(Modifier.height(2.dp))
        Text(action.label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = action.tint, maxLines = 1)
    }
}

/** The "Snooze until" chooser: the four presets, each with its time. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenInboxSnoozeSheet(
    now: Instant,
    onPick: (Instant) -> Unit,
    onDismiss: () -> Unit,
    zone: ZoneId = ZoneId.systemDefault()
) {
    val palette = AidenTheme.palette
    val options = remember(now, zone) { AidenSnoozeOption.options(now, zone) }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = palette.raised,
        shape = BottomSheetDefaults.ExpandedShape
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text(
                stringResource(R.string.inbox_snooze_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = palette.foreground,
                modifier = Modifier
                    .padding(horizontal = AidenUi.ScreenGutter + 4.dp, vertical = 8.dp)
                    .semantics { heading() }
            )
            options.forEach { option ->
                Surface(
                    onClick = { onPick(option.until) },
                    color = Color.Transparent,
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 8.dp)
                        .testTag("inbox_snooze_${option.preset.name.lowercase()}")
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter - 4.dp, vertical = 14.dp)
                    ) {
                        Text(
                            stringResource(option.preset.titleRes),
                            style = MaterialTheme.typography.bodyLarge,
                            color = palette.foreground,
                            modifier = Modifier.weight(1f)
                        )
                        Text(
                            AidenInboxNoticeText.optionTime(option, zone),
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.secondary
                        )
                    }
                }
            }
        }
    }
}

private val AidenSnoozeOption.Preset.titleRes: Int
    get() = when (this) {
        AidenSnoozeOption.Preset.HOUR -> R.string.inbox_snooze_hour
        AidenSnoozeOption.Preset.EVENING -> R.string.inbox_snooze_evening
        AidenSnoozeOption.Preset.TOMORROW -> R.string.inbox_snooze_tomorrow
        AidenSnoozeOption.Preset.NEXT_WEEK -> R.string.inbox_snooze_next_week
    }

/**
 * What the host lets Inbox rows offer: read markers, and triage with
 * chat:write. A value, so rows recompose when the host's features or the
 * negotiated access arrive after the list.
 */
@Immutable
data class AidenInboxRowOffers(
    val supportsReadState: Boolean = false,
    val supportsTriage: Boolean = false,
    val openChatId: String? = null
) {
    fun offer(summary: AidenChatSummary, now: Instant): AidenInboxRowOffer = AidenInbox.rowOffer(
        summary,
        isOpen = summary.id == openChatId,
        now = now,
        supportsReadState = supportsReadState,
        supportsTriage = supportsTriage
    )
}

/**
 * The Inbox sections in the desktop's order, each under a header with its
 * count, with Show more under a capped Earlier. Each row's swipe actions
 * follow [AidenInbox.rowOffer]; one row is swiped open at a time.
 */
fun LazyListScope.aidenInboxItems(
    projection: AidenInboxProjection,
    workspaceNames: Map<String, String>,
    now: Instant,
    offers: AidenInboxRowOffers,
    swipe: AidenInboxSwipeState,
    onOpen: (String) -> Unit,
    onMarkRead: (String) -> Unit,
    onDone: (String) -> Unit,
    onSnooze: (String) -> Unit,
    onShowMore: () -> Unit
) {
    AidenInboxSection.entries.forEach { section ->
        val rows = projection.rows(section)
        if (rows.isEmpty()) return@forEach
        item(key = "inbox-header-${section.name}", contentType = "inbox-header") {
            AidenInboxSectionHeader(section, rows.size)
        }
        items(rows, key = { "inbox-${it.id}" }, contentType = { "inbox-row" }) { row ->
            val chat = row.summary
            AidenInboxRowView(
                row = row,
                workspaceName = workspaceNames[chat.workspaceId],
                now = now,
                offer = offers.offer(chat, now),
                swipe = swipe,
                onOpen = { onOpen(chat.id) },
                onMarkRead = { onMarkRead(chat.id) },
                onDone = { onDone(chat.id) },
                onSnooze = { onSnooze(chat.id) }
            )
        }
        if (section == AidenInboxSection.EARLIER && projection.earlierOverflow > 0) {
            item(key = "inbox-show-more") {
                val palette = AidenTheme.palette
                Text(
                    pluralStringResource(R.plurals.workspace_home_show_more, projection.earlierOverflow, projection.earlierOverflow),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    color = palette.secondary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 44.dp)
                        .clickable(role = Role.Button, onClick = onShowMore)
                        .padding(start = AidenUi.ScreenGutter + 25.dp, top = 12.dp, bottom = 12.dp)
                )
            }
        }
    }
}
