package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.height
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
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

    /** Every text run on screen, in reading order. */
    private fun shownTexts(): List<String> =
        compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), useUnmergedTree = true)
            .fetchSemanticsNodes()
            .map { node -> node.config[SemanticsProperties.Text].joinToString("") { it.text } }

    private fun String.withoutWhitespace() = filterNot { it.isWhitespace() }

    @Test
    fun aGrowingReplyKeepsItsSealedChunksAndShowsEachWordOnce() {
        val reply = (1..420).joinToString("") { "Paragraph $it explains one step of the plan in plain words.\n\n" }
        var text by mutableStateOf(reply.take(400))
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

        var sealed = emptyList<String>()
        for (length in 400..reply.length step 1_111) {
            compose.runOnIdle { text = reply.take(length) }
            val shown = shownTexts()
            // Nothing is lost or shown twice across a seal.
            assertEquals(reply.take(length).withoutWhitespace(), shown.joinToString("").withoutWhitespace())
            // Runs that sealed earlier stay exactly as they were; only the tail grows.
            val nowSealed = shown.dropLast(1)
            assertEquals(sealed, nowSealed.take(sealed.size))
            sealed = nowSealed
        }
        assertTrue("only ${sealed.size} chunks sealed", sealed.size >= 3)
    }

    /**
     * The live card and the finished message side by side, at the same width,
     * so their heights can be compared once the handoff would happen.
     */
    private fun assertLiveMatchesFinal(reply: String) {
        assertTrue(AidenStreamingMarkdownSplitter.split(reply).stableChunks.isNotEmpty())
        compose.setContent {
            AidenTheme {
                Row(Modifier.fillMaxWidth()) {
                    Box(Modifier.weight(1f).wrapContentHeight(Alignment.Top, unbounded = true).testTag("live")) {
                        AidenStreamingRichText(reply, AidenTheme.palette, showCursor = false, onCopy = {}, onOpenUrl = {})
                    }
                    Box(Modifier.weight(1f).wrapContentHeight(Alignment.Top, unbounded = true).testTag("final")) {
                        RichFormattedMessage(reply, AidenTheme.palette, onCopy = {}, onOpenUrl = {})
                    }
                }
            }
        }
        val live = compose.onNodeWithTag("live").getUnclippedBoundsInRoot()
        val final = compose.onNodeWithTag("final").getUnclippedBoundsInRoot()
        assertEquals(final.height.value, live.height.value, 0.5f)
    }

    private val longProse = "A sentence of prose that fills the first chunk.\n".repeat(130)

    @Test
    fun aCodeBlockSealedBeforeABlankLineHandsOverWithoutAJump() {
        assertLiveMatchesFinal(longProse + "```kotlin\nval answer = 42\n```\n\nThe answer follows the code.")
    }

    @Test
    fun aBlankLineSealedBeforeACodeBlockHandsOverWithoutAJump() {
        assertLiveMatchesFinal(longProse + "\n```kotlin\nval answer = 42\n```\nThe answer follows the code.")
    }

    @Test
    fun proseSealedAtABlankLineHandsOverWithoutAJump() {
        assertLiveMatchesFinal(longProse + "\nThe next paragraph.\n\n```\nnpm test\n```")
    }
}
