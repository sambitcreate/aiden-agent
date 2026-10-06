package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.models.AidenApprovalDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalPresentation
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScope
import sbtbiswas.AidenOnTheGo.models.AidenPendingApproval
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSplitButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton

/**
 * Approval banner actions: a tonal Deny and a primary one-time allow. When the host
 * offers broader scopes, the allow becomes a split button whose menu lists them.
 */
@Composable
internal fun AidenApprovalActions(
    approval: AidenPendingApproval,
    enabled: Boolean,
    onRespond: (AidenApprovalDecision, AidenApprovalScope) -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val isAutomation = AidenApprovalPresentation.isAutomation(approval.toolName)
    val allowLabel = if (isAutomation) "Approve task" else "Allow once"
    val broaderScopes = approval.scopes.filter { it != AidenApprovalScope.ONCE }
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End
    ) {
        AidenTonalButton(
            text = if (isAutomation) "Cancel" else "Deny",
            onClick = { onRespond(AidenApprovalDecision.DENY, AidenApprovalScope.ONCE) },
            enabled = enabled
        )
        if (!approval.canAllow) return@Row
        Spacer(modifier = Modifier.width(10.dp))
        if (broaderScopes.isEmpty()) {
            AidenPrimaryButton(
                text = allowLabel,
                onClick = { onRespond(AidenApprovalDecision.ALLOW, AidenApprovalScope.ONCE) },
                enabled = enabled
            )
            return@Row
        }
        var scopeMenuOpen by remember(approval.id) { mutableStateOf(false) }
        AidenSplitButton(
            label = allowLabel,
            onClick = { onRespond(AidenApprovalDecision.ALLOW, AidenApprovalScope.ONCE) },
            menuExpanded = scopeMenuOpen && enabled,
            onMenuExpandedChange = { scopeMenuOpen = it },
            menuContentDescription = "More allow options",
            enabled = enabled,
            containerColor = if (enabled) palette.accent else palette.accent.copy(alpha = 0.38f)
        ) {
            broaderScopes.forEach { scope ->
                DropdownMenuItem(
                    text = { Text(AidenApprovalPresentation.scopeTitle(scope)) },
                    onClick = {
                        scopeMenuOpen = false
                        onRespond(AidenApprovalDecision.ALLOW, scope)
                    }
                )
            }
        }
    }
}
