package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
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

    private val responses = mutableListOf<Pair<AidenApprovalDecision, AidenApprovalScope>>()

    private fun commandApproval(id: String, lines: Int) = AidenPendingApproval(
        id = id,
        summary = "Run command: " + (1..lines).joinToString("\n") { "echo step $it" },
        toolName = "run_command",
        expiresAt = Instant.now().plusSeconds(300),
        canRespond = true,
        hasRequiredWriteCapability = true,
        hostCanAllow = true,
        canAllow = true
    )

    private fun showCommand(lines: Int): MutableState<AidenPendingApproval> {
        val shown = mutableStateOf(commandApproval(id = "a-1", lines = lines))
        compose.setContent {
            AidenTheme {
                // The chat's bottom bar does not scroll; this is about the height it has on a phone.
                Column(Modifier.fillMaxWidth().height(560.dp)) {
                    AidenApprovalCardContent(
                        approval = shown.value,
                        enabled = true,
                        onRespond = { decision, scope -> responses += decision to scope },
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
        return shown
    }

    @Test
    fun anExpandedLongCommandLeavesTheCollapseAndDecisionControlsOnScreen() {
        showCommand(lines = 80)

        compose.onNodeWithText("Show all").performClick()

        compose.onNodeWithText("Show less").assertIsDisplayed()
        compose.onNodeWithText("Deny").assertIsDisplayed()
        compose.onNodeWithText("Allow once").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals(listOf(AidenApprovalDecision.ALLOW to AidenApprovalScope.ONCE), responses)
        }
    }

    @Test
    fun anExpandedCommandSaysWhenItsEndIsBelowTheFold() {
        showCommand(lines = 80)
        compose.onNodeWithText("Scroll for more").assertDoesNotExist()

        compose.onNodeWithText("Show all").performClick()
        compose.onNodeWithText("Scroll for more").assertIsDisplayed()

        // Once the last line is in view there is nothing more to scroll to.
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Scroll for more").assertDoesNotExist()
    }

    @Test
    fun theNextApprovalOpensAtTheStartOfItsRequest() {
        val shown = showCommand(lines = 80)
        compose.onNodeWithText("Show all").performClick()
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Scroll for more").assertDoesNotExist()

        compose.runOnIdle { shown.value = commandApproval(id = "a-2", lines = 80) }
        compose.onNodeWithText("Show all").performClick()

        // Its first lines are in view, not wherever the last request was left.
        compose.onNodeWithText("Scroll for more").assertIsDisplayed()
    }

    @Test
    fun anExpandedCommandThatFitsHasNoScrollCue() {
        showCommand(lines = 8)

        compose.onNodeWithText("Show all").performClick()

        compose.onNodeWithText("Show less").assertIsDisplayed()
        compose.onNodeWithText("Scroll for more").assertDoesNotExist()
    }
}
