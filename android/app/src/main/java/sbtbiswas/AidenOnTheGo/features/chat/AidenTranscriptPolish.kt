package sbtbiswas.AidenOnTheGo.features.chat

import android.util.TypedValue
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.widget.TextView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlinx.coroutines.delay
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.AidenChatMessage
import sbtbiswas.AidenOnTheGo.models.AidenChatRole
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimeline
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimelineStatus
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R

/**
 * Elapsed-time presentation for assistant turns. Durations come from the
 * Mac-owned generation timeline already carried by the Remote protocol.
 */
object AidenTurnElapsed {
    /** Seconds a completed assistant turn took, or null without a trustworthy completed timeline. */
    fun completedSeconds(message: AidenChatMessage): Double? {
        if (message.role != AidenChatRole.ASSISTANT) return null
        val timeline = message.timeline ?: return null
        if (timeline.status != AidenGenerationTimelineStatus.COMPLETED) return null
        val finishedAt = timeline.finishedAt ?: return null
        if (finishedAt < timeline.startedAt) return null
        return (finishedAt - timeline.startedAt) / 1_000.0
    }

    fun workedForLabel(message: AidenChatMessage): String? =
        completedSeconds(message)?.let { "Worked for ${format(it)}" }

    /** The live timeline's start when present, otherwise the newest user message. */
    fun liveStart(timeline: AidenGenerationTimeline?, messages: List<AidenChatMessage>): Instant? {
        if (timeline != null) return Instant.ofEpochMilli(timeline.startedAt.toLong())
        return messages.lastOrNull { it.role == AidenChatRole.USER }?.createdAt
    }

    fun workingLabel(start: Instant, now: Instant): String =
        "Working for ${format(Duration.between(start, now).toMillis() / 1_000.0)}"

    /** Compact `42s`, `1m 5s`, `2m`, `1h 3m`; negative clock skew clamps to zero. */
    fun format(seconds: Double): String {
        val total = if (seconds.isFinite()) maxOf(0L, kotlin.math.floor(seconds).toLong()) else 0L
        if (total < 60) return "${total}s"
        val hours = total / 3_600
        val minutes = (total % 3_600) / 60
        val remainder = total % 60
        if (hours > 0) return if (minutes == 0L) "${hours}h" else "${hours}h ${minutes}m"
        return if (remainder == 0L) "${minutes}m" else "${minutes}m ${remainder}s"
    }
}

/** Time today, "Yesterday" plus time, then month/day (and year when it differs) plus time. */
object AidenMessageTimestamp {
    fun label(
        instant: Instant,
        now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault()
    ): String {
        val date = instant.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(date)
        return when {
            date.toLocalDate() == today -> time
            date.toLocalDate() == today.minusDays(1) -> "Yesterday $time"
            date.year == today.year -> "${DateTimeFormatter.ofPattern("MMM d", locale).format(date)}, $time"
            else -> "${DateTimeFormatter.ofPattern("MMM d, yyyy", locale).format(date)}, $time"
        }
    }

    fun accessibilityLabel(
        instant: Instant,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault()
    ): String = "Sent " + DateTimeFormatter.ofLocalizedDateTime(FormatStyle.LONG, FormatStyle.SHORT)
        .withLocale(locale)
        .format(instant.atZone(zone))
}

/**
 * Builds the composer draft for "Ask about this": the selection becomes a
 * Markdown blockquote appended after any existing draft.
 */
object AidenSelectionQuote {
    const val MAXIMUM_QUOTED_CHARACTERS = 2_000

    fun draft(selection: String, existingDraft: String): String? {
        val trimmed = selection.trim()
        if (trimmed.isEmpty()) return null
        val bounded = if (trimmed.length > MAXIMUM_QUOTED_CHARACTERS) {
            trimmed.take(MAXIMUM_QUOTED_CHARACTERS) + "…"
        } else trimmed
        val quote = bounded.split("\n").joinToString("\n") { raw ->
            val line = raw.trimEnd('\r')
            if (line.isEmpty()) ">" else "> $line"
        }
        val existing = existingDraft.trimEnd()
        return (if (existing.isEmpty()) "" else "$existing\n\n") + quote + "\n\n"
    }
}

