package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class ComposerVoiceDraftComposerTest {
    @Test
    fun transcriptFillsAnEmptyDraft() {
        assertEquals(
            "Send the weekly update",
            ComposerVoiceDraftComposer.composedDraft("", "  Send the weekly update  ")
        )
    }

    @Test
    fun transcriptIsAppendedToTheSnapshottedDraftOnce() {
        assertEquals(
            "Please Send the weekly update",
            ComposerVoiceDraftComposer.composedDraft("  Please  ", "Send the weekly update")
        )
    }

    @Test
    fun anEmptyRecognitionResultDoesNotChangeTheDraft() {
        assertEquals(
            "Keep this text exactly",
            ComposerVoiceDraftComposer.composedDraft("Keep this text exactly", "   ")
        )
    }

    @Test
    fun aNewVoiceSessionRejectsCallbacksFromThePreviousSession() {
        val fence = ComposerVoiceSessionFence()
        val first = fence.advance()

        assertEquals(true, fence.accepts(first))

        val second = fence.advance()
        assertEquals(false, fence.accepts(first))
        assertEquals(true, fence.accepts(second))
    }
}
