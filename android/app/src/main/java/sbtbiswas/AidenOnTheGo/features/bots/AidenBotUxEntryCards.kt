package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CleaningServices
import androidx.compose.material.icons.outlined.Lightbulb
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenBotInstructionsDiffKind
import sbtbiswas.AidenOnTheGo.models.AidenBotInstructionsDiffLine
import sbtbiswas.AidenOnTheGo.models.AidenBotLessonDecision
import sbtbiswas.AidenOnTheGo.models.AidenBotLessonEntry
import sbtbiswas.AidenOnTheGo.models.AidenBotLessonKind
import sbtbiswas.AidenOnTheGo.models.AidenBotLessonStatus
import sbtbiswas.AidenOnTheGo.models.AidenBotMemoryTidyEntry
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionEntry
import sbtbiswas.AidenOnTheGo.models.AidenBotSettingsChangeDecision
import sbtbiswas.AidenOnTheGo.models.AidenBotSettingsChangeEntry
import sbtbiswas.AidenOnTheGo.models.AidenBotSettingsChangeStatus
import sbtbiswas.AidenOnTheGo.models.AidenBotSettingsField
import sbtbiswas.AidenOnTheGo.models.AidenBotSettingsHeldReason
import sbtbiswas.AidenOnTheGo.models.AidenBotSkillProposalDecision
import sbtbiswas.AidenOnTheGo.models.AidenBotSkillProposalEntry
import sbtbiswas.AidenOnTheGo.models.AidenBotSkillProposalStatus
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton

object AidenBotUxTags {
    const val HELD_SETTINGS = "bot_ux_held_settings"
    const val SUGGESTION = "bot_ux_suggestion"
    const val RECEIPT = "bot_ux_receipt"
}

/** What one revision-61 entry offers, wired to the session controller. */
data class AidenBotUxEntryActions(
    val onSettings: (AidenBotSettingsChangeDecision) -> Unit,
    val onSkill: (AidenBotSkillProposalDecision) -> Unit,
    val onLesson: (AidenBotLessonDecision) -> Unit,
    val onUndoLearned: () -> Unit,
    val onUndoTidy: () -> Unit
)

/**
 * Revision 61 (`bot:settings-changes`, `bot:suggestions`): one settings, suggestion or learning
 * entry as the desktop shows it. A held settings change is a card with the whole proposed text,
 * the changed lines marked, and Apply / Dismiss (Edit stays on the Mac). A skill or lesson the Bot
 * suggests is a card with Not now / Add. Everything else is a quiet receipt line with Undo while
 * it can still be undone. Answers apply at once; [error] says why one didn't land.
 */
@Composable
fun AidenBotUxEntryRow(
    entry: AidenBotSessionEntry,
    botName: String,
    canAnswer: Boolean,
    sending: Boolean,
    error: String?,
    tidyUndone: Boolean,
    actions: AidenBotUxEntryActions
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when (entry) {
            is AidenBotSettingsChangeEntry -> if (entry.awaitsAnswer) {
                AidenBotHeldSettingsCard(entry, botName, canAnswer, sending, actions.onSettings)
            } else {
                AidenBotReceiptLine(
                    icon = Icons.Outlined.Tune,
                    text = aidenBotSettingsReceiptText(entry),
                    action = if (canAnswer && entry.offersUndo) {
                        stringResource(if (sending) R.string.bot_ux_undoing else R.string.bot_ux_undo)
                    } else null,
                    actionEnabled = !sending,
                    onAction = { actions.onSettings(AidenBotSettingsChangeDecision.UNDO) }
                )
            }
            is AidenBotSkillProposalEntry -> when (entry.status) {
                AidenBotSkillProposalStatus.PENDING -> AidenBotSkillSuggestionCard(entry, canAnswer, sending, actions.onSkill)
                AidenBotSkillProposalStatus.ADDED -> AidenBotReceiptLine(
                    Icons.Outlined.CheckCircle, stringResource(R.string.bot_ux_skill_added, entry.name), tint = AidenTheme.palette.success
                )
                AidenBotSkillProposalStatus.DISMISSED -> AidenBotReceiptLine(
                    Icons.Outlined.AutoAwesome, stringResource(R.string.bot_ux_not_added, entry.name)
                )
            }
            is AidenBotLessonEntry -> AidenBotLessonRow(entry, canAnswer, sending, actions)
            is AidenBotMemoryTidyEntry -> {
                val undone = tidyUndone
                AidenBotReceiptLine(
                    icon = Icons.Outlined.CleaningServices,
                    text = stringResource(R.string.bot_ux_tidied_memory).let { if (undone) stringResource(R.string.bot_ux_undone, it) else it },
                    action = if (canAnswer && entry.changeId != null && !undone) stringResource(R.string.bot_ux_undo) else null,
                    actionEnabled = !sending,
                    onAction = actions.onUndoTidy
                )
            }
            else -> Unit
        }
        if (error != null) {
            Text(error, style = MaterialTheme.typography.bodySmall, color = aidenBotErrorTextColor(), modifier = Modifier.padding(horizontal = 4.dp))
        }
    }
}

