package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback

/**
 * Long-press haptic context menu wrapper for message bubbles.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AidenMessageActionContainer(
    onCopy: () -> Unit,
    onShare: () -> Unit,
    onReply: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    var menuExpanded by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current

    Box(
        modifier = modifier.combinedClickable(
            onLongClick = {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                menuExpanded = true
            },
            onClick = {}
        )
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
                text = { Text("Reply") },
                leadingIcon = { Icon(Icons.Default.Reply, contentDescription = null) },
                onClick = {
                    onReply()
                    menuExpanded = false
                }
            )
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
