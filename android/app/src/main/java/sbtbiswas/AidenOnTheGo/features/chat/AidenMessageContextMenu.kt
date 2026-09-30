package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
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
 * Long-press haptic context menu wrapper for message bubbles. "Select text"
 * opens native selectable text; "Ask about this" quotes the message into the
 * composer and is omitted while the chat is read-only.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AidenMessageActionContainer(
    onCopy: () -> Unit,
    onShare: () -> Unit,
    onSelectText: () -> Unit,
    onAskAbout: (() -> Unit)?,
    modifier: Modifier = Modifier,
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
                    onAskAbout?.let { ask -> CustomAccessibilityAction("Ask about this") { ask(); true } }
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
        }
    }
}
