package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AidenChatScrollTest {
    @Test
    fun reverseLayoutKeepsTheLatestMessageAtIndexZero() {
        assertEquals(0, AidenChatScroll.latestItemIndex())
        assertTrue(AidenChatScroll.isFollowingLatest(0, 0))
        assertTrue(AidenChatScroll.isFollowingLatest(0, 80))
        assertFalse(AidenChatScroll.isFollowingLatest(0, 81))
        assertFalse(AidenChatScroll.isFollowingLatest(1, 0))
    }

    @Test
    fun taskSheetsOpenOnTheLatestVisibleStep() {
        assertEquals(0, AidenChatScroll.taskListEndIndex(0))
        assertEquals(0, AidenChatScroll.taskListEndIndex(1))
        assertEquals(17, AidenChatScroll.taskListEndIndex(18))
    }
}
