package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.models.AidenNewWorktreeCopy
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi

const val AIDEN_NEW_WORKTREE_CHIP_TAG = "aiden-new-worktree-chip"
const val AIDEN_NEW_WORKTREE_SETUP_TAG = "aiden-new-worktree-setup"

/** Revision 50: on, the chat's first message makes a worktree on the Mac before it sends. */
@Composable
fun AidenNewWorktreeChip(
    isOn: Boolean,
    onToggle: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    val palette = AidenTheme.palette
    Surface(
        color = if (isOn) palette.accent.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = CircleShape,
        modifier = modifier
            .heightIn(min = AidenUi.MinimumTouchTarget)
            .testTag(AIDEN_NEW_WORKTREE_CHIP_TAG)
            .toggleable(value = isOn, enabled = enabled, role = Role.Switch, onValueChange = onToggle)
            .semantics {
                contentDescription = "${AidenNewWorktreeCopy.TOGGLE}. ${AidenNewWorktreeCopy.HINT}"
                stateDescription = if (isOn) "On" else "Off"
            }
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                if (isOn) Icons.Default.CheckCircle else Icons.Default.AccountTree,
                contentDescription = null,
                tint = palette.accent,
                modifier = Modifier.size(18.dp)
            )
            Spacer(Modifier.width(7.dp))
            Text(AidenNewWorktreeCopy.TOGGLE, style = MaterialTheme.typography.labelLarge, color = palette.foreground)
        }
    }
}

/** Above the composer while the Mac makes the worktree. Cancel puts the message back. */
@Composable
fun AidenNewWorktreeSetupRow(onCancel: () -> Unit, modifier: Modifier = Modifier) {
    val palette = AidenTheme.palette
    Surface(
        color = palette.raised,
        shape = RoundedCornerShape(16.dp),
        modifier = modifier.fillMaxWidth().testTag(AIDEN_NEW_WORKTREE_SETUP_TAG)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CircularProgressIndicator(color = palette.accent, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(10.dp))
            Text(
                AidenNewWorktreeCopy.SETTING_UP,
                style = MaterialTheme.typography.bodySmall,
                color = palette.foreground,
                modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }
            )
            AidenTonalButton(text = "Cancel", onClick = onCancel)
        }
    }
}
