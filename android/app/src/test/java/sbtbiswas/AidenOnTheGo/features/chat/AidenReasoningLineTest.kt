package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class AidenReasoningLineTest {
    @Test
    fun theLiveLineIsTheLatestFinishedSentenceNeverTheUnfinishedTail() {
        assertEquals("", AidenReasoningLine.latest(""))
        assertEquals("", AidenReasoningLine.latest("Still forming the first thought"))
        assertEquals("Read the diff.", AidenReasoningLine.latest("Read the diff. Then group the"))
        assertEquals(
            "Check the style?",
            AidenReasoningLine.latest("Read the diff. Group the hunks by story! Check the style? ")
        )
        // A sentence is finished only once whitespace follows its punctuation.
        assertEquals("Read the diff.", AidenReasoningLine.latest("Read the diff. Group by story."))
        assertEquals("He said \"stage it first.\"", AidenReasoningLine.latest("He said \"stage it first.\" Then "))
    }

    @Test
    fun decimalsAndVersionsDoNotEndASentence() {
        assertEquals("Pin v4.1 before 2.5 ships.", AidenReasoningLine.latest("Pin v4.1 before 2.5 ships. And"))
    }

    @Test
    fun aFinishedLineCountsWithoutPunctuationAndMarkdownMarkersDrop() {
        assertEquals("Mapping hunk boundaries", AidenReasoningLine.latest("**Mapping hunk boundaries**\n\nREADME has"))
        assertEquals("Plan the split", AidenReasoningLine.latest("## Plan the split\nStart"))
        assertEquals("Stage hunk 1 with the fix", AidenReasoningLine.latest("- Stage `hunk 1` with the fix\n"))
        assertEquals("Check the build", AidenReasoningLine.latest("1. Check   the build\n\n\n"))
        // Blank lines and bare markers never become the line.
        assertEquals("Read the diff.", AidenReasoningLine.latest("Read the diff.\n\n**\n\n"))
    }
}
