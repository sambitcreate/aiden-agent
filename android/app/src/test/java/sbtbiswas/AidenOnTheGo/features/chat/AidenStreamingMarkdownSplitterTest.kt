package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
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
    fun aNestedFenceSealsOnlyAfterItsOwnClosingRun() {
        val prose = "Line of prose.\n".repeat(400)
        for ((open, close) in listOf("````markdown" to "````", "~~~markdown" to "~~~")) {
            val fence = "$open\n```swift\nlet a = 1\n\nlet b = 2\n```\n$close\n"
            val segments = split(prose + fence + "After\n")

            assertEquals(open, listOf(prose + fence), segments.stableChunks.map { it.text })
            assertEquals(open, "After\n", segments.activeMarkdown)
        }
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
}