@Composable
private fun AidenBotLessonRow(entry: AidenBotLessonEntry, canAnswer: Boolean, sending: Boolean, actions: AidenBotUxEntryActions) {
    if (entry.kind == AidenBotLessonKind.LEARNED) {
        val learned = stringResource(R.string.bot_ux_learned, entry.text)
        val undone = entry.status == AidenBotLessonStatus.RETIRED
        AidenBotReceiptLine(
            icon = Icons.Outlined.Lightbulb,
            text = if (undone) stringResource(R.string.bot_ux_undone, learned) else learned,
            action = if (canAnswer && entry.status == AidenBotLessonStatus.ACTIVE) stringResource(R.string.bot_ux_undo) else null,
            actionEnabled = !sending,
            onAction = actions.onUndoLearned
        )
        return
    }
    when (entry.status) {
        AidenBotLessonStatus.PENDING -> AidenBotSuggestionCard(
            icon = Icons.Outlined.Lightbulb,
            title = entry.routineName?.let { stringResource(R.string.bot_ux_lesson_title_routine, it) }
                ?: stringResource(R.string.bot_ux_lesson_title),
            canAnswer = canAnswer,
            sending = sending,
            canAdd = true,
            onAdd = { actions.onLesson(AidenBotLessonDecision.KEEP) },
            onNotNow = { actions.onLesson(AidenBotLessonDecision.DISMISS) }
        ) {
            Text(entry.text, style = MaterialTheme.typography.bodyMedium, color = AidenTheme.palette.foreground)
            entry.runs?.takeIf { it > 0 }?.let { runs ->
                Text(
                    pluralStringResource(R.plurals.bot_ux_lesson_runs, runs, runs),
                    style = MaterialTheme.typography.bodySmall,
                    color = AidenTheme.palette.secondary
                )
            }
        }
        AidenBotLessonStatus.ACTIVE -> AidenBotReceiptLine(
            Icons.Outlined.CheckCircle, stringResource(R.string.bot_ux_lesson_added, entry.text), tint = AidenTheme.palette.success
        )
        AidenBotLessonStatus.DISMISSED, AidenBotLessonStatus.RETIRED -> AidenBotReceiptLine(
            Icons.Outlined.Lightbulb, stringResource(R.string.bot_ux_not_added, entry.text)
        )
    }
}

