package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Shield
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceConfig
import sbtbiswas.AidenOnTheGo.features.remote.AidenBotChatToolsBar
import sbtbiswas.AidenOnTheGo.features.remote.AidenBotChatToolsTags
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarColor
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarDetail
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarEyes
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarRecipe
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarShape
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarView
import sbtbiswas.AidenOnTheGo.models.AidenBotHealth
import sbtbiswas.AidenOnTheGo.models.AidenBotSemanticAvatar
import sbtbiswas.AidenOnTheGo.models.AidenBotSummary
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenBotExpressiveUiTest {
    @get:Rule
    val compose = createComposeRule()

    private fun bot() = AidenBotSummary(
        id = "bot-1",
        name = "Scout",
        purpose = "Finds things",
        avatar = AidenBotAvatarView(
            semantic = AidenBotSemanticAvatar.Recipe(
                AidenBotAvatarRecipe(
                    shape = AidenBotAvatarShape.ORB,
                    color = AidenBotAvatarColor.LILAC,
                    eyes = AidenBotAvatarEyes.HAPPY,
                    detail = AidenBotAvatarDetail.HALO
                )
            )
        ),
        health = AidenBotHealth.READY,
        createdAt = Instant.EPOCH,
        updatedAt = Instant.EPOCH,
        revision = "r1"
    )

    @Test
    fun toolsBarShowsTheBotAvatarWhenABotIsKnown() {
        compose.setContent {
            AidenTheme { AidenBotChatToolsBar(bot = bot(), onOpenAccess = {}, onOpenProfile = {}) }
        }

        compose.onNodeWithTag(AidenBotChatToolsTags.AVATAR).assertExists()
        compose.onAllNodesWithTag(AidenBotChatToolsTags.GENERIC_ICON).assertCountEquals(0)
        compose.onNodeWithText("Scout").assertExists()
    }

    @Test
    fun toolsBarFallsBackToTheGenericIconWithoutABot() {
        compose.setContent {
            AidenTheme { AidenBotChatToolsBar(bot = null, onOpenAccess = {}, onOpenProfile = {}) }
        }

        compose.onNodeWithTag(AidenBotChatToolsTags.GENERIC_ICON).assertExists()
        compose.onAllNodesWithTag(AidenBotChatToolsTags.AVATAR).assertCountEquals(0)
        compose.onNodeWithText("Bot").assertExists()
    }

    @Test
    fun toolsBarActionsEachFireOnceAndFilesStaysHiddenWithoutAGrant() {
        var access = 0
        var profile = 0
        compose.setContent {
            AidenTheme {
                AidenBotChatToolsBar(
                    bot = bot(),
                    onOpenAccess = { access++ },
                    onOpenProfile = { profile++ },
                    onOpenFiles = {}
                )
            }
        }

        compose.onAllNodesWithContentDescription("Files").assertCountEquals(0)
        compose.onNodeWithContentDescription("Access").performClick()
        compose.onNodeWithContentDescription("Profile").performClick()
        compose.runOnIdle {
            assertEquals(1, access)
            assertEquals(1, profile)
        }
    }

    @Test
    fun profileActionBarFiresOnceAndBlocksDisabledActions() {
        var chats = 0
        var edits = 0
        compose.setContent {
            AidenTheme(config = AidenAppearanceConfig(reduceMotion = true)) {
                AidenBotProfileActionBar(
                    actions = listOf(
                        AidenBotProfileAction(label = "Chat", icon = Icons.Default.Edit, enabled = false, emphasized = true, onClick = { chats++ }),
                        AidenBotProfileAction(label = "Edit", icon = Icons.Default.Shield, onClick = { edits++ })
                    )
                )
            }
        }

        compose.onNodeWithText("Chat").assertIsNotEnabled()
        compose.onNodeWithText("Edit").performClick()
        compose.runOnIdle {
            assertEquals(0, chats)
            assertEquals(1, edits)
        }
    }

    @Test
    fun accessModeSelectorReportsCustomAccessAndMovesSelection() {
        val changes = mutableListOf<Boolean>()
        compose.setContent {
            var usesFullAccess by remember { mutableStateOf(true) }
            AidenTheme {
                AidenBotEditorAccessModeSelector(
                    usesFullAccess = usesFullAccess,
                    onUsesFullAccessChange = {
                        changes += it
                        usesFullAccess = it
                    }
                )
            }
        }

        compose.onNodeWithText("Full Access").assertIsSelected()
        compose.onNodeWithText("Full Access").performClick()
        compose.onNodeWithText("Custom Access").assertIsNotSelected().performClick()

        compose.onNodeWithText("Custom Access").assertIsSelected()
        compose.onNodeWithText("Full Access").assertIsNotSelected()
        compose.runOnIdle { assertEquals(listOf(false), changes) }
    }

    @Test
    fun colorSwatchExposesSelectionAndSelectsOnTap() {
        compose.setContent {
            var selected by remember { mutableStateOf(AidenBotAvatarColor.LILAC) }
            AidenTheme {
                Row {
                    listOf(AidenBotAvatarColor.LILAC, AidenBotAvatarColor.MINT).forEach { color ->
                        AidenBotColorSwatch(color = color, selected = selected == color, onClick = { selected = color })
                    }
                }
            }
        }

        compose.onNodeWithContentDescription("Lilac").assertIsSelected()
        compose.onNodeWithContentDescription("Mint").assertIsNotSelected().performClick()
        compose.onNodeWithContentDescription("Mint").assertIsSelected()
        compose.onNodeWithContentDescription("Lilac").assertIsNotSelected()
    }
}
