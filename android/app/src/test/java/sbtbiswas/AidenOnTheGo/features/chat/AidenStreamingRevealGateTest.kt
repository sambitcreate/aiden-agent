package sbtbiswas.AidenOnTheGo.features.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AidenStreamingRevealGateTest {
    private val scope = TestScope()
    private val published = mutableListOf<String>()
    private val gate = AidenStreamingRevealGate(scope, tickMillis = 50) { published += it }

    private fun advanceTick() {
        scope.advanceTimeBy(51)
        scope.runCurrent()
    }

    // The cut itself.

    @Test
    fun cutsAtTheLastWhitespaceAndHoldsThePartialWord() {
        assertEquals(
            AidenStreamingRevealGate.Cut("alpha beta ", "gam"),
            AidenStreamingRevealGate.cut("alpha beta gam", heldPreviousTick = false)
        )
    }

    @Test
    fun trailingWhitespaceShowsEverything() {
        assertEquals(
            AidenStreamingRevealGate.Cut("alpha beta\n", ""),
            AidenStreamingRevealGate.cut("alpha beta\n", heldPreviousTick = false)
        )
    }

    @Test
    fun aFragmentHeldLastTickIsReleasedWithoutNewWhitespace() {
        assertEquals(
            AidenStreamingRevealGate.Cut("gamma", ""),
            AidenStreamingRevealGate.cut("gamma", heldPreviousTick = true)
        )
    }

    @Test
    fun aHeldFragmentFinishedByWhitespaceShowsWithTheCut() {
        // "gam" was held; "ma delt" arrived since.
        assertEquals(
            AidenStreamingRevealGate.Cut("gamma ", "delt"),
            AidenStreamingRevealGate.cut("gamma delt", heldPreviousTick = true)
        )
    }

    @Test
    fun cjkWithoutWhitespaceIsHeldOneTickThenReleased() {
        assertEquals(
            AidenStreamingRevealGate.Cut("", "你好世界"),
            AidenStreamingRevealGate.cut("你好世界", heldPreviousTick = false)
        )
        assertEquals(
            AidenStreamingRevealGate.Cut("你好世界，再见", ""),
            AidenStreamingRevealGate.cut("你好世界，再见", heldPreviousTick = true)
        )
    }

    @Test
    fun aBurstShowsInOneCut() {
        val words = (0 until 100).joinToString("") { "w$it " }
        assertEquals(
            AidenStreamingRevealGate.Cut(words, "tail"),
            AidenStreamingRevealGate.cut(words + "tail", heldPreviousTick = false)
        )
    }

    @Test
    fun anEmptyBufferShowsAndHoldsNothing() {
        for (held in listOf(false, true)) {
            assertEquals(AidenStreamingRevealGate.Cut("", ""), AidenStreamingRevealGate.cut("", held))
        }
    }

    @Test
    fun neverSplitsASurrogatePairOrGraphemeCluster() {
        // The combining accent and the ZWJ family stay whole on either side.
        val text = "café 👩‍👩‍👧‍👦"
        val cut = AidenStreamingRevealGate.cut(text, heldPreviousTick = false)
        assertEquals("café ", cut.shown)
        assertEquals("👩‍👩‍👧‍👦", cut.held)
        assertEquals(text, cut.shown + cut.held)
    }

    // The tick that applies it.

    @Test
    fun tokensWaitForTheTickAndThenShowWholeWords() {
        gate.submit("Hello wor")
        assertEquals(emptyList<String>(), published)

        advanceTick()
        assertEquals(listOf("Hello "), published)
        assertEquals("Hello ", gate.revealed)
    }

    @Test
    fun aHeldFragmentIsReleasedOnTheFollowingTickEvenWithoutNewText() {
        gate.submit("Hello wor")
        advanceTick()
        advanceTick()

        assertEquals(listOf("Hello ", "Hello wor"), published)

        // Nothing is held any more, so no further tick publishes.
        advanceTick()
        assertEquals(2, published.size)
    }

    @Test
    fun laterTokensDoNotPushTheTickBack() {
        gate.submit("one ")
        scope.advanceTimeBy(30)
        gate.submit("one two ")
        scope.advanceTimeBy(21)
        scope.runCurrent()

        // Revealed 50ms after the first token, not 50ms after the last.
        assertEquals(listOf("one two "), published)
    }

    @Test
    fun aSteadyStreamRevealsEveryTick() {
        val words = listOf("alpha ", "beta ", "gamma ", "delta ")
        var received = ""
        for (word in words) {
            received += word
            gate.submit(received)
            advanceTick()
        }

        assertEquals(listOf("alpha ", "alpha beta ", "alpha beta gamma ", "alpha beta gamma delta "), published)
    }

    @Test
    fun flushShowsTheHeldFragmentAtOnceAndCancelsTheTick() {
        gate.submit("final answ")
        gate.flush()
        assertEquals(listOf("final answ"), published)

        advanceTick()
        advanceTick()
        assertEquals(listOf("final answ"), published)
    }

    @Test
    fun aReplacedReplyIsShownAtOnceRatherThanGated() {
        gate.submit("first draft ")
        advanceTick()
        gate.submit("rewritten")

        assertEquals(listOf("first draft ", "rewritten"), published)
    }

    @Test
    fun anEmptyReplyClearsAWordStillBeingHeld() {
        gate.submit("half")
        gate.submit("")
        advanceTick()
        advanceTick()

        assertEquals(listOf(""), published)
    }

    @Test
    fun resetPublishesEmptyAndDropsPendingText() {
        gate.submit("stale words")
        gate.reset()
        advanceTick()

        assertEquals(listOf(""), published)
        assertEquals("", gate.revealed)

        gate.submit("fresh ")
        advanceTick()
        assertEquals(listOf("", "fresh "), published)
    }
}
