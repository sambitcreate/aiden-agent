package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.config.AidenThemeCatalog
import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID
import sbtbiswas.AidenOnTheGo.features.chat.AidenStreamingMarkdownSplitter.Seam

class AidenStreamingMarkdownSplitterTest {
    private fun split(text: String) = AidenStreamingMarkdownSplitter.split(text)

    private fun AidenStreamingMarkdownSplitter.Segments.reconstructed(): String =
        stableChunks.joinToString("") { it.text } + activeMarkdown

    @Test
    fun shortTextStaysInTheActiveTail() {
        val text = "Hello from Aiden."
        val segments = split(text)

        assertTrue(segments.stableChunks.isEmpty())
        assertEquals(text, segments.activeMarkdown)
    }

    @Test
    fun aCompletedFenceSealsAStableChunk() {
        val body = "A".repeat(6_100)
        val text = "$body\n```kotlin\nval answer = 42\n```\nStill streaming"

        val segments = split(text)

        assertEquals(1, segments.stableChunks.size)
        assertEquals("$body\n```kotlin\nval answer = 42\n```\n", segments.stableChunks[0].text)
        assertEquals(Seam.CODE_FENCE, segments.stableChunks[0].seam)
        assertEquals("Still streaming", segments.activeMarkdown)
    }

    @Test
    fun anUnclosedFenceNeverSealsEvenAcrossBlankLines() {
        val text = "```python\n" + "x = 1\n\n".repeat(1_000) + "y = 2"

        val segments = split(text)

        assertTrue(segments.stableChunks.isEmpty())
        assertEquals(text, segments.activeMarkdown)
    }

    @Test
    fun aStrayRunHoldsTheSealUntilTheNextRunClosesIt() {
        val prose = "Line of prose.\n".repeat(450)
        val stray = "Type ``` to start a fence.\n\n"
        val held = split(prose + stray + "More prose.\n\n".repeat(50) + "tail")

        // The renderer pairs the stray run with the next one, so nothing after it may seal.
        assertTrue(held.stableChunks.isEmpty())

        val closed = split(prose + stray + "More prose.\n\nThen ``` closes it.\nAfter\n\ntail")
        assertEquals(Seam.CODE_FENCE, closed.stableChunks.single().seam)
        assertEquals("After\n\ntail", closed.activeMarkdown)
    }

    @Test
    fun tildeLinesAreProseToTheRendererSoABlankLineInsideThemSeals() {
        // The opening line closes its own ~strike~ span, so none crosses the blank line.
        val text = "~~~ text ~\n" + "Line of prose.\n".repeat(450) + "\n~~~\ntail"

        val segments = split(text)

        assertEquals(Seam.BLANK_LINE, segments.stableChunks.single().seam)
        assertEquals("~~~\ntail", segments.activeMarkdown)
        // A bare opener strikes through to the closing tildes in the renderer, so it holds the seal.
        assertTrue(split("~~~text\n" + "Line of prose.\n".repeat(450) + "\n~~~\ntail").stableChunks.isEmpty())
    }

    @Test
    fun everySealFallsBetweenTheCodeBlocksTheRendererFinds() {
        val prose = "Aiden reads the file and explains the change in a sentence.\n".repeat(40)
        val snippets = listOf(
            "```kotlin\nval a = 1\n\nval b = 2\n```\n\n",
            "````markdown\n```swift\nlet a = 1\n\nlet b = 2\n```\n````\n\n",
            "Inline ```x``` code, then a blank line.\n\n",
            "A stray ``` run\n\nthat the next block closes.\n\n```\nclosing\n```\n\n",
            "~~~\nnot a fence\n\n~~~\n\n",
            "## Heading\n",
        )
        val reply = buildString {
            var index = 0
            while (length < 60_000) {
                append(prose)
                append(snippets[index++ % snippets.size])
            }
        }
        val finalBlocks = CODE_BLOCK_REGEX.findAll(reply).map { it.range }.toList()
        val session = AidenStreamingMarkdownSplitter.Session()
        var sealed = 0

        for (length in 500..reply.length step 1_337) {
            val shown = reply.take(length)
            val segments = session.split(shown)
            val pieces = segments.stableChunks.map { it.text } + segments.activeMarkdown
            sealed = segments.stableChunks.size

            // Each piece renders the same code blocks as the whole text so far.
            var offset = 0
            val pieceBlocks = pieces.flatMap { piece ->
                CODE_BLOCK_REGEX.findAll(piece).map { (it.range.first + offset)..(it.range.last + offset) }.toList()
                    .also { offset += piece.length }
            }
            assertEquals(CODE_BLOCK_REGEX.findAll(shown).map { it.range }.toList(), pieceBlocks)

            // No seal sealed so far ever lands inside a block of the finished reply.
            for (chunk in segments.stableChunks.drop(1)) {
                assertTrue(finalBlocks.none { chunk.start > it.first && chunk.start <= it.last })
            }
        }
        assertTrue("only $sealed chunks sealed", sealed >= 3)
    }

