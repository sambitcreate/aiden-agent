package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.AidenChatForkSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatForkSummaryState
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors

private const val FORK_SUMMARY_TITLE = "What happened after this point"

/** "Forked from {title}" at the top of a fork's transcript. Opens the source unless it was deleted. */
@Composable
fun AidenForkLineageRow(
    source: AidenChatForkSource,
    palette: AidenPalette,
    onOpenSource: ((String) -> Unit)?,
    modifier: Modifier = Modifier
) {
    val label = when (source) {
        is AidenChatForkSource.Named -> "Forked from ${source.title.ifBlank { "Untitled chat" }}"
        is AidenChatForkSource.Deleted -> "Forked from a deleted chat"
        is AidenChatForkSource.Resolving, is AidenChatForkSource.Unknown -> "Forked from another chat"
    }
    val opens = onOpenSource != null && source !is AidenChatForkSource.Deleted
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .fillMaxWidth()
            .then(
                if (opens) {
                    Modifier.clickable(role = Role.Button, onClickLabel = "Open the original chat") {
                        onOpenSource?.invoke(source.chatId)
                    }
                } else Modifier
            )
            .padding(vertical = 6.dp)
    ) {
        Icon(
            Icons.AutoMirrored.Filled.CallSplit,
            contentDescription = null,
            tint = palette.secondary,
            modifier = Modifier.size(14.dp)
        )
        Spacer(modifier = Modifier.width(6.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = palette.secondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/**
 * The fork's summary card, placed after the last copied message. It follows
 * the summary from pending to ready or failed; [canManage] hides the actions
 * when this device cannot write the chat.
 */
@Composable
fun AidenForkSummaryCard(
    summary: AidenChatForkSummary,
    palette: AidenPalette,
    busy: Boolean,
    canManage: Boolean,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onSkip: () -> Unit,
    modifier: Modifier = Modifier,
    body: @Composable (String) -> Unit = { text ->
        Text(text = text, style = MaterialTheme.typography.bodySmall, color = palette.foreground)
    }
) {
    Surface(
        color = palette.raised,
        shape = RoundedCornerShape(14.dp),
        modifier = modifier.fillMaxWidth()
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            when (summary.state) {
                AidenChatForkSummaryState.PENDING -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                            color = palette.secondary
                        )
                        Spacer(modifier = Modifier.width(10.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            SummaryTitle(palette)
                            Text(
                                text = "Summarizing the original chat…",
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.secondary,
                                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                            )
                        }
                        if (canManage) {
                            TextButton(onClick = onCancel, enabled = !busy) {
                                Text("Cancel", color = palette.foreground)
                            }
                        }
                    }
                    FocusLine(summary.focus, palette)
                }
                AidenChatForkSummaryState.FAILED -> {
                    SummaryTitle(palette)
                    Text(
                        text = "${summary.error ?: "The summary could not be generated."} " +
                            "Messages you send wait until you retry or continue without it.",
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive }
                    )
                    FocusLine(summary.focus, palette)
                    if (canManage) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = onRetry,
                                enabled = !busy,
                                shape = RoundedCornerShape(10.dp),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = palette.accent,
                                    contentColor = palette.canvas
                                )
                            ) {
                                Text("Retry", fontWeight = FontWeight.SemiBold)
                            }
                            TextButton(onClick = onSkip, enabled = !busy) {
                                Text("Continue without summary", color = palette.foreground)
                            }
                        }
                    }
                }
                AidenChatForkSummaryState.READY -> ReadySummary(summary, palette, body)
            }
        }
    }
}

@Composable
private fun ReadySummary(
    summary: AidenChatForkSummary,
    palette: AidenPalette,
    body: @Composable (String) -> Unit
) {
    var expanded by rememberSaveable(summary.afterMessageId) { mutableStateOf(false) }
    val rotation by animateFloatAsState(if (expanded) 90f else 0f, label = "forkSummaryChevron")
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button) { expanded = !expanded }
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
            .padding(vertical = 2.dp)
    ) {
        Icon(
            Icons.Default.ChevronRight,
            contentDescription = null,
            tint = palette.secondary,
            modifier = Modifier.size(16.dp).rotate(rotation)
        )
        Spacer(modifier = Modifier.width(4.dp))
        SummaryTitle(palette)
    }
    Text(
        text = "The model sees this summary. None of it happened in this chat.",
        style = MaterialTheme.typography.bodySmall,
        color = palette.secondary
    )
    AnimatedVisibility(
        visible = expanded,
        enter = expandVertically() + fadeIn(),
        exit = shrinkVertically() + fadeOut()
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
            FocusLine(summary.focus, palette)
            summary.text?.let { body(it) }
        }
    }
}

@Composable
private fun SummaryTitle(palette: AidenPalette) {
    Text(
        text = FORK_SUMMARY_TITLE,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.SemiBold,
        color = palette.foreground
    )
}

@Composable
private fun FocusLine(focus: String?, palette: AidenPalette) {
    if (focus.isNullOrEmpty()) return
    Text(
        text = "Focus: $focus",
        style = MaterialTheme.typography.bodySmall,
        color = palette.secondary
    )
}

/** Confirms "Fork with summary…" with an optional focus for the summary. */
@Composable
fun AidenForkSummaryDialog(
    palette: AidenPalette,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String?) -> Unit
) {
    var focus by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Fork with summary", fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "The new chat keeps the conversation up to this point. Aiden summarizes what " +
                        "happened after it in the original chat and gives that summary to the model.",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary
                )
                TextField(
                    value = focus,
                    onValueChange = {
                        focus = it.take(AidenRemoteProtocol.MAX_FORK_SUMMARY_FOCUS_LENGTH)
                    },
                    label = { Text("Focus the summary on…") },
                    placeholder = { Text("For example: the decisions about the parser") },
                    supportingText = {
                        Text("${focus.length} / ${AidenRemoteProtocol.MAX_FORK_SUMMARY_FOCUS_LENGTH}")
                    },
                    colors = aidenTextFieldColors(),
                    minLines = 2,
                    maxLines = 5,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(focus.trim().ifEmpty { null }) }, enabled = !busy) {
                Text("Fork", fontWeight = FontWeight.SemiBold, color = palette.accent)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = palette.foreground) }
        }
    )
}
