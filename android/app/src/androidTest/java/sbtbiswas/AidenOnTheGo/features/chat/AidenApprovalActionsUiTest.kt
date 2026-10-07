package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
class AidenApprovalActionsUiTest {
    @get:Rule
    val compose = createComposeRule()

    private fun approval(scopes: List<AidenApprovalScope>, canAllow: Boolean = true) = AidenPendingApproval(
        id = "a-1",
        summary = "Run tests",
        toolName = "bash",
        expiresAt = Instant.now().plusSeconds(300),
        canRespond = true,
        hasRequiredWriteCapability = true,
        hostCanAllow = true,
        canAllow = canAllow,
        scopes = scopes
    )

    private fun render(
        approval: AidenPendingApproval,
        enabled: Boolean = true
    ): MutableList<Pair<AidenApprovalDecision, AidenApprovalScope>> {
        val responses = mutableListOf<Pair<AidenApprovalDecision, AidenApprovalScope>>()
        compose.setContent {
            AidenTheme {
                AidenApprovalActions(approval = approval, enabled = enabled, onRespond = { d, s -> responses += d to s })
            }
        }
        return responses
    }

    @Test
    fun primarySegmentAllowsOnceAndMenuOffersOnlyBroaderScopes() {
        val responses = render(approval(listOf(AidenApprovalScope.ONCE, AidenApprovalScope.CHAT, AidenApprovalScope.ALWAYS)))

        compose.onNodeWithText("Allow once").performClick()
        compose.runOnIdle {
            assertEquals(listOf(AidenApprovalDecision.ALLOW to AidenApprovalScope.ONCE), responses)
        }

        compose.onNodeWithContentDescription("More allow options").performClick()
        compose.onNodeWithText("Allow for this chat").assertExists()
        compose.onNodeWithText("Always allow").performClick()
        compose.runOnIdle {
            assertEquals(AidenApprovalDecision.ALLOW to AidenApprovalScope.ALWAYS, responses.last())
            assertEquals(2, responses.size)
        }
        compose.onNodeWithText("Allow for this chat").assertDoesNotExist()
    }

    @Test
    fun oneTimeOnlyApprovalHasNoScopeMenu() {
        val responses = render(approval(listOf(AidenApprovalScope.ONCE)))

        compose.onNodeWithContentDescription("More allow options").assertDoesNotExist()
        compose.onNodeWithText("Deny").performClick()
        compose.runOnIdle {
            assertEquals(listOf(AidenApprovalDecision.DENY to AidenApprovalScope.ONCE), responses)
        }
    }

    @Test
    fun reviewOnlyAllowShowsDenyAlone() {
        render(approval(listOf(AidenApprovalScope.ONCE, AidenApprovalScope.CHAT), canAllow = false))

        compose.onNodeWithText("Deny").assertExists()
        compose.onNodeWithText("Allow once").assertDoesNotExist()
        compose.onNodeWithContentDescription("More allow options").assertDoesNotExist()
    }

    @Test
    fun disconnectedActionsStayInert() {
        val responses = render(approval(listOf(AidenApprovalScope.ONCE, AidenApprovalScope.CHAT)), enabled = false)

        compose.onNodeWithText("Deny").assertIsNotEnabled()
        compose.onNodeWithText("Allow once").assertIsNotEnabled().performClick()
        compose.onNodeWithContentDescription("More allow options").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Allow for this chat").assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<Any>(), responses) }
    }
}