/** Compact footer under a settled message: timestamp, worked-for, copy, Read Aloud. */
@Composable
fun AidenMessageFooter(
    message: AidenChatMessage,
    palette: AidenPalette,
    onCopy: (() -> Unit)?,
    onReadAloud: (() -> Unit)? = null,
    readAloudActive: Boolean = false,
    modifier: Modifier = Modifier
) {
    val isUser = message.role == AidenChatRole.USER
    val timestamp = remember(message.createdAt) { AidenMessageTimestamp.label(message.createdAt) }
    val timestampDescription = remember(message.createdAt) { AidenMessageTimestamp.accessibilityLabel(message.createdAt) }
    val workedFor = remember(message.timeline, message.role) { AidenTurnElapsed.workedForLabel(message) }
    Row(
        modifier = modifier.fillMaxWidth().heightIn(min = 32.dp),
        horizontalArrangement = if (isUser) Arrangement.spacedBy(4.dp, Alignment.End) else Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = timestamp,
            style = MaterialTheme.typography.labelSmall,
            color = palette.secondary,
            modifier = Modifier.semantics { contentDescription = timestampDescription }
        )
        if (workedFor != null) {
            Text(
                text = stringResource(R.string.chat_message_worked_for, workedFor),
                style = MaterialTheme.typography.labelSmall,
                color = palette.secondary,
                modifier = Modifier.testTag("aiden.message.workedFor")
            )
        }
        if (onCopy != null) {
            IconButton(onClick = onCopy) {
                Icon(
                    Icons.Default.ContentCopy,
                    contentDescription = if (isUser) stringResource(R.string.chat_message_copy) else stringResource(R.string.chat_message_copy_response),
                    tint = palette.secondary,
                    modifier = Modifier.size(16.dp)
                )
            }
        }
        if (onReadAloud != null) {
            IconButton(onClick = onReadAloud) {
                Icon(
                    if (readAloudActive) Icons.Default.Stop else Icons.Default.VolumeUp,
                    contentDescription = if (readAloudActive) stringResource(R.string.chat_read_aloud_stop) else stringResource(R.string.chat_read_aloud_start),
                    tint = palette.secondary,
                    modifier = Modifier.size(18.dp)
                )
            }
        }
    }
}

/** Live "Working for Xs" row while a turn runs; ticks once per second. */
@Composable
fun AidenLiveElapsedLabel(start: Instant, palette: AidenPalette, modifier: Modifier = Modifier) {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(start) {
        while (true) {
            now = Instant.now()
            delay(1_000)
        }
    }
    Text(
        text = AidenTurnElapsed.workingLabel(start, now),
        style = MaterialTheme.typography.labelSmall,
        color = palette.secondary,
        modifier = modifier.testTag("aiden.live.workingFor")
    )
}

private const val ASK_ABOUT_MENU_ID = 0x41534b

/**
 * Dialog that exposes a message as native selectable text with an extra
 * "Ask about this" selection action that quotes the selection.
 */
@Composable
fun AidenSelectTextDialog(
    text: String,
    palette: AidenPalette,
    onAskAbout: ((String) -> Unit)?,
    onDismiss: () -> Unit
) {
    val currentOnAsk by rememberUpdatedState(onAskAbout)
    val currentOnDismiss by rememberUpdatedState(onDismiss)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.chat_select_text_title)) },
        text = {
            AndroidView(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(vertical = 4.dp)
                    .testTag("aiden.selectText.body"),
                factory = { context ->
                    TextView(context).apply {
                        setTextIsSelectable(true)
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                        customSelectionActionModeCallback = object : ActionMode.Callback {
                            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                                if (currentOnAsk != null) {
                                    menu.add(Menu.NONE, ASK_ABOUT_MENU_ID, 0, context.getString(R.string.chat_message_ask_about))
                                }
                                return true
                            }

                            override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = false

                            override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
                                if (item.itemId != ASK_ABOUT_MENU_ID) return false
                                val start = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
                                val end = maxOf(selectionStart, selectionEnd).coerceAtMost(this@apply.text.length)
                                val selection = if (end > start) this@apply.text.subSequence(start, end).toString() else ""
                                mode.finish()
                                currentOnAsk?.invoke(selection)
                                currentOnDismiss()
                                return true
                            }

                            override fun onDestroyActionMode(mode: ActionMode) = Unit
                        }
                    }
                },
                update = { view ->
                    if (view.text.toString() != text) view.text = text
                    view.setTextColor(palette.foreground.toArgb())
                    view.highlightColor = palette.accent.copy(alpha = 0.3f).toArgb()
                }
            )
        },
        confirmButton = {
            AidenDialogConfirmButton(text = stringResource(R.string.action_done), onClick = onDismiss)
        },
        dismissButton = if (onAskAbout != null) {
            {
                AidenDialogDismissButton(text = stringResource(R.string.chat_select_text_ask_all), onClick = {
                    onAskAbout(text)
                    onDismiss()
                })
            }
        } else null,
        shape = AidenShape.Dialog,
        containerColor = palette.raised
    )
}
