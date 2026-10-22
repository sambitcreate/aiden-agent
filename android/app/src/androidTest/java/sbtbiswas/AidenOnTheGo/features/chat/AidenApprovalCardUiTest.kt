package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenApprovalDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScope
import sbtbiswas.AidenOnTheGo.models.AidenPendingApproval
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenApprovalCardUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun anExpandedLongCommandLeavesTheCollapseAndDecisionControlsOnScreen() {
        val command = (1..80).joinToString("\n") { "echo step $it" }
        val approval = AidenPendingApproval(
            id = "a-1",
            summary = "Run command: $command",
            toolName = "run_command",
            expiresAt = Instant.now().plusSeconds(300),
            canRespond = true,
            hasRequiredWriteCapability = true,
            hostCanAllow = true,
            canAllow = true
        )
        val responses = mutableListOf<Pair<AidenApprovalDecision, AidenApprovalScope>>()
        compose.setContent {
            AidenTheme {
                // The chat's bottom bar does not scroll; this is about the height it has on a phone.
                Column(Modifier.fillMaxWidth().height(560.dp)) {
                    AidenApprovalCardContent(
                        approval = approval,
                        enabled = true,
                        onRespond = { decision, scope -> responses += decision to scope },
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }

        compose.onNodeWithText("Show all").performClick()

        compose.onNodeWithText("Show less").assertIsDisplayed()
        compose.onNodeWithText("Deny").assertIsDisplayed()
        compose.onNodeWithText("Allow once").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals(listOf(AidenApprovalDecision.ALLOW to AidenApprovalScope.ONCE), responses)
        }
    }
}
