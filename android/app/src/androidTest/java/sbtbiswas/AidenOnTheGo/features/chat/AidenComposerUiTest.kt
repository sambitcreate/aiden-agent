package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
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

    @Test
    fun busyComposerOffersSteerQueueRedirectAlongsideStop() {
        val submitted = mutableListOf<AidenStreamInputMode>()
        var redirectRequested = false
        var stopClicks = 0
        compose.setContent {
            AidenTheme {
                AidenComposerView(
                    draft = "hold on",
                    onDraftChange = {},
                    onSend = {},
                    onStop = { stopClicks++ },
                    canStop = true,
                    canSend = false,
                    isStreaming = true,
                    showsRunInputOptions = true,
                    canSubmitRunInput = true,
                    onSubmitRunInput = { submitted += it },
                    onRedirectRequest = { redirectRequested = true },
                    isVoiceListening = false,
                    onToggleVoice = {}
                )
            }
        }

        // Stop stays its own control next to the run-input options button.
        compose.onNodeWithContentDescription("Stop generation").assertIsEnabled()
        compose.onNodeWithContentDescription("Run input options").assertIsEnabled().performClick()
        compose.onNodeWithText("Steer now").assertExists()
        compose.onNodeWithText("Queue to run next").assertExists()
        compose.onNodeWithText("Redirect…").assertExists()

        compose.onNodeWithText("Steer now").performClick()
        compose.runOnIdle { assertEquals(listOf(AidenStreamInputMode.STEER), submitted) }

        // Redirect is confirm-gated: the menu reports a request, never the action.
        compose.onNodeWithContentDescription("Run input options").performClick()
        compose.onNodeWithText("Redirect…").performClick()
        compose.runOnIdle {
            assertEquals(true, redirectRequested)
            assertEquals(listOf(AidenStreamInputMode.STEER), submitted)
            assertEquals(0, stopClicks)
        }
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
        compose.onNodeWithContentDescription("Run input options").assertDoesNotExist()
    }
}
