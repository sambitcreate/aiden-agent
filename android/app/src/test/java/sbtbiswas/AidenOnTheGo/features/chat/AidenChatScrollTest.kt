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
        assertTrue(AidenChatScroll.shouldPinLatestAfterContentChange(true))
        assertFalse(AidenChatScroll.shouldPinLatestAfterContentChange(false))
        assertEquals(3, AidenChatScroll.reverseLayoutItemCount(3, false))
        assertEquals(4, AidenChatScroll.reverseLayoutItemCount(3, true))
        assertTrue(AidenChatScroll.shouldUpdateFollowLatchFromViewport(false))
        assertFalse(AidenChatScroll.shouldUpdateFollowLatchFromViewport(true))
        assertFalse(AidenChatScroll.shouldUpdateFollowLatchFromViewport(false, itemCount = 4, consumedItemCount = 3))
        assertTrue(AidenChatScroll.shouldUpdateFollowLatchFromViewport(false, itemCount = 4, consumedItemCount = 4))
    }

    @Test
    fun insertionEpochStaysGatedUntilContentChangeConsumesLatch() {
        var state = FollowLatchState(lastItemCount = 3, consumedItemCount = 3, followLatest = true)
        state = AidenChatScroll.applyViewportFollowSample(
            state,
            ViewportFollowSample(itemCount = 4, index = 1, offset = 0, scrolling = true),
        )
        assertTrue(state.followLatest)
        state = AidenChatScroll.applyViewportFollowSample(
            state,
            ViewportFollowSample(itemCount = 4, index = 1, offset = 0, scrolling = true),
        )
        assertTrue(state.followLatest)
        assertTrue(AidenChatScroll.shouldPinLatestAfterContentChange(state.followLatest))
        state = AidenChatScroll.consumeInsertionEpoch(state, itemCount = 4)
        assertTrue(state.followLatest)
        state = AidenChatScroll.applyViewportFollowSample(
            state,
            ViewportFollowSample(itemCount = 4, index = 1, offset = 0, scrolling = true),
        )
        assertFalse(state.followLatest)
    }

    @Test
    fun restoredFollowStaysOffWhenTheLiveEdgeIsNotVisible() {
        assertFalse(AidenChatScroll.isFollowingLatest(2, 0))
        assertFalse(AidenChatScroll.shouldPinLatestAfterContentChange(false))
    }

    @Test
    fun taskSheetsOpenOnTheLatestVisibleStep() {
        assertEquals(0, AidenChatScroll.taskListEndIndex(0))
        assertEquals(0, AidenChatScroll.taskListEndIndex(1))
        assertEquals(17, AidenChatScroll.taskListEndIndex(18))
        assertTrue(AidenChatScroll.shouldPinTaskList(false, 3))
        assertFalse(AidenChatScroll.shouldPinTaskList(true, 3))
        assertFalse(AidenChatScroll.shouldPinTaskList(false, 0))
        assertFalse(AidenChatScroll.isFollowingLatest(2, 0))
        assertTrue(AidenChatScroll.isFollowingTaskListEnd(17, 18))
        assertFalse(AidenChatScroll.isFollowingTaskListEnd(0, 18))
        assertTrue(AidenChatScroll.shouldPinLatestAfterContentChange(true))
        assertEquals(
            "1:in_progress:Writing|2:pending:",
            AidenChatScroll.taskListFollowKey(
                listOf(Triple(1L, "in_progress", "Writing"), Triple(2L, "pending", "")),
            ),
        )
    }
}
