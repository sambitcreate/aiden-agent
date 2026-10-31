package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MonetizationOn
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.models.AidenSpending
import sbtbiswas.AidenOnTheGo.models.AidenSpendingCopy
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

const val AIDEN_SPENDING_NOTICE_TAG = "aiden-spending-notice"

/**
 * Revision 47: a quiet line from 80% of the limit; once it is reached, a card with Allow
 * more. Status lives in the icon's tint, never in a border.
 */
@Composable
fun AidenSpendingNotice(
    spending: AidenSpending,
    botName: String?,
    isAllowing: Boolean,
    canAllow: Boolean,
    errorMessage: String?,
    onAllowMore: () -> Unit,
    modifier: Modifier = Modifier
) {
    val notice = AidenSpendingCopy.notice(spending, botName) ?: return
    val palette = AidenTheme.palette
    if (spending.state == AidenSpending.State.NEARING) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp).testTag(AIDEN_SPENDING_NOTICE_TAG)
        ) {
            Icon(Icons.Outlined.MonetizationOn, contentDescription = null, tint = palette.warning, modifier = Modifier.size(16.dp))
            Text(notice.title, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        }
        return
    }
    Surface(
        color = palette.raised,
        shape = MaterialTheme.shapes.large,
        modifier = modifier.fillMaxWidth().testTag(AIDEN_SPENDING_NOTICE_TAG)
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.MonetizationOn, contentDescription = null, tint = palette.warning, modifier = Modifier.size(20.dp))
                Text(notice.title, style = MaterialTheme.typography.bodyLarge, color = palette.foreground)
            }
            Text(notice.body, style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
            if (errorMessage != null) {
                Text(errorMessage, style = MaterialTheme.typography.bodyMedium, color = palette.danger)
            }
            AidenPrimaryButton(text = notice.allowMore, enabled = canAllow && !isAllowing, onClick = onAllowMore)
        }
    }
}
