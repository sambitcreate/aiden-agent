package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.Crossfade
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.DeveloperBoard
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCard
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCardButton
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCardKind
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCardMac
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCardTag
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCardTagTone
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCardText
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCardTextFormat
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSplitButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.aidenGroupItemShape
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

private val TypedActionHeight = 48.dp
private val TypedTextMaxHeight = 220.dp

/**
 * Revision 61 (`approval:cards`): the typed approval card the desktop shows, one composable for
 * stream, host-run and Bot approvals. It reads top to bottom as the desktop does: the title, the
 * short arguments, the body (and what it replaces), the rows, the notes, then the buttons with
 * Deny first. Each button sends exactly its own decision and scope. A card this phone can only
 * deny says where to allow it instead of showing allow buttons.
 *
 * [canRespond] false shows the card read-only (a device that may review but not answer).
 */
@Composable
fun AidenTypedApprovalCardContent(
    card: AidenApprovalCard,
    resetKey: Any,
    enabled: Boolean,
    canRespond: Boolean,
    onRespond: (AidenApprovalCardButton) -> Unit,
    modifier: Modifier = Modifier,
    readOnlyNote: String? = null
) {
    val palette = AidenTheme.palette
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(44.dp).background(palette.accentFill.fill, RoundedCornerShape(13.dp)),
            contentAlignment = Alignment.Center
        ) {
            Icon(typedCardIcon(card), contentDescription = null, tint = palette.accentFill.content, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.height(12.dp))
        Text(
            text = card.title,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = palette.foreground,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() }
        )
        val sections = buildList<@Composable () -> Unit> {
            if (card.arguments.isNotEmpty()) add { TypedPairs(card.arguments.map { it.key to it.value }) }
            card.body?.let { body ->
                val explanation = card.explanation
                // Revision 69: a shell card with plain words opens on them; the command is one flip away.
                if (explanation != null) add { TypedPlainWords(explanation = explanation, command = body, resetKey = resetKey) }
                else add { TypedText(label = null, text = body, resetKey = resetKey) }
            }
            card.previous?.let { previous ->
                add { TypedText(label = stringResource(R.string.approval_card_previous), text = previous, resetKey = resetKey) }
            }
            card.rows?.takeIf { it.isNotEmpty() }?.let { rows -> add { TypedPairs(rows.map { it.label to it.value }) } }
        }
        if (sections.isNotEmpty()) {
            Spacer(Modifier.height(14.dp))
            AidenConnectedColumn {
                sections.forEachIndexed { index, section ->
                    Surface(color = palette.canvas, shape = aidenGroupItemShape(index, sections.size), modifier = Modifier.fillMaxWidth()) {
                        section()
                    }
                }
            }
        }
        card.tags?.takeIf { it.isNotEmpty() }?.let { tags ->
            Spacer(Modifier.height(10.dp))
            TypedTags(tags)
        }
        card.notes?.forEach { note ->
            Spacer(Modifier.height(10.dp))
            Text(note, style = MaterialTheme.typography.bodySmall, color = palette.secondary, textAlign = TextAlign.Center)
        }
        val footnote = if (!canRespond) readOnlyNote else card.allowOnMac
        if (footnote != null) {
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(footnote, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            }
        }
        if (canRespond) {
            Spacer(Modifier.height(16.dp))
            AidenTypedApprovalActions(card = card, resetKey = resetKey, enabled = enabled, onRespond = onRespond)
        }
    }
}

/**
 * Deny first, then the allow the desktop puts first as the primary action. Any further allows
 * (in this chat, in this workspace, always) sit behind the primary's chevron, labelled exactly
 * as the card labels them.
 */
@Composable
private fun AidenTypedApprovalActions(
    card: AidenApprovalCard,
    resetKey: Any,
    enabled: Boolean,
    onRespond: (AidenApprovalCardButton) -> Unit
) {
    val allows = card.allowButtons
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        AidenTonalButton(
            text = card.denyButton.label,
            onClick = { onRespond(card.denyButton) },
            enabled = enabled,
            modifier = Modifier.weight(1f).height(TypedActionHeight)
        )
        val primary = allows.firstOrNull() ?: return@Row
        val more = allows.drop(1)
        if (more.isEmpty()) {
            AidenPrimaryButton(
                text = primary.label,
                onClick = { onRespond(primary) },
                enabled = enabled,
                modifier = Modifier.weight(1f).height(TypedActionHeight)
            )
            return@Row
        }
        var menuOpen by remember(resetKey) { mutableStateOf(false) }
        AidenSplitButton(
            label = primary.label,
            onClick = { onRespond(primary) },
            menuExpanded = menuOpen && enabled,
            onMenuExpandedChange = { menuOpen = it },
            menuContentDescription = stringResource(R.string.chat_approval_more_options),
            enabled = enabled,
            height = TypedActionHeight,
            fillWidth = true,
            modifier = Modifier.weight(1f)
        ) {
            more.forEach { button ->
                DropdownMenuItem(
                    text = { Text(button.label) },
                    onClick = {
                        menuOpen = false
                        onRespond(button)
                    }
                )
            }
        }
    }
}

