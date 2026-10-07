package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenActivityDot
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupOrientation
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenGroupItemShape
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/**
 * Squircle confirmation dialog used by the workspace, files, and git screens. The dismiss
 * action always mirrors [onDismissRequest]; pass a null [confirmText] to hide the primary
 * action (for example when the operation is not allowed).
 */
@Composable
internal fun AidenWorkspaceAlertDialog(
    title: String,
    onDismissRequest: () -> Unit,
    confirmText: String?,
    onConfirm: () -> Unit,
    dismissText: String = "Cancel",
    destructive: Boolean = false,
    text: @Composable () -> Unit
) {
    val palette = AidenTheme.palette
    AlertDialog(
        onDismissRequest = onDismissRequest,
        shape = AidenShape.Dialog,
        containerColor = palette.raised,
        titleContentColor = palette.foreground,
        textContentColor = palette.secondary,
        title = { Text(title, fontWeight = FontWeight.Bold) },
        text = text,
        confirmButton = {
            if (confirmText != null) {
                AidenDialogConfirmButton(text = confirmText, onClick = onConfirm, destructive = destructive)
            }
        },
        dismissButton = { AidenDialogDismissButton(text = dismissText, onClick = onDismissRequest) }
    )
}

/**
 * One tonal segment of a connected horizontal action bar (16.dp outer corners, 4.dp
 * seams). [stacked] places the icon above the label for narrow four-up bars; [loading]
 * swaps the icon for a breathing activity dot while the action is in flight and makes
 * the segment inert so it cannot be sent twice.
 */
@Composable
internal fun AidenConnectedActionSegment(
    index: Int,
    count: Int,
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    stacked: Boolean = false,
    loading: Boolean = false,
    trailing: (@Composable () -> Unit)? = null
) {
    val palette = AidenTheme.palette
    val interaction = remember { MutableInteractionSource() }
    val leading: @Composable () -> Unit = {
        if (loading) {
            Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
                AidenActivityDot(color = palette.accent)
            }
        } else {
            Icon(icon, contentDescription = null, tint = palette.foreground, modifier = Modifier.size(18.dp))
        }
    }
    val text: @Composable () -> Unit = {
        Text(
            text = label,
            style = if (stacked) MaterialTheme.typography.labelMedium else MaterialTheme.typography.labelLarge,
            color = palette.foreground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
    Surface(
        onClick = onClick,
        enabled = !loading,
        shape = aidenGroupItemShape(index, count, AidenShape.SplitOuter, AidenShape.SplitInner, AidenGroupOrientation.HORIZONTAL),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = palette.foreground,
        interactionSource = interaction,
        modifier = modifier
            .fillMaxHeight()
            .heightIn(min = 48.dp)
            .tactilePress(interaction)
            .semantics {
                role = Role.Button
                if (loading) stateDescription = "In progress"
            }
    ) {
        if (stacked) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 8.dp)
            ) {
                leading()
                text()
            }
        } else {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)
            ) {
                leading()
                text()
                trailing?.invoke()
            }
        }
    }
}
