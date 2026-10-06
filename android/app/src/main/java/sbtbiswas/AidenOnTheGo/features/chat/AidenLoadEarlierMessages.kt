package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/**
 * Quiet capsule at the top of a windowed transcript that pages back through
 * earlier messages. Shares the raised capsule treatment of the jump-to-latest
 * control so it stays subordinate to the transcript.
 */
@Composable
fun AidenLoadEarlierMessages(
    isLoading: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val label = if (isLoading) "Loading earlier messages" else "Load earlier messages"
    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp),
        contentAlignment = Alignment.Center
    ) {
        Surface(
            onClick = onClick,
            enabled = !isLoading,
            shape = CircleShape,
            color = palette.raised,
            contentColor = palette.secondary,
            modifier = Modifier
                .heightIn(min = 36.dp)
                .semantics {
                    role = Role.Button
                    if (isLoading) stateDescription = "Loading"
                }
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                        color = palette.secondary
                    )
                } else {
                    Icon(
                        imageVector = Icons.Default.ArrowUpward,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp)
                    )
                }
                Text(text = label, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}