/** "Settings updated · Name: Chief → Planner", then Restored or why Undo didn't happen. */
@Composable
fun aidenBotSettingsReceiptText(entry: AidenBotSettingsChangeEntry): String {
    val label = stringResource(
        if (entry.fields == listOf(AidenBotSettingsField.INSTRUCTIONS)) R.string.bot_ux_instructions_updated else R.string.bot_ux_settings_updated
    )
    val detail = if (entry.fields == listOf(AidenBotSettingsField.INSTRUCTIONS) || entry.lines.isEmpty()) "" else " · ${entry.lines.joinToString(", ")}"
    val suffix = when (entry.status) {
        AidenBotSettingsChangeStatus.RESTORED -> " · " + stringResource(R.string.bot_ux_restored)
        AidenBotSettingsChangeStatus.UNDO_REFUSED -> " · " + stringResource(R.string.bot_ux_undo_refused)
        AidenBotSettingsChangeStatus.DISMISSED -> " · " + stringResource(R.string.bot_ux_dismissed)
        else -> ""
    }
    return label + detail + suffix
}

@Composable
private fun AidenBotHeldSettingsCard(
    entry: AidenBotSettingsChangeEntry,
    botName: String,
    canAnswer: Boolean,
    sending: Boolean,
    onRespond: (AidenBotSettingsChangeDecision) -> Unit
) {
    val palette = AidenTheme.palette
    AidenBotUxCard(icon = Icons.Outlined.Tune, title = entry.title, tag = AidenBotUxTags.HELD_SETTINGS) {
        Text(
            when (entry.heldReason ?: AidenBotSettingsHeldReason.NOT_OWNER) {
                AidenBotSettingsHeldReason.NOT_OWNER -> stringResource(R.string.bot_ux_held_not_owner, botName)
                AidenBotSettingsHeldReason.OUTSIDE_CONTENT -> stringResource(R.string.bot_ux_held_outside_content, botName)
                AidenBotSettingsHeldReason.WIDENS -> stringResource(R.string.bot_ux_held_widens, botName)
            },
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary
        )
        val other = entry.lines.filter { it != "Instructions" && !it.startsWith("Instructions:") }
        if (other.isNotEmpty()) {
            Text(other.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        }
        entry.instructions?.let { proposed ->
            Text(stringResource(R.string.bot_ux_held_replaces, botName), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            AidenBotInstructionsPreview(
                entry.instructionsDiff ?: proposed.split("\n").map { AidenBotInstructionsDiffLine(AidenBotInstructionsDiffKind.SAME, it) }
            )
        }
        if (canAnswer) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AidenTonalButton(
                    text = stringResource(R.string.bot_ux_dismiss),
                    enabled = !sending,
                    onClick = { onRespond(AidenBotSettingsChangeDecision.DISMISS) }
                )
                AidenPrimaryButton(
                    text = stringResource(if (sending) R.string.bot_ux_applying else R.string.bot_ux_apply),
                    enabled = !sending,
                    onClick = { onRespond(AidenBotSettingsChangeDecision.APPLY) }
                )
            }
        }
    }
}

/** The whole proposed text in a bounded scroller, added lines on a soft green, removed on a soft red. */
@Composable
private fun AidenBotInstructionsPreview(lines: List<AidenBotInstructionsDiffLine>) {
    val palette = AidenTheme.palette
    val added = stringResource(R.string.bot_ux_line_added)
    val removed = stringResource(R.string.bot_ux_line_removed)
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 220.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(palette.canvas)
            .verticalScroll(rememberScrollState())
            .padding(6.dp),
        verticalArrangement = Arrangement.spacedBy(1.dp)
    ) {
        lines.forEach { line ->
            val fill = when (line.kind) {
                AidenBotInstructionsDiffKind.ADDED -> palette.success.copy(alpha = 0.14f)
                AidenBotInstructionsDiffKind.REMOVED -> palette.danger.copy(alpha = 0.12f)
                AidenBotInstructionsDiffKind.SAME -> Color.Transparent
            }
            Text(
                line.text.ifEmpty { " " },
                style = MaterialTheme.typography.bodySmall,
                color = if (line.kind == AidenBotInstructionsDiffKind.SAME) palette.secondary else palette.foreground,
                textDecoration = if (line.kind == AidenBotInstructionsDiffKind.REMOVED) TextDecoration.LineThrough else null,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(4.dp))
                    .background(fill)
                    .padding(horizontal = 6.dp, vertical = 1.dp)
                    .semantics {
                        when (line.kind) {
                            AidenBotInstructionsDiffKind.ADDED -> contentDescription = "$added ${line.text}"
                            AidenBotInstructionsDiffKind.REMOVED -> contentDescription = "$removed ${line.text}"
                            AidenBotInstructionsDiffKind.SAME -> Unit
                        }
                    }
            )
        }
    }
}

