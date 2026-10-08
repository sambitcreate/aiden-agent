package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.features.chat.AidenApprovalActions
import sbtbiswas.AidenOnTheGo.models.AidenApprovalDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalPresentation
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScope
import sbtbiswas.AidenOnTheGo.models.AidenBotApproval
import sbtbiswas.AidenOnTheGo.models.AidenPendingApproval
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.time.Instant

const val AIDEN_BOT_APPROVAL_CARD_TAG = "bot_session_approval_card"

/** Shown when a Bot approval can only be denied from a phone (Computer Use). */
const val AIDEN_BOT_APPROVAL_DENY_ONLY = "Allow this on your Mac. You can deny it here."

/**
 * The workspace chat's approval presentation for a Bot's waiting tool approval: a Bot
 * approval has no deadline and no broader scopes, and Allow is absent when it can only be
 * denied from a phone.
 */
fun aidenBotPendingApproval(approval: AidenBotApproval): AidenPendingApproval = AidenPendingApproval(
    id = approval.waitId,
    summary = approval.summary,
    toolName = approval.toolName,
    expiresAt = Instant.MAX,
    canRespond = true,
    hasRequiredWriteCapability = true,
    hostCanAllow = approval.canAllow,
    canAllow = approval.canAllow,
    scopes = listOf(AidenApprovalScope.ONCE)
)

@Composable
fun AidenBotApprovalCard(
    approval: AidenBotApproval,
    enabled: Boolean,
    onRespond: (AidenApprovalDecision) -> Unit
) {
    val palette = AidenTheme.palette
    val pending = aidenBotPendingApproval(approval)
    Surface(
        color = palette.raised,
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth().testTag(AIDEN_BOT_APPROVAL_CARD_TAG)
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Default.Warning, contentDescription = null, tint = palette.warning, modifier = Modifier.size(18.dp))
                Text(
                    text = AidenApprovalPresentation.title(approval.toolName),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = palette.warning
                )
            }
            Text(
                text = AidenApprovalPresentation.oneLineSummary(approval.summary),
                style = MaterialTheme.typography.bodySmall,
                color = palette.foreground
            )
            if (!approval.canAllow) {
                Text(AIDEN_BOT_APPROVAL_DENY_ONLY, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            }
            AidenApprovalActions(
                approval = pending,
                enabled = enabled,
                onRespond = { decision, _ -> onRespond(decision) }
            )
        }
    }
}