    @Test
    fun aSessionAgreesWithAFreshSplitAtEveryTick() {
        val reply = ("Aiden inspects the workspace before choosing the next step.\n\n" +
            "```\nnpm test\n```\n").repeat(800)
        val session = AidenStreamingMarkdownSplitter.Session()
        var length = 0
        var step = 1

        while (length < reply.length) {
            length = minOf(reply.length, length + step)
            step = step * 3 % 997 + 1
            assertEquals(split(reply.take(length)), session.split(reply.take(length)))
        }
        assertTrue(session.split(reply).stableChunks.size > 5)
    }

    @Test
    fun aSessionStartsOverWhenTheReplyIsReplaced() {
        val session = AidenStreamingMarkdownSplitter.Session()
        val first = "First reply line.\n\n".repeat(800)
        assertFalse(session.split(first).stableChunks.isEmpty())

        val second = "Second reply line.\n\n".repeat(800)
        assertEquals(split(second), session.split(second))
        assertEquals(split("Short."), session.split("Short."))
    }

    @Test
    fun aHeadingCanSealWithoutAFence() {
        val prose = "Line of prose.\n".repeat(500)
        for (heading in listOf("## Next section\n", "##\tTab heading\n")) {
            val segments = split(prose + heading + "More text")

            assertEquals(listOf(prose + heading), segments.stableChunks.map { it.text })
            assertEquals(Seam.SINGLE_LINE_BLOCK, segments.stableChunks.single().seam)
            assertEquals("More text", segments.activeMarkdown)
        }
    }

    @Test
    fun hashesWithoutASpaceOrMoreThanSixAreNotHeadings() {
        val prose = "Line of prose.\n".repeat(500)
        for (line in listOf("#hashtag\n", "####### seven\n")) {
            val segments = split(prose + line + "More text")

            assertTrue(line, segments.stableChunks.isEmpty())
        }
    }

    @Test
    fun aBlankLineSealsWithItsSeam() {
        val first = "A".repeat(6_100) + "\n\n"
        val segments = split(first + "B".repeat(100))

        assertEquals(listOf(first), segments.stableChunks.map { it.text })
        assertEquals(Seam.BLANK_LINE, segments.stableChunks.single().seam)
    }

    @Test
    fun theSealThresholdCountsUtf8Bytes() {
        // 2,600 characters of Japanese prose are about 7,300 bytes.
        val prose = "日本語の文章です。\n".repeat(260)
        assertTrue(prose.length < AidenStreamingMarkdownSplitter.STABLE_CHUNK_TARGET_UTF8_BYTES)

        val segments = split(prose + "## 次の節\nMore text")

        assertEquals(listOf(prose + "## 次の節\n"), segments.stableChunks.map { it.text })
        assertEquals("More text", segments.activeMarkdown)
    }

    @Test
    fun anIndentedFenceWithTrailingWhitespaceKeepsItsBody() {
        val fence = "   ```swift \t\n" + "let x = 1\n\n".repeat(700) + "\t```\t\n"

        val segments = split(fence + "tail")

        assertEquals(listOf(fence), segments.stableChunks.map { it.text })
        assertEquals("tail", segments.activeMarkdown)
    }

    @Test
    fun aBoundaryAtTheVeryEndDoesNotSealSoTheTailIsNeverEmptyMidChunk() {
        val text = "A".repeat(6_100) + "\n\n"

        val segments = split(text)

        assertTrue(segments.stableChunks.isEmpty())
        assertEquals(text, segments.activeMarkdown)
    }