@Composable
private fun AidenBotSkillSuggestionCard(
    entry: AidenBotSkillProposalEntry,
    canAnswer: Boolean,
    sending: Boolean,
    onRespond: (AidenBotSkillProposalDecision) -> Unit
) {
    val palette = AidenTheme.palette
    AidenBotSuggestionCard(
        icon = Icons.Outlined.AutoAwesome,
        title = stringResource(if (entry.update) R.string.bot_ux_skill_update_title else R.string.bot_ux_skill_add_title),
        canAnswer = canAnswer,
        sending = sending,
        canAdd = entry.canAddHere,
        onAdd = { onRespond(AidenBotSkillProposalDecision.ADD) },
        onNotNow = { onRespond(AidenBotSkillProposalDecision.DISMISS) }
    ) {
        Text(
            if (entry.description.isBlank()) entry.name else "${entry.name} · ${entry.description}",
            style = MaterialTheme.typography.bodyMedium,
            color = palette.foreground
        )
        entry.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = palette.secondary) }
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 220.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(palette.canvas)
                .verticalScroll(rememberScrollState())
                .padding(10.dp)
        ) {
            entry.preview.split("\n").forEach { line ->
                val color = when {
                    line.startsWith("+") && !line.startsWith("+++") -> palette.success
                    line.startsWith("-") && !line.startsWith("---") -> palette.danger
                    else -> palette.secondary
                }
                Text(line.ifEmpty { " " }, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = color)
            }
        }
        if (!entry.canAddHere) {
            Text(stringResource(R.string.bot_ux_skill_add_on_mac), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        }
    }
}

/** A suggestion the Bot offers to add: Not now, then Add ("Adding…" while it goes). */
@Composable
private fun AidenBotSuggestionCard(
    icon: ImageVector,
    title: String,
    canAnswer: Boolean,
    sending: Boolean,
    canAdd: Boolean,
    onAdd: () -> Unit,
    onNotNow: () -> Unit,
    body: @Composable () -> Unit
) {
    AidenBotUxCard(icon = icon, title = title, tag = AidenBotUxTags.SUGGESTION) {
        body()
        if (canAnswer) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AidenTonalButton(text = stringResource(R.string.bot_proposal_not_now), enabled = !sending, onClick = onNotNow)
                if (canAdd) {
                    AidenPrimaryButton(
                        text = stringResource(if (sending) R.string.bot_ux_adding else R.string.bot_ux_add),
                        enabled = !sending,
                        onClick = onAdd
                    )
                }
            }
        }
    }
}

@Composable
private fun AidenBotUxCard(icon: ImageVector, title: String, tag: String, content: @Composable () -> Unit) {
    val palette = AidenTheme.palette
    Surface(color = palette.raised, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().testTag(tag)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(36.dp).clip(AidenShape.Button).background(MaterialTheme.colorScheme.surfaceContainerHigh),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(icon, contentDescription = null, tint = palette.foreground, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.width(12.dp))
                Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = palette.foreground)
            }
            content()
        }
    }
}

/** A quiet line in the transcript, with one trailing text action (Undo). */
@Composable
private fun AidenBotReceiptLine(
    icon: ImageVector,
    text: String,
    tint: Color = AidenTheme.palette.secondary,
    action: String? = null,
    actionEnabled: Boolean = true,
    onAction: () -> Unit = {}
) {
    val palette = AidenTheme.palette
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 4.dp).heightIn(min = 36.dp).testTag(AidenBotUxTags.RECEIPT),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        if (action != null) {
            TextButton(onClick = onAction, enabled = actionEnabled) {
                Text(action, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}
