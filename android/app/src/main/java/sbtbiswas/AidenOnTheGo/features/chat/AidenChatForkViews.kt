package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
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
import sbtbiswas.AidenOnTheGo.ui.theme.AidenActivityDot
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

private const val FORK_SUMMARY_TITLE = "What happened after this point"
private val CompactActionPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)

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
    val interaction = remember { MutableInteractionSource() }
    Box(modifier = modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            shape = CircleShape,
            modifier = if (opens) Modifier.tactilePress(interaction) else Modifier
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .then(
                        if (opens) {
                            Modifier.clickable(
                                interactionSource = interaction,
                                indication = ripple(),
                                role = Role.Button,
                                onClickLabel = "Open the original chat"
                            ) {
                                onOpenSource?.invoke(source.chatId)
                            }
                        } else Modifier
                    )
                    .heightIn(min = 32.dp)
                    .padding(start = 10.dp, end = if (opens) 8.dp else 12.dp, top = 6.dp, bottom = 6.dp)
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
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                if (opens) {
                    Spacer(modifier = Modifier.width(2.dp))
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = palette.secondary,
                        modifier = Modifier.size(14.dp)
                    )
                }
            }
        }
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
                        // The desktop is working on the summary; the label beside it says so.
                        AidenActivityDot(color = palette.accent)
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
                            AidenTonalButton(
                                text = "Cancel",
                                onClick = onCancel,
                                enabled = !busy,
                                contentPadding = CompactActionPadding
                            )
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
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            AidenPrimaryButton(text = "Retry", onClick = onRetry, enabled = !busy)
                            AidenTonalButton(
                                text = "Continue without summary",
                                onClick = onSkip,
                                enabled = !busy
                            )
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
    val reduceMotion = aidenReduceMotion()
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 90f else 0f,
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "forkSummaryChevron"
    )
    val interaction = remember { MutableInteractionSource() }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .tactilePress(interaction, targetScale = 0.98f)
            .clickable(
                interactionSource = interaction,
                indication = ripple(),
                role = Role.Button
            ) { expanded = !expanded }
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
        enter = if (reduceMotion) EnterTransition.None else {
            expandVertically(AidenMotion.spatialExpressiveSpring(), expandFrom = Alignment.Top) +
                fadeIn(AidenMotion.nonSpatialExpressiveSpring())
        },
        exit = if (reduceMotion) ExitTransition.None else {
            shrinkVertically(AidenMotion.spatialExpressiveSpring(), shrinkTowards = Alignment.Top) +
                fadeOut(AidenMotion.nonSpatialExpressiveSpring())
        }
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
            AidenDialogConfirmButton(
                text = "Fork",
                onClick = { onConfirm(focus.trim().ifEmpty { null }) },
                enabled = !busy
            )
        },
        dismissButton = { AidenDialogDismissButton(onClick = onDismiss) },
        shape = AidenShape.Dialog,
        containerColor = palette.raised
    )
}
