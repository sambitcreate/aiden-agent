package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.NoteAdd
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.outlined.DeveloperBoard
import androidx.compose.material.icons.outlined.EventRepeat
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.GppMaybe
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.Power
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenApprovalDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalPresentation
import sbtbiswas.AidenOnTheGo.models.AidenApprovalSchedule
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScheduleLocation
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScheduleMode
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScheduleNote
import sbtbiswas.AidenOnTheGo.models.AidenApprovalSchedulePermission
import sbtbiswas.AidenOnTheGo.models.AidenApprovalSchedulePresentation
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScope
import sbtbiswas.AidenOnTheGo.models.AidenPendingApproval
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenGroupItemShape
import java.time.Instant

/** Lines the request shows before Show all. */
private const val COLLAPSED_LINES = 6

/** About ten lines: the most an expanded request takes before it scrolls. */
private val ExpandedRequestMaxHeight = 200.dp

/**
 * The share of the screen a scheduled-task card's details may take before they scroll, so the
 * card's actions and the composer stay on screen in the chat's bottom bar, which never scrolls.
 */
private const val SCHEDULE_BODY_SCREEN_SHARE = 0.45f

/**
 * The approval card's content, matching desktop and iOS: an icon tile, the action as a
 * question, the exact request in a code block, a short note, and two equal buttons with
 * the remembered scopes behind Allow's chevron. The caller owns the surface around it.
 *
 * A `schedule_task` approval that carries a revision 39 schedule card shows the task itself
 * instead of the summary: its name and cadence, where and with what access it runs, its
 * instructions, and notes. Its buttons and permission notes are the same as without a card.
 * [scheduleBodyMaxHeight] bounds those details; unspecified means a share of the screen.
 */
@Composable
internal fun AidenApprovalCardContent(
    approval: AidenPendingApproval,
    enabled: Boolean,
    onRespond: (AidenApprovalDecision, AidenApprovalScope) -> Unit,
    modifier: Modifier = Modifier,
    scheduleBodyMaxHeight: Dp = Dp.Unspecified,
    now: Instant? = null
) {
    val palette = AidenTheme.palette
    val isAutomation = AidenApprovalPresentation.isAutomation(approval.toolName)
    val schedule = AidenApprovalSchedule.forTool(approval.toolName, approval.schedule)
    val note = when {
        !approval.canRespond -> stringResource(R.string.chat_approval_review_only)
        isAutomation && !approval.hasRequiredWriteCapability -> stringResource(R.string.chat_approval_schedule_write_required)
        AidenApprovalPresentation.requiresDesktopConfirmation(approval) -> stringResource(R.string.chat_approval_confirm_on_desktop)
        !approval.canAllow -> stringResource(R.string.chat_approval_deny_only)
        // The schedule card ends with its own footer about where scheduled work runs.
        schedule != null -> null
        isAutomation -> stringResource(R.string.chat_approval_automation_note)
        else -> stringResource(R.string.chat_approval_paused_note)
    }

    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (schedule != null) {
            AidenScheduleApprovalBody(
                approvalId = approval.id,
                schedule = schedule,
                maxHeight = if (scheduleBodyMaxHeight == Dp.Unspecified) {
                    (LocalConfiguration.current.screenHeightDp * SCHEDULE_BODY_SCREEN_SHARE).dp
                } else {
                    scheduleBodyMaxHeight
                },
                now = now
            )
        } else {
            AidenApprovalHeader(
                icon = approvalIcon(approval.toolName),
                title = AidenApprovalPresentation.headline(approval.toolName, approval.summary)
            )
            Spacer(Modifier.height(14.dp))
            val request = if (isAutomation) {
                approval.summary.trim().ifEmpty { "Review requested action" }
            } else {
                AidenApprovalPresentation.requestedAction(approval.toolName, approval.summary)
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(palette.canvas, RoundedCornerShape(14.dp))
                    .padding(14.dp)
            ) {
                AidenApprovalFoldingText(text = request, resetKey = approval.id, monospace = true)
            }
        }
        if (note != null) {
            Spacer(Modifier.height(12.dp))
            Text(
                text = note,
                style = MaterialTheme.typography.bodySmall,
                color = palette.secondary,
                textAlign = TextAlign.Center
            )
        }
        if (approval.canRespond) {
            Spacer(Modifier.height(16.dp))
            AidenApprovalActions(approval = approval, enabled = enabled, onRespond = onRespond)
        }
    }
}