    @Test
    fun crlfPairsDoNotEndLines() {
        // Every line ends with \r\n, so no blank line is ever seen.
        val text = "Line of prose.\r\n\r\n".repeat(500) + "tail"

        assertTrue(split(text).stableChunks.isEmpty())
    }

    @Test
    fun aGrowingReplyKeepsItsSealedChunksAndReconstructsExactly() {
        val paragraph = "Aiden inspects the workspace before choosing the next step.\n\n"
        val full = paragraph.repeat(1_500).take(80_000)
        var previous = emptyList<AidenStreamingMarkdownSplitter.Chunk>()

        for (length in 2_000..80_000 step 2_000) {
            val segments = split(full.take(length))

            assertEquals(previous, segments.stableChunks.take(previous.size))
            assertEquals(full.take(length), segments.reconstructed())
            for (chunk in segments.stableChunks) {
                assertEquals(chunk.text, full.substring(chunk.start, chunk.start + chunk.text.length))
                assertTrue(chunk.text.toByteArray(Charsets.UTF_8).size >= AidenStreamingMarkdownSplitter.STABLE_CHUNK_TARGET_UTF8_BYTES)
            }
            assertEquals(segments.stableChunks.indices.toList(), segments.stableChunks.map { it.id })
            previous = segments.stableChunks
        }

        assertFalse(previous.isEmpty())
    }

    /** Each visible character with the inline styles the message renderer gives it, as one rendered document would show it. */
    private fun rendered(markdown: String): List<Pair<Char, Set<Any>>> {
        val palette = AidenThemeCatalog.palettes.getValue(AidenThemePresetID.AIDEN).first()
        var cursor = 0
        val pieces = ArrayList<String>()
        for (block in CODE_BLOCK_REGEX.findAll(markdown)) {
            pieces += markdown.substring(cursor, block.range.first)
            pieces += block.value
            cursor = block.range.last + 1
        }
        pieces += markdown.substring(cursor)
        return pieces.filter { it.isNotBlank() }.flatMap { piece ->
            if (piece.startsWith("```")) return@flatMap piece.filterNot { it.isWhitespace() }.map { it to emptySet<Any>() }
            val formatted = buildAidenFormattedMessage(piece.trim(), palette, false)
            formatted.text.indices.filterNot { formatted.text[it].isWhitespace() }.map { index ->
                formatted.text[index] to formatted.spanStyles.filter { index >= it.start && index < it.end }.map { it.item }.toSet()
            }
        }
    }

    private fun AidenStreamingMarkdownSplitter.Segments.renderedLive() =
        stableChunks.flatMap { rendered(it.text) } + rendered(activeMarkdown)

    @Test
    fun chunksRenderEveryInlineSpanAsTheWholeReplyWould() {
        val sentence = "Long emphasized paragraph. ".repeat(250)
        val replies = listOf(
            "**$sentence\n\nSecond emphasized paragraph.**\n\n$sentence",
            "Starts _$sentence\n\n## Heading inside\n\nends here_ and goes on.\n\n$sentence",
            "A lone ~ $sentence\n\n$sentence\n\n```\ncode ~ here\n```\n$sentence\n\n*tail $sentence\n\nclosed*"
        )
        for (reply in replies) {
            val session = AidenStreamingMarkdownSplitter.Session()
            var length = 0
            while (length < reply.length) {
                length = minOf(reply.length, length + 613)
                val segments = session.split(reply.take(length))
                assertEquals(reply.take(length), segments.reconstructed())
                assertEquals("live and whole renders differ at $length", rendered(reply.take(length)), segments.renderedLive())
            }
        }
    }

    @Test
    fun aClosedSpanStillLetsALaterBlankLineSeal() {
        val reply = "**Bold lead.** " + "Plain prose sentence. ".repeat(300) + "\n\nMore prose."

        val segments = split(reply)

        assertEquals(listOf(Seam.BLANK_LINE), segments.stableChunks.map { it.seam })
        assertEquals("More prose.", segments.activeMarkdown)
    }
}
