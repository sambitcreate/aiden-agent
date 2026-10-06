package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceConfig
import sbtbiswas.AidenOnTheGo.models.AidenComposerSuggestion
import sbtbiswas.AidenOnTheGo.models.AidenModel
import sbtbiswas.AidenOnTheGo.models.AidenProvider
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
    fun onAPhoneWidthWorkspaceChatTheModelPickerShrinksBeforeThePillAndStop() {
        val model = AidenModel(
            id = "long",
            label = "A very long model name that would fill the whole row",
            thinkingLevels = listOf("high")
        )
        val provider = AidenProvider(id = "custom", label = "Custom", models = listOf(model))
        compose.setContent {
            AidenTheme {
                Box(Modifier.width(360.dp)) {
                    AidenComposerView(
                        draft = "hold on",
                        onDraftChange = {},
                        onSend = {},
                        onStop = {},
                        canStop = true,
                        canSend = false,
                        isStreaming = true,
                        showsRunInputOptions = true,
                        canSubmitRunInput = true,
                        runInputMode = AidenStreamInputMode.QUEUE,
                        selectedProvider = provider,
                        selectedModel = model,
                        selectedThinkingLevel = "high",
                        availableProviders = listOf(provider),
                        onSelectModel = { _, _, _ -> },
                        isVoiceListening = false,
                        onToggleVoice = {}
                    )
                }
            }
        }

        val rowRight = compose.onRoot().getBoundsInRoot().right
        for (description in listOf("Queue message", "Choose message action", "Stop generation")) {
            val node = compose.onNodeWithContentDescription(description).assertIsDisplayed()
            val bounds = node.getBoundsInRoot()
            val width = bounds.right - bounds.left
            val height = bounds.bottom - bounds.top
            assertTrue("$description is $width wide", width >= 44.dp)
            assertTrue("$description is $height tall", height >= 44.dp)
            assertTrue("$description stays inside the row", bounds.right <= rowRight)
        }
        // The picker stays a recognizable control: a usable target with its chevron whole.
        val picker = compose.onNodeWithContentDescription("Select model").assertIsDisplayed().getBoundsInRoot()
        assertTrue("model picker is ${picker.right - picker.left} wide", picker.right - picker.left >= 48.dp)
        val chevron = compose.onNodeWithContentDescription("Select model", useUnmergedTree = true).getBoundsInRoot()
        assertTrue("model chevron is ${chevron.right - chevron.left} wide", chevron.right - chevron.left >= 13.dp)
        // Dictation is off while the response streams, so its button gives way to the pill.
        compose.onNodeWithContentDescription("Start voice input").assertDoesNotExist()
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

    @Test
    fun sendAndStopEachFireOncePerTap() {
        var sends = 0
        var stops = 0
        var streaming by mutableStateOf(false)
        compose.setContent {
            AidenTheme {
                AidenComposerView(
                    draft = "ship it",
                    onDraftChange = {},
                    onSend = { sends++ },
                    onStop = { stops++ },
                    canSend = !streaming,
                    isStreaming = streaming,
                    isVoiceListening = false,
                    onToggleVoice = {}
                )
            }
        }

        compose.onNodeWithContentDescription("Send message").assertHasClickAction().performClick()
        compose.runOnIdle {
            assertEquals(1, sends)
            streaming = true
        }
        compose.onNodeWithContentDescription("Stop generation").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(1, sends)
            assertEquals(1, stops)
        }
    }

    private class PickedModel(val providerId: String, val modelId: String, val thinkingLevel: String?)

    private fun setModelPickerComposer(
        providers: List<AidenProvider>,
        picks: MutableList<PickedModel>
    ) {
        compose.setContent {
            var provider by remember { mutableStateOf(providers.first()) }
            var model by remember { mutableStateOf(providers.first().models.first()) }
            var level by remember { mutableStateOf(providers.first().models.first().thinkingLevels?.lastOrNull()) }
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
                    selectedProvider = provider,
                    selectedModel = model,
                    selectedThinkingLevel = level,
                    availableProviders = providers,
                    onSelectModel = { p, m, l ->
                        picks += PickedModel(p.id, m.id, l)
                        provider = p
                        model = m
                        level = l
                    }
                )
            }
        }
    }

    @Test
    fun modelSheetSetsThinkingInPlaceAndPicksModelsFromRadioRows() {
        val fast = AidenModel(id = "fast", label = "Fast model", thinkingLevels = listOf("low", "medium", "high"))
        val deep = AidenModel(id = "deep", label = "Deep model")
        val picks = mutableListOf<PickedModel>()
        setModelPickerComposer(listOf(AidenProvider(id = "custom", label = "Custom", models = listOf(fast, deep))), picks)

        compose.onNodeWithContentDescription("Select model").performClick()
        compose.onNodeWithText("Model & Thinking").assertIsDisplayed()

        // Effort is one connected radio group: exactly one segment is chosen.
        compose.onNode(hasText("High") and isSelectable()).assertIsSelected()
        compose.onNode(hasText("Low") and isSelectable()).assertIsNotSelected()
        compose.onNode(hasText("Low") and isSelectable()).performClick()
        compose.runOnIdle {
            assertEquals(1, picks.size)
            assertEquals("fast", picks.single().modelId)
            assertEquals("low", picks.single().thinkingLevel)
        }
        // Thinking applies in place, so the sheet stays open on the new choice.
        compose.onNode(hasText("Low") and isSelectable()).assertIsSelected()
        compose.onNode(hasText("High") and isSelectable()).assertIsNotSelected()

        compose.onNode(hasText("Fast model") and isSelectable()).assertIsSelected()
        compose.onNode(hasText("Deep model") and isSelectable()).assertIsNotSelected().performClick()
        compose.runOnIdle {
            assertEquals(2, picks.size)
            assertEquals("deep", picks.last().modelId)
            assertEquals(null, picks.last().thinkingLevel)
        }
        // Picking a model applies it and closes the sheet.
        compose.onNodeWithText("Model & Thinking").assertDoesNotExist()
        compose.onNode(hasText("Deep model") and isSelectable()).assertDoesNotExist()
        compose.onNodeWithText("Deep model").assertIsDisplayed()
    }

    @Test
    fun aLongThinkingLadderIsAConnectedRadioListInsteadOfSegments() {
        val levels = listOf("off", "minimal", "low", "medium", "high")
        val model = AidenModel(id = "m", label = "Ladder model", thinkingLevels = levels)
        val picks = mutableListOf<PickedModel>()
        setModelPickerComposer(listOf(AidenProvider(id = "custom", label = "Custom", models = listOf(model))), picks)

        compose.onNodeWithContentDescription("Select model").performClick()
        for (label in listOf("Off", "Minimal", "Low", "Medium")) {
            compose.onNode(hasText(label) and isSelectable()).assertIsDisplayed().assertIsNotSelected()
        }
        compose.onNode(hasText("High") and isSelectable()).assertIsSelected()
        compose.onNode(hasText("Minimal") and isSelectable()).performClick()
        compose.runOnIdle { assertEquals(listOf("minimal"), picks.map { it.thinkingLevel }) }
        // Tapping the current effort again is not a new choice.
        compose.onNode(hasText("Minimal") and isSelectable()).assertIsSelected().performClick()
        compose.runOnIdle { assertEquals(1, picks.size) }
    }

    @Test
    fun withReducedMotionDictationShowsAStillStopGlyphThatTogglesOnce() {
        var toggles = 0
        compose.setContent {
            AidenTheme(config = AidenAppearanceConfig(reduceMotion = true)) {
                AidenComposerView(
                    draft = "",
                    onDraftChange = {},
                    onSend = {},
                    onStop = {},
                    canSend = false,
                    isStreaming = false,
                    isVoiceListening = true,
                    isVoiceBusy = true,
                    onToggleVoice = { toggles++ },
                    voiceErrorMessage = "Microphone unavailable"
                )
            }
        }

        compose.onNodeWithContentDescription("Start voice input").assertDoesNotExist()
        compose.onNodeWithContentDescription("Stop voice input").assertIsDisplayed().assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(1, toggles) }
        // A voice error is hidden while dictation runs.
        compose.onNodeWithText("Microphone unavailable").assertDoesNotExist()
    }
}
