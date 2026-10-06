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

    Box(
        modifier = modifier
            .combinedClickable(
                onLongClickLabel = "Message actions",
                onLongClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    menuExpanded = true
                },
                onClick = {}
            )
            .semantics {
                customActions = listOfNotNull(
                    CustomAccessibilityAction("Select text") { onSelectText(); true },
                    onAskAbout?.let { ask -> CustomAccessibilityAction("Ask about this") { ask(); true } },
                    forkActions?.onForkFromHere?.let { fork -> CustomAccessibilityAction("Fork from here") { fork(); true } },
                    forkActions?.onForkWithSummary?.let { fork ->
                        CustomAccessibilityAction("Fork with summary") { fork(); true }
                    },
                    forkActions?.onEditInFork?.let { edit -> CustomAccessibilityAction("Edit in fork") { edit(); true } }
                )
            }
    ) {
        content()

        DropdownMenu(
            expanded = menuExpanded,
            onDismissRequest = { menuExpanded = false }
        ) {
            DropdownMenuItem(
                text = { Text("Copy Text") },
                leadingIcon = { Icon(Icons.Default.ContentCopy, contentDescription = null) },
                onClick = {
                    onCopy()
                    menuExpanded = false
                }
            )
            DropdownMenuItem(
                text = { Text("Select Text") },
                leadingIcon = { Icon(Icons.Default.SelectAll, contentDescription = null) },
                onClick = {
                    menuExpanded = false
                    onSelectText()
                }
            )
            if (onAskAbout != null) {
                DropdownMenuItem(
                    text = { Text("Ask about this") },
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = null) },
                    onClick = {
                        menuExpanded = false
                        onAskAbout()
                    }
                )
            }
            DropdownMenuItem(
                text = { Text("Share") },
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
                        text = { Text("Fork from here") },
                        leadingIcon = { Icon(Icons.AutoMirrored.Filled.CallSplit, contentDescription = null) },
                        onClick = {
                            menuExpanded = false
                            fork()
                        }
                    )
                }
                forkActions.onForkWithSummary?.let { fork ->
                    DropdownMenuItem(
                        text = { Text("Fork with summary…") },
                        leadingIcon = { Icon(Icons.Default.Summarize, contentDescription = null) },
                        onClick = {
                            menuExpanded = false
                            fork()
                        }
                    )
                }
                forkActions.onEditInFork?.let { edit ->
                    DropdownMenuItem(
                        text = { Text("Edit in fork") },
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