/** Short key/value lines (the card's arguments, or a batch's rows). */
@Composable
private fun TypedPairs(pairs: List<Pair<String, String>>) {
    val palette = AidenTheme.palette
    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        pairs.forEach { (label, value) ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    label.replaceFirstChar { it.uppercase() },
                    style = MaterialTheme.typography.labelMedium,
                    color = palette.secondary,
                    modifier = Modifier.weight(0.35f)
                )
                Text(
                    value,
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.foreground,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(0.65f)
                )
            }
        }
    }
}

/** The body or the previous text: a command in monospace, prose as text; long ones scroll in place. */
@Composable
private fun TypedText(label: String?, text: AidenApprovalCardText, resetKey: Any, trailingRoom: Boolean = false) {
    val palette = AidenTheme.palette
    val scroll = key(resetKey) { rememberScrollState() }
    Column(Modifier.fillMaxWidth().padding(start = 14.dp, top = 14.dp, bottom = 14.dp, end = if (trailingRoom) 52.dp else 14.dp)) {
        if (label != null) {
            Text(
                label,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = palette.secondary,
                modifier = Modifier.padding(bottom = 6.dp).semantics { heading() }
            )
        }
        SelectionContainer(Modifier.heightIn(max = TypedTextMaxHeight).verticalScroll(scroll)) {
            Text(
                text.text,
                style = if (text.format == AidenApprovalCardTextFormat.COMMAND) {
                    MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace)
                } else {
                    MaterialTheme.typography.bodyMedium
                },
                color = if (label != null) palette.secondary else palette.foreground
            )
        }
    }
}

/**
 * Revision 69: what the command will do, in the model's words, with a flip to the exact command
 * and back. It always opens on the words; flipping never answers the card.
 */
@Composable
private fun TypedPlainWords(explanation: String, command: AidenApprovalCardText, resetKey: Any) {
    val palette = AidenTheme.palette
    var showCommand by remember(resetKey) { mutableStateOf(false) }
    val flipLabel = stringResource(if (showCommand) R.string.approval_card_show_words else R.string.approval_card_show_command)
    Box(Modifier.fillMaxWidth()) {
        Crossfade(targetState = showCommand, animationSpec = AidenMotion.short(aidenReduceMotion()), label = "approval-flip") { commandSide ->
            if (commandSide) {
                TypedText(label = stringResource(R.string.approval_card_command), text = command, resetKey = resetKey, trailingRoom = true)
            } else {
                Column(Modifier.fillMaxWidth().padding(start = 14.dp, top = 14.dp, bottom = 14.dp, end = 52.dp)) {
                    Text(
                        stringResource(R.string.approval_card_what_it_will_do),
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.secondary,
                        modifier = Modifier.padding(bottom = 6.dp).semantics { heading() }
                    )
                    Text(explanation, style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
                }
            }
        }
        IconButton(
            onClick = { showCommand = !showCommand },
            modifier = Modifier.align(Alignment.TopEnd).padding(2.dp).semantics { contentDescription = flipLabel }
        ) {
            Icon(Icons.Outlined.SwapHoriz, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(20.dp))
        }
    }
}

/** Revision 69: Aiden's own tags for the command, soft red for a risky step and grey for a calm one. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TypedTags(tags: List<AidenApprovalCardTag>) {
    val palette = AidenTheme.palette
    val listLabel = stringResource(R.string.approval_card_tags)
    FlowRow(
        Modifier.fillMaxWidth().semantics { contentDescription = listLabel },
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        tags.forEach { tag ->
            val risk = tag.tone == AidenApprovalCardTagTone.RISK
            val ink = if (risk) palette.danger else palette.secondary
            Row(
                Modifier
                    .background(if (risk) palette.danger.copy(alpha = 0.12f) else palette.canvas, RoundedCornerShape(8.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (risk) {
                    Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = ink, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(4.dp))
                }
                Text(tag.label, style = MaterialTheme.typography.labelMedium, color = ink)
            }
        }
    }
}

private fun typedCardIcon(card: AidenApprovalCard): ImageVector = when (card.kind) {
    AidenApprovalCardKind.MAC -> when (card.mac) {
        AidenApprovalCardMac.SHELL -> Icons.Outlined.Terminal
        AidenApprovalCardMac.FILES -> Icons.Outlined.FolderOpen
        AidenApprovalCardMac.COMPUTER_USE -> Icons.Outlined.DeveloperBoard
        null -> Icons.Outlined.VerifiedUser
    }
    AidenApprovalCardKind.HELD_CHANGE -> Icons.Outlined.EditNote
    AidenApprovalCardKind.BATCH -> Icons.Outlined.Layers
    else -> Icons.Outlined.VerifiedUser
}

/**
 * What a typed card settles to at once after a tap: its title and the tapped button's answered
 * line ("Allowed once", "Denied"). If the Mac refuses, the card comes back in its place.
 */
@Composable
fun AidenApprovalAnsweredRow(title: String, answered: String, modifier: Modifier = Modifier) {
    val palette = AidenTheme.palette
    Row(
        modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            text = "$title · $answered",
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}
