package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
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
}
