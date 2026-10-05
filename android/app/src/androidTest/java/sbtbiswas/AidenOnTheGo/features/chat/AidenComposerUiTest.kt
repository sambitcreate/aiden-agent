package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenComposerSuggestion
import sbtbiswas.AidenOnTheGo.models.AidenRemoteSkillCatalogEntry
import sbtbiswas.AidenOnTheGo.models.AidenRemoteSkillSource
import sbtbiswas.AidenOnTheGo.models.AidenStreamInputMode
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenComposerUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun attachmentButtonOffersSeparatePhotoAndFileActions() {
        var imageClicks = 0
        var fileClicks = 0
        compose.setContent {
            AidenTheme {
                AidenComposerView(
                    draft = "",
                    onDraftChange = {},
                    onSend = {},
                    onStop = {},
                    canSend = false,
                    isStreaming = false,
                    isVoiceListening = false,
                    onToggleVoice = {},
                    onAddImage = { imageClicks++ },
                    onAddFile = { fileClicks++ }
                )
            }
        }

        compose.onNodeWithContentDescription("Add attachment")
            .assertIsEnabled()
            .performClick()
        compose.onNodeWithText("Photo Library").assertExists().performClick()
        compose.runOnIdle { assertEquals(1, imageClicks) }

        compose.onNodeWithContentDescription("Add attachment").performClick()
        compose.onNodeWithText("Choose File").assertExists().performClick()
        compose.runOnIdle { assertEquals(1, fileClicks) }
    }

    /** Hosts the busy composer with the mode held the way the chat screen
     * holds it, so relabelling is observable. */
    private fun setBusyComposer(
        draft: String,
        canSubmitRunInput: Boolean,
        submitted: MutableList<AidenStreamInputMode>,
        onStop: () -> Unit = {}
    ) {
        compose.setContent {
            var mode by remember { mutableStateOf(AidenStreamInputMode.QUEUE) }
            AidenTheme {
                AidenComposerView(
                    draft = draft,
                    onDraftChange = {},
                    onSend = {},
                    onStop = onStop,
                    canStop = true,
                    canSend = false,
                    isStreaming = true,
                    showsRunInputOptions = true,
                    canSubmitRunInput = canSubmitRunInput,
                    onSubmitRunInput = { submitted += it },
                    runInputMode = mode,
                    onRunInputModeChange = { mode = it },
                    isVoiceListening = false,
                    onToggleVoice = {}
                )
            }
        }
    }

    @Test
    fun busyPillDefaultsToQueueAndItsLabelSubmitsTheCurrentMode() {
        val submitted = mutableListOf<AidenStreamInputMode>()
        var stopClicks = 0
        setBusyComposer(draft = "hold on", canSubmitRunInput = true, submitted = submitted, onStop = { stopClicks++ })

        // Stop stays its own control next to the pill.
        compose.onNodeWithContentDescription("Stop generation").assertIsEnabled()
        compose.onNodeWithContentDescription("Queue message").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(listOf(AidenStreamInputMode.QUEUE), submitted)
            assertEquals(0, stopClicks)
        }
        // A plain tap sends; it does not open the mode menu.
        compose.onNodeWithText("Run after this response").assertDoesNotExist()
    }

    @Test
    fun chevronOffersOnlySteerAndQueueAndPickingSteerWithADraftSendsAndRelabels() {
        val submitted = mutableListOf<AidenStreamInputMode>()
        setBusyComposer(draft = "hold on", canSubmitRunInput = true, submitted = submitted)

        compose.onNodeWithContentDescription("Choose message action").assertIsEnabled().performClick()
        compose.onAllNodes(isSelectable()).assertCountEquals(2)
        compose.onNode(hasText("Steer") and hasText("Add guidance without stopping")).assertIsNotSelected()
        compose.onNode(hasText("Queue") and hasText("Run after this response")).assertIsSelected()
        compose.onAllNodes(hasText("Redirect", substring = true, ignoreCase = true)).assertCountEquals(0)

        compose.onNodeWithText("Steer").performClick()
        compose.runOnIdle { assertEquals(listOf(AidenStreamInputMode.STEER), submitted) }
        compose.onNodeWithText("Add guidance without stopping").assertDoesNotExist()
        compose.onNodeWithContentDescription("Queue message").assertDoesNotExist()

        // The chosen mode sticks: the next label tap steers again.
        compose.onNodeWithContentDescription("Steer response").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(listOf(AidenStreamInputMode.STEER, AidenStreamInputMode.STEER), submitted)
        }
    }

    @Test
    fun withAnEmptyDraftThePillIsDimmedAndPickingAModeOnlySwitches() {
        val submitted = mutableListOf<AidenStreamInputMode>()
        setBusyComposer(draft = "", canSubmitRunInput = false, submitted = submitted)

        compose.onNodeWithContentDescription("Queue message").assertIsNotEnabled().performClick()
        compose.runOnIdle { assertEquals(emptyList<AidenStreamInputMode>(), submitted) }

        compose.onNodeWithContentDescription("Choose message action").assertIsEnabled().performClick()
        compose.onNodeWithText("Steer").performClick()
        compose.onNodeWithContentDescription("Steer response").assertExists()
        compose.runOnIdle { assertEquals(emptyList<AidenStreamInputMode>(), submitted) }
    }

    @Test
    fun longPressingThePillLabelOpensTheModeMenuWithoutSending() {
        val submitted = mutableListOf<AidenStreamInputMode>()
        setBusyComposer(draft = "hold on", canSubmitRunInput = true, submitted = submitted)

        compose.onNodeWithContentDescription("Queue message").performTouchInput { longClick() }
        compose.onNodeWithText("Run after this response").assertExists()
        compose.onNodeWithText("Add guidance without stopping").assertExists()
        compose.runOnIdle { assertEquals(emptyList<AidenStreamInputMode>(), submitted) }
    }

    @Test
    fun busyComposerKeepsStopOnlyWithoutRunInputSupport() {
        compose.setContent {
            AidenTheme {
                AidenComposerView(
                    draft = "hold on",
                    onDraftChange = {},
                    onSend = {},
                    onStop = {},
                    canStop = true,
                    canSend = false,
                    isStreaming = true,
                    showsRunInputOptions = false,
                    isVoiceListening = false,
                    onToggleVoice = {}
                )
            }
        }

        compose.onNodeWithContentDescription("Stop generation").assertIsEnabled()
        compose.onNodeWithContentDescription("Queue message").assertDoesNotExist()
        compose.onNodeWithContentDescription("Choose message action").assertDoesNotExist()
    }

    @Test
    fun skillPaletteListsBoundedRowsAndHonorsAvailability() {
        val selected = mutableListOf<AidenComposerSuggestion>()
        val available = AidenRemoteSkillCatalogEntry(
            invocationId = "sk1_${"a".repeat(43)}",
            name = "review-code",
            description = "Review changes.",
            source = AidenRemoteSkillSource.WORKSPACE,
            available = true,
            unavailableReason = null
        )
        val unavailable = AidenRemoteSkillCatalogEntry(
            invocationId = "sk1_${"b".repeat(43)}",
            name = "ship",
            description = "Ship it.",
            source = AidenRemoteSkillSource.CONFIGURED,
            available = false,
            unavailableReason = "Shadowed."
        )
        var cleared = false
        compose.setContent {
            AidenTheme {
                AidenComposerView(
                    draft = "/re",
                    onDraftChange = {},
                    onSend = {},
                    onStop = {},
                    canSend = false,
                    isStreaming = false,
                    isVoiceListening = false,
                    onToggleVoice = {},
                    selectedSkill = available,
                    onClearSkill = { cleared = true },
                    composerSuggestions = listOf(
                        AidenComposerSuggestion.Skill(available),
                        AidenComposerSuggestion.Skill(unavailable)
                    ),
                    onSelectSuggestion = { selected += it }
                )
            }
        }

        compose.onNodeWithContentDescription("Skill review-code").assertExists()
        compose.onNodeWithContentDescription("Skill ship, unavailable").assertExists()
        // Unavailable rows stay visible but do not select.
        compose.onNodeWithContentDescription("Skill ship, unavailable").assertIsNotEnabled().performClick()
        compose.runOnIdle { assertEquals(emptyList<AidenComposerSuggestion>(), selected) }
        compose.onNodeWithContentDescription("Skill review-code").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(1, selected.size) }
        // The selected-skill chip clears without touching the draft.
        compose.onNodeWithContentDescription("Remove skill review-code").performClick()
        compose.runOnIdle { assertEquals(true, cleared) }
    }
}
