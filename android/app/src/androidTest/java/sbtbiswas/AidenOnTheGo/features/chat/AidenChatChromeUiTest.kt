package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductSwitcher
import sbtbiswas.AidenOnTheGo.persistence.AidenProductArea
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenChatChromeUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun jumpToLatestIsAnArrowOnlyAction() {
        compose.setContent {
            AidenTheme {
                AidenJumpToBottom(
                    visible = true,
                    onClick = {}
                )
            }
        }

        compose.onNodeWithContentDescription("Jump to latest")
            .assertIsDisplayed()
            .assertHasClickAction()
        compose.onNodeWithText("Jump to latest").assertDoesNotExist()
        compose.onNodeWithText("New tokens").assertDoesNotExist()
    }

    @Test
    fun productSwitcherKeepsTextOptionsAndSelectionState() {
        compose.setContent {
            AidenTheme {
                AidenProductSwitcher(
                    activeArea = AidenProductArea.BOTS,
                    onAreaSelected = {}
                )
            }
        }

        compose.onNodeWithContentDescription(
            "Aiden. Current area: Bots. Choose Bots or Workspaces."
        ).performClick()

        compose.onNodeWithText("Bots").assertIsDisplayed()
        compose.onNodeWithText("Workspaces").assertIsDisplayed()
        compose.onNodeWithContentDescription("Selected").assertIsDisplayed()
    }
}
