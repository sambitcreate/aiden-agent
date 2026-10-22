package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenApprovalDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalPresentation
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScope
import sbtbiswas.AidenOnTheGo.models.AidenPendingApproval
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/** Lines the request shows before Show all. */
private const val COLLAPSED_LINES = 6

/** About ten lines: the most an expanded request takes before it scrolls. */
private val ExpandedRequestMaxHeight = 200.dp

/**
 * The approval card's content, matching desktop and iOS: an icon tile, the action as a
 * question, the exact request in a code block, a short note, and two equal buttons with
 * the remembered scopes behind Allow's chevron. The caller owns the surface around it.
 */
@Composable
internal fun AidenApprovalCardContent(
    approval: AidenPendingApproval,
    enabled: Boolean,
    onRespond: (AidenApprovalDecision, AidenApprovalScope) -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val isAutomation = AidenApprovalPresentation.isAutomation(approval.toolName)
    val request = if (isAutomation) {
        approval.summary.trim().ifEmpty { "Review requested action" }
    } else {
        AidenApprovalPresentation.requestedAction(approval.toolName, approval.summary)
    }
    val isLong = request.length > 320 || request.lines().size > COLLAPSED_LINES
    var expanded by remember(approval.id) { mutableStateOf(false) }
    // A new approval opens at the start of its request, not where the last one was left.
    val requestScroll = key(approval.id) { rememberScrollState() }
    val note = when {
        !approval.canRespond -> stringResource(R.string.chat_approval_review_only)
        isAutomation && !approval.hasRequiredWriteCapability -> stringResource(R.string.chat_approval_schedule_write_required)
        AidenApprovalPresentation.requiresDesktopConfirmation(approval) -> stringResource(R.string.chat_approval_confirm_on_desktop)
        !approval.canAllow -> stringResource(R.string.chat_approval_deny_only)
        isAutomation -> stringResource(R.string.chat_approval_automation_note)
        else -> stringResource(R.string.chat_approval_paused_note)
    }

    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .background(palette.accentFill.fill, RoundedCornerShape(13.dp)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                approvalIcon(approval.toolName),
                contentDescription = null,
                tint = palette.accentFill.content,
                modifier = Modifier.size(22.dp)
            )
        }
        Spacer(Modifier.height(12.dp))
        Text(
            text = AidenApprovalPresentation.headline(approval.toolName, approval.summary),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = palette.foreground,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() }
        )
        Spacer(Modifier.height(14.dp))
        Column(
            Modifier
                .fillMaxWidth()
                .background(palette.canvas, RoundedCornerShape(14.dp))
                .padding(14.dp)
        ) {
            // The card can sit in the chat's bottom bar, which does not scroll: an expanded
            // request scrolls in its own bounded box so Show less and the actions stay on screen.
            SelectionContainer(
                if (expanded) {
                    Modifier
                        .heightIn(max = ExpandedRequestMaxHeight)
                        .verticalScroll(requestScroll)
                } else {
                    Modifier
                }
            ) {
                Text(
                    text = request,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
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
                    if (expanded && requestScroll.canScrollForward) {
                        Icon(
                            Icons.Default.ArrowDownward,
                            contentDescription = null,
                            tint = palette.secondary,
                            modifier = Modifier.size(14.dp)
                        )
                        Spacer(Modifier.width(4.dp))
                        Text(
                            text = "Scroll for more",
                            style = MaterialTheme.typography.labelMedium,
                            color = palette.secondary
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(
            text = note,
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary,
            textAlign = TextAlign.Center
        )
        if (approval.canRespond) {
            Spacer(Modifier.height(16.dp))
            AidenApprovalActions(approval = approval, enabled = enabled, onRespond = onRespond)
        }
    }
}

private fun approvalIcon(toolName: String): ImageVector = when (toolName) {
    "schedule_task", "edit_automation" -> Icons.Default.Schedule
    "run_command", "bash" -> Icons.Default.Terminal
    "edit_file", "edit" -> Icons.Default.Edit
    "write_file", "write" -> Icons.AutoMirrored.Filled.NoteAdd
    else -> Icons.Default.Shield
}
