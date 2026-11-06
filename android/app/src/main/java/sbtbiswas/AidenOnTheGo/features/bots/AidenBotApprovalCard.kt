package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.features.chat.AidenApprovalCardContent
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScope
import sbtbiswas.AidenOnTheGo.models.AidenApprovalDecision
import sbtbiswas.AidenOnTheGo.models.AidenBotApproval
import sbtbiswas.AidenOnTheGo.models.AidenPendingApproval
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.time.Instant

const val AIDEN_BOT_APPROVAL_CARD_TAG = "bot_session_approval_card"

/**
 * The workspace chat's approval presentation for a Bot's waiting tool approval: a Bot
 * approval has no deadline; Remote 57 offers a separate host-granted Always action, and Allow is absent when it can only be
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
    onRespond: (AidenApprovalDecision) -> Unit,
    botName: String = "Bot",
    allowedSupported: Boolean = false,
    onAlways: () -> Unit = {}
) {
    Surface(
        color = AidenTheme.palette.raised,
        shape = RoundedCornerShape(24.dp),
        modifier = Modifier.fillMaxWidth().testTag(AIDEN_BOT_APPROVAL_CARD_TAG)
    ) {
        androidx.compose.foundation.layout.Column {
        if (allowedSupported && approval.alwaysCount != null) {
            androidx.compose.material3.Text("You’ve allowed this ${approval.alwaysCount} times in the last 2 weeks.",color = AidenTheme.palette.secondary,modifier = Modifier.padding(16.dp))
            androidx.compose.material3.TextButton(enabled = enabled,onClick = onAlways) { androidx.compose.material3.Text("Always allow for $botName") }
        }
        AidenApprovalCardContent(
            approval = aidenBotPendingApproval(approval),
            enabled = enabled,
            onRespond = { decision, _ -> onRespond(decision) },
            modifier = Modifier.padding(16.dp)
        )
        }
    }
}
