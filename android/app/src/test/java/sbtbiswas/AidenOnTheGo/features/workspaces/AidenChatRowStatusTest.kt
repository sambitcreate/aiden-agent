package sbtbiswas.AidenOnTheGo.features.workspaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenChatRowState

class AidenChatRowStatusTest {
    @Test
    fun idleReadRowsRenderNothing() {
        val presentation = AidenChatRowStatusPresentation.of(AidenChatRowState.IDLE, unread = false)
        assertNull(presentation.contentDescription)
        assertNull(presentation.pillTitle)
        assertFalse(presentation.showsSpinner)
        assertFalse(presentation.showsUnreadDot)
    }

    @Test
    fun attentionStatesUseDistinctSoftPillsWithoutASpinner() {
        val approval = AidenChatRowStatusPresentation.of(AidenChatRowState.NEEDS_APPROVAL, unread = false)
        val input = AidenChatRowStatusPresentation.of(AidenChatRowState.NEEDS_INPUT, unread = false)

        assertEquals(AidenChatRowStatusTone.WARNING, approval.pillTone)
        assertEquals(AidenChatRowStatusTone.ACCENT, input.pillTone)
        assertEquals("Needs approval", approval.contentDescription)
        assertEquals("Needs input", input.contentDescription)
        assertFalse(approval.showsSpinner || input.showsSpinner)
    }

    @Test
    fun workingAndUnreadAreIndependentAndBothSpoken() {
        val presentation = AidenChatRowStatusPresentation.of(AidenChatRowState.WORKING, unread = true)
        assertNull(presentation.pillTitle)
        assertTrue(presentation.showsSpinner)
        assertTrue(presentation.showsUnreadDot)
        assertEquals("Working, Unread", presentation.contentDescription)

        val unreadOnly = AidenChatRowStatusPresentation.of(AidenChatRowState.IDLE, unread = true)
        assertEquals("Unread", unreadOnly.contentDescription)
        assertFalse(unreadOnly.showsSpinner)
    }
}
