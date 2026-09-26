package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenChatTask
import sbtbiswas.AidenOnTheGo.models.AidenChatTaskStatus

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
        assertTrue(AidenChatScroll.shouldPinLatestAfterContentChange(true))
    }

    @Test
    fun taskSheetFollowsWhenTheLastRowIsVisibleInAMultiRowViewport() {
        // 18 tasks, rows 12..17 visible, last row flush with the content end.
        assertTrue(
            AidenChatScroll.isFollowingTaskListEnd(
                lastVisibleItemIndex = 17,
                lastVisibleItemEndOffset = 1200,
                viewportContentEndOffset = 1200,
                totalItemCount = 18,
            )
        )
        // Within the follow slop.
        assertTrue(AidenChatScroll.isFollowingTaskListEnd(17, 1280, 1200, 18))
        // Reader scrolled up so the last row is partly below the fold.
        assertFalse(AidenChatScroll.isFollowingTaskListEnd(17, 1281, 1200, 18))
        // Last row not visible at all.
        assertFalse(AidenChatScroll.isFollowingTaskListEnd(15, 1200, 1200, 18))
        // A task was appended: the live total moves the end, so the old last row no longer counts.
        assertFalse(AidenChatScroll.isFollowingTaskListEnd(17, 1200, 1200, 19))
        assertFalse(AidenChatScroll.isFollowingTaskListEnd(-1, 0, 1200, 0))
    }

    @Test
    fun taskFollowKeyChangesForEveryRenderedField() {
        val base = listOf(
            AidenChatTask(id = 1, subject = "Plan", status = AidenChatTaskStatus.COMPLETED),
            AidenChatTask(
                id = 2,
                subject = "Write",
                status = AidenChatTaskStatus.IN_PROGRESS,
                activeForm = "Writing",
            ),
        )
        val key = AidenChatScroll.taskListFollowKey(base)
        assertEquals(key, AidenChatScroll.taskListFollowKey(base.map { it.copy() }))
        assertNotEquals(
            key,
            AidenChatScroll.taskListFollowKey(listOf(base[0], base[1].copy(subject = "Write a much longer subject"))),
        )
        assertNotEquals(
            key,
            AidenChatScroll.taskListFollowKey(listOf(base[0], base[1].copy(blockedBy = listOf(1L)))),
        )
        assertNotEquals(
            key,
            AidenChatScroll.taskListFollowKey(listOf(base[0], base[1].copy(activeForm = "Rewriting"))),
        )
        // Free-text fields must not collide when they contain separators.
        assertNotEquals(
            AidenChatScroll.taskListFollowKey(
                listOf(base[1].copy(activeForm = "a:b", subject = "c")),
            ),
            AidenChatScroll.taskListFollowKey(
                listOf(base[1].copy(activeForm = "a", subject = "b:c")),
            ),
        )
    }
}
