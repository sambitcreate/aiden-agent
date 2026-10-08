package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarColor
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarRecipe
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenBotExpressiveUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun characterResetRestoresTheDefaultLookAndThenDisablesItself() {
        val changes = mutableListOf<AidenBotAvatarRecipe>()
        compose.setContent {
            var recipe by remember {
                mutableStateOf(AidenBotCharacter.DEFAULT.copy(shape = AidenBotAvatarShape.HEX, color = AidenBotAvatarColor.CORAL))
            }
            AidenTheme {
                AidenBotCharacterCard(recipe = recipe, onChange = {
                    changes += it
                    recipe = it
                })
            }
        }

        compose.onNodeWithContentDescription("Hexagon").assertIsSelected()
        compose.onNodeWithTag(AidenBotCharacterTags.RESET).assertIsEnabled().performClick()

        compose.onNodeWithContentDescription("Wisp").assertIsSelected()
        compose.onNodeWithContentDescription("Lilac").assertIsSelected()
        compose.onNodeWithTag(AidenBotCharacterTags.RESET).assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(1, changes.size)
            assertEquals(AidenBotAvatarShape.WISP, changes.single().shape)
            assertEquals(AidenBotAvatarColor.LILAC, changes.single().color)
        }
    }

    @Test
    fun characterShapeChoiceKeepsTheColour() {
        val changes = mutableListOf<AidenBotAvatarRecipe>()
        compose.setContent {
            AidenTheme {
                AidenBotCharacterCard(
                    recipe = AidenBotCharacter.DEFAULT.copy(color = AidenBotAvatarColor.MINT),
                    onChange = { changes += it }
                )
            }
        }
        compose.onNodeWithContentDescription("Triangle").assertIsNotSelected().performClick()
        compose.runOnIdle {
            assertEquals(AidenBotAvatarShape.PEAK, changes.single().shape)
            assertEquals(AidenBotAvatarColor.MINT, changes.single().color)
        }
    }

    @Test
    fun deleteDialogShowsTheExactCopyAndConfirmsOnce() {
        var confirms = 0
        var dismissals = 0
        compose.setContent {
            AidenTheme {
                AidenBotDeleteDialog(
                    name = "Meal Planner",
                    isDeleting = false,
                    onConfirm = { confirms++ },
                    onDismiss = { dismissals++ }
                )
            }
        }

        compose.onNodeWithText("Delete Meal Planner?").assertExists()
        compose.onNodeWithText(
            "This permanently erases Meal Planner's chat, memory, instructions, routines, files, and photo. This can't be undone."
        ).assertExists()
        compose.onNodeWithText("Delete Bot").performClick()
        compose.runOnIdle {
            assertEquals(1, confirms)
            assertEquals(0, dismissals)
        }
    }

    @Test
    fun deleteDialogBlocksASecondConfirmWhileDeleting() {
        var confirms = 0
        compose.setContent {
            AidenTheme {
                AidenBotDeleteDialog(name = "Scout", isDeleting = true, onConfirm = { confirms++ }, onDismiss = {})
            }
        }
        compose.onNodeWithText("Delete Bot").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, confirms) }
    }

    @Test
    fun chatHeaderPillOpensTheProfileAndMenuHidesDeleteWhenUnavailable() {
        var profiles = 0
        compose.setContent {
            AidenTheme {
                AidenBotChatTopBar(
                    identity = AidenBotChatIdentity(botId = "bot-1", name = "Scout", avatar = null),
                    coordinator = null,
                    isStreaming = false,
                    canStop = false,
                    onStop = {},
                    onBack = {},
                    onOpenProfile = { profiles++ },
                    onOpenFiles = {},
                    canDelete = false,
                    onDelete = {}
                )
            }
        }

        compose.onNodeWithText("Scout").assertExists()
        compose.onNodeWithTag(AidenBotChatHeaderTags.PILL).performClick()
        compose.onNodeWithContentDescription("More options").performClick()
        compose.onNodeWithText("Files").assertExists()
        compose.onAllNodesWithText("Delete").assertCountEquals(0)
        compose.onNodeWithText("Profile").performClick()
        compose.runOnIdle { assertEquals(2, profiles) }
    }

    @Test
    fun accessChoiceReportsCustomAndMovesSelection() {
        val changes = mutableListOf<Boolean>()
        compose.setContent {
            var usesFullAccess by remember { mutableStateOf(true) }
            AidenTheme {
                AidenBotAccessChoiceSelector(
                    usesFullAccess = usesFullAccess,
                    onUsesFullAccessChange = {
                        changes += it
                        usesFullAccess = it
                    }
                )
            }
        }

        compose.onNodeWithText("Everything").assertIsSelected()
        compose.onNodeWithText("Only what I pick").assertIsNotSelected().performClick()
        compose.onNodeWithText("Only what I pick").assertIsSelected()
        compose.onNodeWithText("Everything").assertIsNotSelected()
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
