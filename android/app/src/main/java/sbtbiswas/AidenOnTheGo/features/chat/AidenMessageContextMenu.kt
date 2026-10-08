package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R

/**
 * The fork actions a message offers. Each is null when it does not apply:
 * the Mac lacks the feature, the chat cannot be written, or the message is
 * not an eligible cut.
 */
data class AidenMessageForkActions(
    /** "Fork from here" on a settled assistant reply. */
    val onForkFromHere: (() -> Unit)? = null,
    /** "Fork with summary…" on a settled assistant reply that something follows. */
    val onForkWithSummary: (() -> Unit)? = null,
    /** "Edit in fork" on any of your prompts except the first. */
    val onEditInFork: (() -> Unit)? = null
) {
    val isEmpty: Boolean get() = onForkFromHere == null && onForkWithSummary == null && onEditInFork == null
}

/**
 * Long-press haptic context menu wrapper for message bubbles. "Select text"
 * opens native selectable text; "Ask about this" quotes the message into the
 * composer and is omitted while the chat is read-only. [forkActions] adds the
 * fork entries that apply to this message.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AidenMessageActionContainer(
    onCopy: () -> Unit,
    onShare: () -> Unit,
    onSelectText: () -> Unit,
    onAskAbout: (() -> Unit)?,
    modifier: Modifier = Modifier,
    forkActions: AidenMessageForkActions? = null,
    content: @Composable () -> Unit
) {
    var menuExpanded by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    val messageActionsLabel = stringResource(R.string.chat_message_actions)
    val selectTextLabel = stringResource(R.string.chat_message_select_text_action)
    val askAboutLabel = stringResource(R.string.chat_message_ask_about)
    val forkHereLabel = stringResource(R.string.chat_message_fork_here)
    val forkSummaryLabel = stringResource(R.string.chat_message_fork_summary_action)
    val editInForkLabel = stringResource(R.string.chat_message_edit_in_fork)

    Box(
        modifier = modifier
            .combinedClickable(
                onLongClickLabel = messageActionsLabel,
                onLongClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    menuExpanded = true
                },
                onClick = {}
            )
            .semantics {
                customActions = listOfNotNull(
                    CustomAccessibilityAction(selectTextLabel) { onSelectText(); true },
                    onAskAbout?.let { ask -> CustomAccessibilityAction(askAboutLabel) { ask(); true } },
                    forkActions?.onForkFromHere?.let { fork -> CustomAccessibilityAction(forkHereLabel) { fork(); true } },
                    forkActions?.onForkWithSummary?.let { fork ->
                        CustomAccessibilityAction(forkSummaryLabel) { fork(); true }
                    },
                    forkActions?.onEditInFork?.let { edit -> CustomAccessibilityAction(editInForkLabel) { edit(); true } }
                )
            }
    ) {
        content()

        DropdownMenu(
            expanded = menuExpanded,
            onDismissRequest = { menuExpanded = false }
        ) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_message_copy_text)) },
                leadingIcon = { Icon(Icons.Default.ContentCopy, contentDescription = null) },
                onClick = {
                    onCopy()
                    menuExpanded = false
                }
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_message_select_text)) },
                leadingIcon = { Icon(Icons.Default.SelectAll, contentDescription = null) },
                onClick = {
                    menuExpanded = false
                    onSelectText()
                }
            )
            if (onAskAbout != null) {
                DropdownMenuItem(
                    text = { Text(askAboutLabel) },
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = null) },
                    onClick = {
                        menuExpanded = false
                        onAskAbout()
                    }
                )
            }
            DropdownMenuItem(
                text = { Text(stringResource(R.string.action_share)) },
                leadingIcon = { Icon(Icons.Default.Share, contentDescription = null) },
                onClick = {
                    onShare()
                    menuExpanded = false
                }
            )
            if (forkActions != null && !forkActions.isEmpty) {
                HorizontalDivider()
                forkActions.onForkFromHere?.let { fork ->
                    DropdownMenuItem(
                        text = { Text(forkHereLabel) },
                        leadingIcon = { Icon(Icons.AutoMirrored.Filled.CallSplit, contentDescription = null) },
                        onClick = {
                            menuExpanded = false
                            fork()
                        }
                    )
                }
                forkActions.onForkWithSummary?.let { fork ->
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.chat_message_fork_summary_menu)) },
                        leadingIcon = { Icon(Icons.Default.Summarize, contentDescription = null) },
                        onClick = {
                            menuExpanded = false
                            fork()
                        }
                    )
                }
                forkActions.onEditInFork?.let { edit ->
                    DropdownMenuItem(
                        text = { Text(editInForkLabel) },
                        leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                        onClick = {
                            menuExpanded = false
                            edit()
                        }
                    )
                }
            }
        }
    }
}