/** The decorative icon tile and the card's question, read first as its heading. */
@Composable
private fun AidenApprovalHeader(icon: ImageVector, title: String) {
    val palette = AidenTheme.palette
    Box(
        modifier = Modifier
            .size(44.dp)
            .background(palette.accentFill.fill, RoundedCornerShape(13.dp)),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = palette.accentFill.content,
            modifier = Modifier.size(22.dp)
        )
    }
    Spacer(Modifier.height(12.dp))
    Text(
        text = title,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
        color = palette.foreground,
        textAlign = TextAlign.Center,
        modifier = Modifier.semantics { heading() }
    )
}

/**
 * Long text folded at [COLLAPSED_LINES] behind Show all. Expanded, it scrolls in its own
 * bounded box with a Scroll for more cue, because the card can sit in the chat's bottom bar,
 * which does not scroll: Show less and the actions stay on screen.
 */
@Composable
private fun AidenApprovalFoldingText(text: String, resetKey: Any, monospace: Boolean) {
    val palette = AidenTheme.palette
    val isLong = text.length > 320 || text.lines().size > COLLAPSED_LINES
    var expanded by remember(resetKey) { mutableStateOf(false) }
    val scroll = rememberScrollState()
    SelectionContainer(
        if (expanded) {
            Modifier
                .heightIn(max = ExpandedRequestMaxHeight)
                .verticalScroll(scroll)
        } else {
            Modifier
        }
    ) {
        Text(
            text = text,
            style = if (monospace) {
                MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace)
            } else {
                MaterialTheme.typography.bodyMedium
            },
            color = palette.foreground,
            maxLines = if (expanded || !isLong) Int.MAX_VALUE else COLLAPSED_LINES,
            overflow = TextOverflow.Ellipsis
        )
    }
    if (isLong) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = if (expanded) "Show less" else "Show all",
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = palette.secondary,
                modifier = Modifier.clickable(role = Role.Button) { expanded = !expanded }
            )
            Spacer(Modifier.weight(1f))
            // The end of a long request must never sit hidden without a cue.
            if (expanded && scroll.canScrollForward) {
                AidenScrollCue("Scroll for more")
            }
        }
    }
}

@Composable
private fun AidenScrollCue(text: String) {
    val palette = AidenTheme.palette
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            Icons.Default.ArrowDownward,
            contentDescription = null,
            tint = palette.secondary,
            modifier = Modifier.size(14.dp)
        )
        Spacer(Modifier.width(4.dp))
        Text(text = text, style = MaterialTheme.typography.labelMedium, color = palette.secondary)
    }
}

/**
 * Revision 39: the scheduled-task card's body. A connected group on the inner well holds the
 * task (name, cadence, next run), its details as labelled rows, and its instructions; soft
 * notes and the footer follow. The whole body scrolls within [maxHeight] with a cue.
 */
