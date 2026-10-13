package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenStreamingRichTextUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val opening = "Opening paragraph that will be sealed."
    private val filler = "Supporting detail line for the first section.\n".repeat(160)

    @Test
    fun aReplyLongerThanOneChunkShowsItsSealedChunksAndItsTail() {
        var text by mutableStateOf("$opening\n\n")
        compose.setContent {
            AidenTheme {
                AidenStreamingRichText(
                    text = text,
                    palette = AidenTheme.palette,
                    showCursor = true,
                    onCopy = {},
                    onOpenUrl = {},
                    modifier = Modifier.verticalScroll(rememberScrollState())
                )
            }
        }
        compose.onNodeWithText(opening, substring = true).assertExists()

        // A burst crosses the seal threshold; the heading closes the first chunk.
        val burst = "$opening\n\n$filler## Next section\nStill streaming the tail"
        assertTrue(AidenStreamingMarkdownSplitter.split(burst).stableChunks.isNotEmpty())
        compose.runOnIdle { text = burst }

        compose.onNodeWithText(opening, substring = true).assertExists()
        compose.onNodeWithText("Still streaming the tail", substring = true).assertExists()
    }
}
