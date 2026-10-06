package sbtbiswas.AidenOnTheGo.features.remote

import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/** Shared height of the Bots and Workspaces top chrome, below the status bar. */
internal val AidenProductTopBarHeight = 64.dp

internal fun aidenConnectionLabel(state: AidenConnectionState): String = when (state) {
    AidenConnectionState.CONNECTED -> "Connected"
    AidenConnectionState.CONNECTING -> "Connecting"
    AidenConnectionState.OFFLINE -> "Offline"
    AidenConnectionState.NEEDS_PAIRING -> "Needs pairing"
}

/**
 * Top chrome shared by the Bots and Workspaces areas: product switcher, area title with a
 * connection dot, an optional primary action, and trailing actions grouped in one tonal pill.
 */
@Composable
internal fun AidenProductTopBar(
    title: String,
    connectionState: AidenConnectionState,
    productSwitcher: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    primaryAction: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit
) {
    val palette = AidenTheme.palette
    val statusColor = when (connectionState) {
        AidenConnectionState.CONNECTED -> palette.success
        AidenConnectionState.CONNECTING -> palette.accent
        else -> palette.warning
    }
    val statusLabel = aidenConnectionLabel(connectionState)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .fillMaxWidth()
            .height(AidenProductTopBarHeight)
            .padding(start = 8.dp, end = 12.dp)
    ) {
        productSwitcher()
        Spacer(Modifier.width(6.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.weight(1f)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Medium,
                color = palette.foreground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false)
            )
            Spacer(Modifier.width(9.dp))
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(statusColor)
                    .semantics { contentDescription = statusLabel }
            )
        }
        if (primaryAction != null) {
            primaryAction()
            Spacer(Modifier.width(8.dp))
        }
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            shape = CircleShape
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                content = actions
            )
        }
    }
}

/** Icon action inside the [AidenProductTopBar] trailing pill. */
@Composable
internal fun AidenProductTopBarAction(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    tint: Color = AidenTheme.palette.foreground
) {
    val interaction = remember { MutableInteractionSource() }
    IconButton(
        onClick = onClick,
        interactionSource = interaction,
        modifier = Modifier
            .size(AidenUi.MinimumTouchTarget)
            .tactilePress(interaction, targetScale = 0.9f)
            .semantics { role = Role.Button }
    ) {
        Icon(icon, contentDescription = contentDescription, tint = tint, modifier = Modifier.size(21.dp))
    }
}

/** Filled squircle primary action that sits before the trailing pill. */
@Composable
internal fun AidenProductTopBarPrimaryAction(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit
) {
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = onClick,
        shape = AidenShape.Button,
        color = AidenTheme.palette.accent,
        interactionSource = interaction,
        modifier = Modifier
            .size(40.dp)
            .tactilePress(interaction)
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = contentDescription, tint = Color.White, modifier = Modifier.size(22.dp))
        }
    }
}