@Composable
private fun AidenScheduleApprovalBody(
    approvalId: String,
    schedule: AidenApprovalSchedule,
    maxHeight: Dp,
    now: Instant?
) {
    val palette = AidenTheme.palette
    val bodyScroll = rememberScrollState()
    val body = AidenApprovalSchedulePresentation.body(schedule)
    val sections = if (body != null) 3 else 2
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = maxHeight)
            .verticalScroll(bodyScroll),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        AidenApprovalHeader(
            icon = Icons.Outlined.EventRepeat,
            title = AidenApprovalSchedulePresentation.title(schedule.action)
        )
        Spacer(Modifier.height(14.dp))
        AidenConnectedColumn {
            AidenScheduleSection(index = 0, count = sections) {
                AidenScheduleHero(schedule, now)
            }
            AidenScheduleSection(index = 1, count = sections) {
                AidenScheduleDetails(schedule)
            }
            if (body != null) {
                AidenScheduleSection(index = 2, count = sections) {
                    Column(Modifier.padding(14.dp)) {
                        Text(
                            text = if (schedule.mode == AidenApprovalScheduleMode.SCRIPT) {
                                stringResource(R.string.chat_schedule_script)
                            } else {
                                stringResource(R.string.chat_schedule_instructions)
                            },
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = palette.secondary,
                            modifier = Modifier.padding(bottom = 6.dp).semantics { heading() }
                        )
                        AidenApprovalFoldingText(
                            text = body,
                            resetKey = approvalId,
                            monospace = schedule.mode == AidenApprovalScheduleMode.SCRIPT
                        )
                        if (schedule.truncated) {
                            Text(
                                text = stringResource(R.string.chat_schedule_truncated),
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.secondary,
                                modifier = Modifier.padding(top = 8.dp)
                            )
                        }
                    }
                }
            }
        }
        when (AidenApprovalSchedulePresentation.note(schedule)) {
            AidenApprovalScheduleNote.SCHEDULING_OFF -> AidenScheduleNote(
                icon = Icons.Outlined.WarningAmber,
                text = stringResource(R.string.chat_schedule_scheduling_off),
                fill = palette.warning.copy(alpha = 0.15f),
                iconTint = palette.warning
            )
            AidenApprovalScheduleNote.STAYS_PAUSED -> AidenScheduleNote(
                icon = Icons.Outlined.PauseCircle,
                text = stringResource(R.string.chat_schedule_stays_paused),
                fill = palette.canvas,
                iconTint = palette.secondary
            )
            null -> Unit
        }
        Spacer(Modifier.height(12.dp))
        Text(
            text = stringResource(R.string.chat_schedule_footer),
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary,
            textAlign = TextAlign.Center
        )
    }
    // Details below the fold must never sit hidden without a cue.
    if (bodyScroll.canScrollForward) {
        Box(Modifier.padding(top = 8.dp)) {
            AidenScrollCue(stringResource(R.string.chat_schedule_more_details))
        }
    }
}

/** One section of the card's connected group, on the inner well. */
@Composable
private fun AidenScheduleSection(index: Int, count: Int, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        color = AidenTheme.palette.canvas,
        shape = aidenGroupItemShape(index, count),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(content = content)
    }
}

@Composable
private fun AidenScheduleHero(schedule: AidenApprovalSchedule, now: Instant?) {
    val palette = AidenTheme.palette
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp)) {
        Text(
            text = schedule.name,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
            color = palette.foreground,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
        Text(
            text = schedule.cadence,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = palette.foreground,
            modifier = Modifier.padding(top = 2.dp)
        )
        val nextRun = AidenApprovalSchedulePresentation.nextRun(schedule)
        if (nextRun != null) {
            val text = AidenApprovalSchedulePresentation.nextRunText(
                at = nextRun,
                now = now ?: Instant.now(),
                use24Hour = android.text.format.DateFormat.is24HourFormat(context)
            )
            Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Outlined.Schedule,
                    contentDescription = null,
                    tint = palette.secondary,
                    modifier = Modifier.size(14.dp)
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = stringResource(R.string.chat_schedule_next_run, text),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary
                )
            }
        }
    }
}

/** Leading icon (14dp gutter, 18dp glyph, 12dp gap): where the row separators start. */
private val DetailSeparatorInset = 44.dp

