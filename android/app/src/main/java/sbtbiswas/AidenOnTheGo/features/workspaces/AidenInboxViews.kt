package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
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
import sbtbiswas.AidenOnTheGo.models.AidenInboxSection
import sbtbiswas.AidenOnTheGo.models.AidenSnoozeOption
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.AidenWorkingIndicator
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToInt

/** What an Inbox row's trailing status says, as on iOS and the desktop. */
data class AidenInboxRowStatus(
    val label: String? = null,
    val spokenLabel: String? = null,
    val tone: Tone,
    val wait: String? = null
) {
    enum class Tone { WARNING, DANGER, WORKING, PLAIN }

    companion object {
        fun make(
            row: AidenInboxRow,
            now: Instant,
            zone: ZoneId = ZoneId.systemDefault(),
            locale: Locale = Locale.getDefault()
        ): AidenInboxRowStatus {
            val chat = row.summary
            return when (row.placement.section) {
                AidenInboxSection.NEEDS_YOU -> {
                    val since = chat.attentionSince ?: chat.lastAssistantAt ?: chat.updatedAt
                    val wait = AidenInboxDuration.text(since, now)
                    when (row.placement.tier) {
                        AidenInbox.TIER_APPROVAL -> AidenInboxRowStatus("Approval", tone = Tone.WARNING, wait = wait)
                        AidenInbox.TIER_INPUT -> AidenInboxRowStatus("Question", tone = Tone.WARNING, wait = wait)
                        else -> AidenInboxRowStatus("Failed", tone = Tone.DANGER, wait = wait)
                    }
                }
                AidenInboxSection.WORKING -> AidenInboxRowStatus(
                    label = chat.runStartedAt?.let { "Working ${AidenInboxDuration.text(it, now)}" } ?: "Working",
                    tone = Tone.WORKING
                )
                AidenInboxSection.PINNED, AidenInboxSection.UPDATES, AidenInboxSection.EARLIER, null -> {
                    val snoozed = chat.snoozedUntil?.takeIf { it.isAfter(now) }
                    when {
                        chat.doneAt != null && snoozed == null -> AidenInboxRowStatus("Done", tone = Tone.PLAIN)
                        snoozed != null -> {
                            val text = DateTimeFormatter.ofPattern("EEE h:mm a", locale).withZone(zone).format(snoozed)
                            AidenInboxRowStatus("Until $text", "Snoozed until $text", Tone.PLAIN)
                        }
                        else -> AidenInboxRowStatus(tone = Tone.PLAIN, wait = AidenInboxDuration.text(row.placement.sortAt, now))
                    }
                }
            }
        }

        /** "Title, workspace, status, wait, Unread", as the desktop names it. */
        fun accessibilityName(title: String, workspaceName: String?, status: AidenInboxRowStatus, unread: Boolean): String =
            listOfNotNull(title, workspaceName, status.spokenLabel ?: status.label, status.wait, if (unread) "Unread" else null)
                .filter { it.isNotEmpty() }
                .joinToString(", ")
    }
}

/** The snackbar line for an Inbox notice, matching the iOS banner. */
object AidenInboxNoticeText {
    fun message(
        notice: AidenInboxNotice,
        now: Instant,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault()
    ): String = when (notice) {
        is AidenInboxNotice.Changed -> confirmation(notice.change, now, zone, locale)
        is AidenInboxNotice.Conflict -> "That chat changed on another device. The Inbox is up to date now."
        is AidenInboxNotice.TriageFailed -> "Couldn’t update that chat. It’s back where it was."
        is AidenInboxNotice.MarkReadFailed -> "Couldn’t mark that chat read. Try again once your Mac is reachable."
    }

    fun confirmation(change: AidenChatTriageChange, now: Instant, zone: ZoneId, locale: Locale): String {
        if (change.done == true) return "Marked done"
        val snooze = change.snooze
        if (snooze is AidenChatTriageChange.Snooze.Until) {
            val date = snooze.at.atZone(zone)
            val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(date)
            val day = if (date.toLocalDate() == LocalDate.ofInstant(now, zone)) "today"
            else date.dayOfWeek.getDisplayName(TextStyle.FULL, locale)
            return "Snoozed until $day at $time"
        }
        return "Updated"
    }

