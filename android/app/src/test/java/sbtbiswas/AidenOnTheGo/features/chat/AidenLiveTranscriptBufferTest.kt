package sbtbiswas.AidenOnTheGo.features.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AidenLiveTranscriptBufferTest {
    private val scope = TestScope()
    private val published = mutableListOf<Pair<String, String>>()
    private val buffer = AidenLiveTranscriptBuffer(scope, frameMillis = 33) { text, reasoning ->
        published += text to reasoning
    }

    private fun advanceFrame() {
        scope.advanceTimeBy(34)
        scope.runCurrent()
    }

    @Test
    fun manyTokensInOneFramePublishOneCompleteSnapshot() {
        repeat(500) { buffer.appendText("tok$it ") }
        buffer.appendReasoning("thinking")
        assertEquals(emptyList<Pair<String, String>>(), published)

        advanceFrame()

        val expected = (0 until 500).joinToString("") { "tok$it " }
        assertEquals(listOf(expected to "thinking"), published)
        assertEquals(expected.length, buffer.textLength)
    }

    @Test
    fun laterFramesExtendTheTranscriptInOrder() {
        buffer.appendText("prefix ")
        advanceFrame()
        buffer.appendText("suffix")
        advanceFrame()
        advanceFrame()

        assertEquals(listOf("prefix " to "", "prefix suffix" to ""), published)
    }

    @Test
    fun flushPublishesPendingTextBeforeTheFrameAndOnlyOnce() {
        buffer.appendText("before done")
        buffer.flush()
        buffer.flush()
        advanceFrame()

        assertEquals(listOf("before done" to ""), published)
    }

    @Test
    fun resetDropsPendingDeltasAndPublishesAnEmptyTranscript() {
        buffer.appendText("stale reply")
        buffer.appendReasoning("stale reasoning")
        buffer.reset()
        advanceFrame()
        buffer.appendText("fresh")
        advanceFrame()

        assertEquals(listOf("" to "", "fresh" to ""), published)
    }

    @Test
    fun emptyDeltasDoNotPublishFrames() {
        buffer.appendText("")
        buffer.appendReasoning("")
        advanceFrame()

        assertEquals(emptyList<Pair<String, String>>(), published)
    }
}