@Composable
private fun AidenScheduleDetails(schedule: AidenApprovalSchedule) {
    val full = schedule.permission == AidenApprovalSchedulePermission.FULL
    val location = AidenApprovalSchedulePresentation.location(schedule)
    val rows = buildList<@Composable () -> Unit> {
        add {
            AidenScheduleDetailRow(
                icon = when (location) {
                    is AidenApprovalScheduleLocation.Project -> Icons.Outlined.FolderOpen
                    is AidenApprovalScheduleLocation.Connectors -> Icons.Outlined.Power
                    AidenApprovalScheduleLocation.Anywhere -> Icons.Outlined.Public
                    AidenApprovalScheduleLocation.NoProject -> Icons.Outlined.Folder
                },
                label = stringResource(R.string.chat_schedule_runs_in),
                value = when (location) {
                    is AidenApprovalScheduleLocation.Project -> location.name
                    is AidenApprovalScheduleLocation.Connectors -> location.names.joinToString(", ")
                    AidenApprovalScheduleLocation.Anywhere -> stringResource(R.string.chat_schedule_anywhere)
                    AidenApprovalScheduleLocation.NoProject -> stringResource(R.string.chat_schedule_no_project)
                }
            )
        }
        add {
            val access = stringResource(if (full) R.string.chat_schedule_full_access else R.string.chat_schedule_read_only)
            AidenScheduleDetailRow(
                icon = if (full) Icons.Outlined.GppMaybe else Icons.Outlined.VerifiedUser,
                label = stringResource(R.string.chat_schedule_access),
                value = access
            ) { AidenScheduleAccessChip(full = full, label = access) }
        }
        if (schedule.mode == AidenApprovalScheduleMode.SCRIPT) {
            add {
                AidenScheduleDetailRow(
                    icon = Icons.Outlined.Terminal,
                    label = stringResource(R.string.chat_schedule_runs),
                    value = stringResource(R.string.chat_schedule_script)
                )
            }
        } else {
            AidenApprovalSchedulePresentation.model(schedule)?.let { model ->
                add {
                    AidenScheduleDetailRow(
                        icon = Icons.Outlined.DeveloperBoard,
                        label = stringResource(R.string.chat_schedule_model),
                        value = model
                    )
                }
            }
        }
        add {
            AidenScheduleDetailRow(
                icon = if (schedule.notify) Icons.Outlined.Notifications else Icons.Outlined.NotificationsOff,
                label = stringResource(R.string.chat_schedule_notifications),
                value = stringResource(if (schedule.notify) R.string.chat_schedule_on else R.string.chat_schedule_off)
            )
        }
        add {
            AidenScheduleDetailRow(
                icon = Icons.Outlined.Public,
                label = stringResource(R.string.chat_schedule_time_zone),
                value = schedule.timezone
            )
        }
    }
    rows.forEachIndexed { index, row ->
        if (index > 0) {
            HorizontalDivider(
                color = MaterialTheme.colorScheme.outlineVariant,
                modifier = Modifier.padding(start = DetailSeparatorInset)
            )
        }
        row()
    }
}

/** A label and its trailing value, read as one element: "Access, Full access". */
@Composable
private fun AidenScheduleDetailRow(
    icon: ImageVector,
    label: String,
    value: String,
    trailing: (@Composable () -> Unit)? = null
) {
    val palette = AidenTheme.palette
    val description = stringResource(R.string.chat_schedule_row_description, label, value)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .padding(horizontal = 14.dp, vertical = 10.dp)
            .clearAndSetSemantics { contentDescription = description },
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(12.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = palette.secondary
        )
        Spacer(Modifier.width(12.dp))
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            if (trailing != null) {
                trailing()
            } else {
                Text(
                    text = value,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    color = palette.foreground,
                    textAlign = TextAlign.End
                )
            }
        }
    }
}

/** Read-only on a neutral soft fill; Full access on a warning soft fill with a warning label. No border. */
@Composable
private fun AidenScheduleAccessChip(full: Boolean, label: String) {
    val palette = AidenTheme.palette
    val tint = if (full) palette.warning else palette.foreground
    Surface(
        color = if (full) palette.warning.copy(alpha = 0.15f) else palette.secondary.copy(alpha = 0.12f),
        shape = MaterialTheme.shapes.small
    ) {
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                if (full) Icons.Outlined.GppMaybe else Icons.Outlined.VerifiedUser,
                contentDescription = null,
                tint = if (full) palette.warning else palette.secondary,
                modifier = Modifier.size(14.dp)
            )
            Spacer(Modifier.width(4.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = tint
            )
        }
    }
}

/** A soft semantic note: a fill and an icon tint, never a border. */
@Composable
private fun AidenScheduleNote(icon: ImageVector, text: String, fill: Color, iconTint: Color) {
    val palette = AidenTheme.palette
    Spacer(Modifier.height(8.dp))
    Row(
        Modifier
            .fillMaxWidth()
            .background(fill, RoundedCornerShape(14.dp))
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Text(text = text, style = MaterialTheme.typography.bodySmall, color = palette.foreground)
    }
}

private fun approvalIcon(toolName: String): ImageVector = when (toolName) {
    "schedule_task", "edit_automation" -> Icons.Default.Schedule
    "run_command", "bash" -> Icons.Default.Terminal
    "edit_file", "edit" -> Icons.Default.Edit
    "write_file", "write" -> Icons.AutoMirrored.Filled.NoteAdd
    else -> Icons.Default.Shield
}