    fun optionTime(option: AidenSnoozeOption, zone: ZoneId, locale: Locale = Locale.getDefault()): String {
        val date = option.until.atZone(zone)
        return when (option.preset) {
            AidenSnoozeOption.Preset.HOUR, AidenSnoozeOption.Preset.EVENING ->
                DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(date)
            AidenSnoozeOption.Preset.TOMORROW, AidenSnoozeOption.Preset.NEXT_WEEK ->
                DateTimeFormatter.ofPattern("EEE h:mm a", locale).format(date)
        }
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
    offersMarkRead: Boolean,
    offersDone: Boolean,
    offersSnooze: Boolean,
    onOpen: () -> Unit,
    onMarkRead: () -> Unit,
    onDone: () -> Unit,
    onSnooze: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val chat = row.summary
    val title = chat.title.ifBlank { stringResource(R.string.workspace_new_chat) }
    val status = AidenInboxRowStatus.make(row, now)
    val name = AidenInboxRowStatus.accessibilityName(title, workspaceName, status, chat.unread)
    val markReadLabel = stringResource(R.string.inbox_action_mark_read)
    val doneLabel = stringResource(R.string.inbox_action_done)
    val snoozeLabel = stringResource(R.string.inbox_action_snooze)
    val openLabel = stringResource(R.string.inbox_action_open)
    val leading = buildList {
        if (offersMarkRead) add(AidenInboxSwipeAction(markReadLabel, Icons.Outlined.MarkEmailRead, palette.accent, "inbox_mark_read_${chat.id}", onMarkRead))
    }
    val trailing = buildList {
        if (offersDone) add(AidenInboxSwipeAction(doneLabel, Icons.Outlined.CheckCircle, palette.success, "inbox_done_${chat.id}", onDone))
        if (offersSnooze) add(AidenInboxSwipeAction(snoozeLabel, Icons.Outlined.Schedule, palette.warning, "inbox_snooze_${chat.id}", onSnooze))
    }
    AidenInboxSwipeRow(leading = leading, trailing = trailing, modifier = modifier.testTag("inbox_row_${chat.id}")) {
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
            if (status.tone == AidenInboxRowStatus.Tone.WORKING) AidenWorkingIndicator(size = 12.dp)
            status.label?.let { label ->
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
 * A row that slides to reveal its actions and settles open or closed. The
 * offset is logical, so the leading actions sit at the start in either
 * layout direction. Reduce Motion snaps instead of springing.
 */
@Composable
private fun AidenInboxSwipeRow(
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
        scope.launch {
            if (reduceMotion) offset.snapTo(target)
            else offset.animateTo(target, spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow))
        }
    }
    // A row that loses its actions (it moved section) closes.
    LaunchedEffect(leadingPx, trailingPx) {
        if (offset.value > leadingPx || offset.value < -trailingPx) offset.snapTo(0f)
    }
    val dragState = rememberDraggableState { delta ->
        scope.launch { offset.snapTo((offset.value + delta * direction).coerceIn(-trailingPx, leadingPx)) }
    }
    Box(modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        val shown = offset.value
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

/** What each Inbox row offers; the screen answers from the host's features. */
class AidenInboxRowOffers(
    val markRead: (AidenChatSummary) -> Boolean,
    val triage: (AidenChatSummary) -> Boolean
)

/**
 * The Inbox sections in the desktop's order, each under a header with its
 * count, with Show more under a capped Earlier. Done is offered unless the
 * row is already done; Snooze unless it is still snoozed on this phone.
 */
fun LazyListScope.aidenInboxItems(
    projection: AidenInboxProjection,
    workspaceNames: Map<String, String>,
    now: Instant,
    offers: AidenInboxRowOffers,
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
            val canTriage = offers.triage(chat)
            AidenInboxRowView(
                row = row,
                workspaceName = workspaceNames[chat.workspaceId],
                now = now,
                offersMarkRead = offers.markRead(chat),
                offersDone = canTriage && chat.doneAt == null,
                offersSnooze = canTriage && !AidenInbox.holdsSnooze(chat.snoozedUntil, now),
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
