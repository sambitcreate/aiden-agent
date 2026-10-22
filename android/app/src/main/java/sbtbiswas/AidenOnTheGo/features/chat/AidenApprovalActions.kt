package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R

private val ApprovalActionHeight = 48.dp

/**
 * Approval card actions: a tonal Deny and a primary one-time allow, sharing the width
 * equally. When the host offers broader scopes, the allow becomes a split button whose
 * menu lists them.
 */
@Composable
internal fun AidenApprovalActions(
    approval: AidenPendingApproval,
    enabled: Boolean,
    onRespond: (AidenApprovalDecision, AidenApprovalScope) -> Unit,
    modifier: Modifier = Modifier
) {
    val isAutomation = AidenApprovalPresentation.isAutomation(approval.toolName)
    val allowLabel = if (isAutomation) stringResource(R.string.chat_approval_approve_task) else stringResource(R.string.chat_approval_allow_once)
    val broaderScopes = approval.scopes.filter { it != AidenApprovalScope.ONCE }
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        AidenTonalButton(
            text = if (isAutomation) stringResource(R.string.action_cancel) else stringResource(R.string.chat_approval_deny),
            onClick = { onRespond(AidenApprovalDecision.DENY, AidenApprovalScope.ONCE) },
            enabled = enabled,
            modifier = Modifier.weight(1f).height(ApprovalActionHeight)
        )
        if (!approval.canAllow) return@Row
        if (broaderScopes.isEmpty()) {
            AidenPrimaryButton(
                text = allowLabel,
                onClick = { onRespond(AidenApprovalDecision.ALLOW, AidenApprovalScope.ONCE) },
                enabled = enabled,
                modifier = Modifier.weight(1f).height(ApprovalActionHeight)
            )
            return@Row
        }
        var scopeMenuOpen by remember(approval.id) { mutableStateOf(false) }
        AidenSplitButton(
            label = allowLabel,
            onClick = { onRespond(AidenApprovalDecision.ALLOW, AidenApprovalScope.ONCE) },
            menuExpanded = scopeMenuOpen && enabled,
            onMenuExpandedChange = { scopeMenuOpen = it },
            menuContentDescription = stringResource(R.string.chat_approval_more_options),
            enabled = enabled,
            height = ApprovalActionHeight,
            fillWidth = true,
            modifier = Modifier.weight(1f)
        ) {
            broaderScopes.forEach { scope ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(AidenApprovalPresentation.scopeTitle(scope))
                            AidenApprovalPresentation.scopeDetail(scope)?.let { detail ->
                                Text(
                                    detail,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = AidenTheme.palette.secondary
                                )
                            }
                        }
                    },
                    onClick = {
                        scopeMenuOpen = false
                        onRespond(AidenApprovalDecision.ALLOW, scope)
                    }
                )
            }
        }
    }
}
