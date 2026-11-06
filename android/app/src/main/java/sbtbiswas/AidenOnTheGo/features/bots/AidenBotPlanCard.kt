package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.*
import java.time.Instant
import kotlin.math.ceil

/** Bounded keyboard/assistive-scrollable review with decisions outside its scroll area. */
@Composable
fun AidenBotPlanCard(plan: AidenRemoteBotPlan, botName: String, canAnswer: Boolean, error: String?, onRespond: (AidenBotPlanDecision) -> Unit) {
    val palette = AidenTheme.palette
    if (plan.status != AidenBotPlanStatus.PENDING && plan.status != AidenBotPlanStatus.ACTIVE) {
        Text("Plan ended · ${plan.completedSteps} of ${plan.steps.size} steps", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        return
    }
    var detailsShown by remember(plan.planId) { mutableStateOf(false) }
    var now by remember(plan.planId) { mutableStateOf(Instant.now()) }
    LaunchedEffect(plan.planId, plan.status, plan.expiresAt) {
        if (plan.status == AidenBotPlanStatus.ACTIVE) while (true) { now = Instant.now(); delay(60_000) }
    }
    Surface(color = palette.raised, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().testTag("bot_session_plan_card")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.fillMaxWidth().heightIn(max = 240.dp).verticalScroll(rememberScrollState()).focusable(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(plan.from?.let { "$it asked $botName to do this" } ?: "$botName has a plan", style = MaterialTheme.typography.labelSmall, color = palette.secondary)
                Text(plan.title, style = MaterialTheme.typography.titleSmall, color = palette.foreground)
                Text(plan.why, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                if (plan.status == AidenBotPlanStatus.ACTIVE) {
                    val minutes = plan.expiry?.let { ceil((it.toEpochMilli() - now.toEpochMilli()) / 60_000.0).toInt().coerceAtLeast(0) }
                    Text(minutes?.let { "Approved · ends in $it min" } ?: "Approved", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                }
                plan.steps.forEachIndexed { index, step ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (plan.status == AidenBotPlanStatus.PENDING) Text("${index + 1}.", color = palette.foreground)
                        else Icon(when (step.status) { AidenBotPlanStepStatus.DONE -> Icons.Outlined.CheckCircle; AidenBotPlanStepStatus.SKIPPED -> Icons.Outlined.RemoveCircleOutline; AidenBotPlanStepStatus.PENDING -> Icons.Outlined.RadioButtonUnchecked },
                            contentDescription = when (step.status) { AidenBotPlanStepStatus.DONE -> "Done"; AidenBotPlanStepStatus.SKIPPED -> "Skipped"; AidenBotPlanStepStatus.PENDING -> "Pending" }, tint = palette.secondary)
                        Text(step.text, style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
                    }
                }
                plan.items.forEach { item ->
                    Text(item.line, style = MaterialTheme.typography.bodySmall, color = palette.foreground)
                    if (plan.status == AidenBotPlanStatus.ACTIVE && item.used != null && item.max != null)
                        Text("${item.used} of ${item.max} used", style = MaterialTheme.typography.labelSmall, color = palette.secondary)
                    if (detailsShown) item.details.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = palette.secondary) }
                }
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = palette.danger, modifier = Modifier.testTag("bot_plan_error")) }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (plan.status == AidenBotPlanStatus.PENDING) {
                    AidenPrimaryButton("Approve plan", enabled = canAnswer, onClick = { onRespond(AidenBotPlanDecision.APPROVE) })
                    AidenTonalButton("Not now", enabled = canAnswer, onClick = { onRespond(AidenBotPlanDecision.NOT_NOW) })
                } else AidenTonalButton("Stop plan", enabled = canAnswer, onClick = { onRespond(AidenBotPlanDecision.STOP) })
                AidenTonalButton(if (detailsShown) "Hide details" else "Show details", modifier = Modifier.semantics { stateDescription = if (detailsShown) "Expanded" else "Collapsed" }, onClick = { detailsShown = !detailsShown })
            }
        }
    }
}
