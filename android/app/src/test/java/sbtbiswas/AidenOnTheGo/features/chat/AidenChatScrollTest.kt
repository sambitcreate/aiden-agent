package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenChatTask
import sbtbiswas.AidenOnTheGo.models.AidenChatTaskStatus

class AidenChatScrollTest {
    private fun replay(start: Boolean, vararg events: AidenFollowEvent): Boolean =
        events.fold(AidenFollowLatch(start)) { latch, event -> AidenChatScroll.resolveFollow(latch, event) }.isFollowing

    @Test
    fun aDragStopsFollowingTheMomentItStarts() {
        assertFalse(replay(true, AidenFollowEvent.UserScrollBegin))
    }

    @Test
    fun onlyAGestureThatSettlesAtTheLiveEdgeResumesFollowing() {
        // Released 300px up: still detached, however close the content later grows to the edge.
        assertFalse(replay(true, AidenFollowEvent.UserScrollBegin, AidenFollowEvent.UserScrollEnd(isAtLiveEdge = false)))
        // Dragged back down and settled within the re-arm slop.
        assertTrue(
            replay(
                true,
                AidenFollowEvent.UserScrollBegin,
                AidenFollowEvent.UserScrollEnd(isAtLiveEdge = false),
                AidenFollowEvent.UserScrollBegin,
                AidenFollowEvent.UserScrollEnd(isAtLiveEdge = true),
            )
        )
    }

    @Test
    fun jumpingToLatestFollowsAgainEvenIfACoastingGestureEndsAwayFromTheEdge() {
        assertTrue(replay(false, AidenFollowEvent.Reset))
        assertTrue(replay(false, AidenFollowEvent.Reset, AidenFollowEvent.UserScrollEnd(isAtLiveEdge = false)))
    }

    @Test
    fun theReArmSlopIsMuchTighterThanTheButtonThresholds() {
        val reArm = 36 // 12dp at 3x
        val idle = 240 // 80dp at 3x
        val streaming = 480 // 160dp at 3x
        // 100px up: close enough to hide the button, too far to resume following.
        assertFalse(AidenChatScroll.isAtLiveEdge(0, 100, reArm))
        assertTrue(AidenChatScroll.isNearLiveEdge(0, 100, isStreaming = false, idlePx = idle, streamingPx = streaming))
        assertTrue(AidenChatScroll.isAtLiveEdge(0, 36, reArm))
        // 300px up is far while idle, still near while streaming.
        assertFalse(AidenChatScroll.isNearLiveEdge(0, 300, isStreaming = false, idlePx = idle, streamingPx = streaming))
        assertTrue(AidenChatScroll.isNearLiveEdge(0, 300, isStreaming = true, idlePx = idle, streamingPx = streaming))
        // Any older item at the bottom of the viewport is far from the live edge.
        assertFalse(AidenChatScroll.isAtLiveEdge(1, 0, reArm))
        assertFalse(AidenChatScroll.isNearLiveEdge(1, 0, isStreaming = true, idlePx = idle, streamingPx = streaming))
    }

    @Test
    fun theJumpButtonStaysHiddenWhileAFollowedStreamOwnsTheEdge() {
        // Following a stream: a tick may open a gap, but the follow loop closes it.
        assertFalse(AidenChatScroll.showsJumpToLatest(isNearLiveEdge = false, isStreaming = true, isFollowing = true))
        // The reader scrolled away from a stream.
        assertTrue(AidenChatScroll.showsJumpToLatest(isNearLiveEdge = false, isStreaming = true, isFollowing = false))
        // Idle and away from the edge, whatever the latch says.
        assertTrue(AidenChatScroll.showsJumpToLatest(isNearLiveEdge = false, isStreaming = false, isFollowing = true))
        // Detached but still near: no button.
        assertFalse(AidenChatScroll.showsJumpToLatest(isNearLiveEdge = true, isStreaming = true, isFollowing = false))
    }

    @Test
    fun reverseLayoutCountsTheLiveItemOnlyWhileStreaming() {
        assertEquals(3, AidenChatScroll.reverseLayoutItemCount(3, false))
        assertEquals(4, AidenChatScroll.reverseLayoutItemCount(3, true))
    }

    @Test
    fun taskSheetsOpenOnTheLatestVisibleStep() {
        assertEquals(0, AidenChatScroll.taskListEndIndex(0))
        assertEquals(0, AidenChatScroll.taskListEndIndex(1))
        assertEquals(17, AidenChatScroll.taskListEndIndex(18))
        assertTrue(AidenChatScroll.shouldPinTaskList(false, 3))
        assertFalse(AidenChatScroll.shouldPinTaskList(true, 3))
        assertFalse(AidenChatScroll.shouldPinTaskList(false, 0))
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

    // Wheel, keyboard and accessibility scrolls reach the list as UserInput
    // deltas but never fling, so the latch must settle without onPreFling.
    private fun TestScope.scrollWithoutFling(listState: LazyListState): AidenTranscriptFollowState {
        val follow = AidenTranscriptFollowState(listState, this, initiallyFollowing = true)
        follow.reArmPx = 36
        follow.nestedScrollConnection.onPreScroll(Offset(0f, -120f), NestedScrollSource.UserInput)
        assertFalse(follow.isFollowing)
        return follow
    }

    @Test
    fun aScrollWithoutAFlingThatEndsAtTheLiveEdgeFollowsAgain() = runTest {
        val follow = scrollWithoutFling(LazyListState())
        advanceTimeBy(AidenChatScroll.DRAG_SETTLE_MILLIS + 1)
        assertTrue(follow.isFollowing)
    }

    @Test
    fun aScrollWithoutAFlingThatEndsAwayFromTheEdgeStaysDetached() = runTest {
        val follow = scrollWithoutFling(LazyListState(firstVisibleItemIndex = 4))
        advanceTimeBy(AidenChatScroll.DRAG_SETTLE_MILLIS + 1)
        assertFalse(follow.isFollowing)
    }

    @Test
    fun eachScrollDeltaPostponesTheSettle() = runTest {
        val follow = scrollWithoutFling(LazyListState())
        advanceTimeBy(AidenChatScroll.DRAG_SETTLE_MILLIS - 20)
        follow.nestedScrollConnection.onPreScroll(Offset(0f, 60f), NestedScrollSource.UserInput)
        advanceTimeBy(AidenChatScroll.DRAG_SETTLE_MILLIS - 20)
        assertFalse(follow.isFollowing)
        advanceTimeBy(21)
        assertTrue(follow.isFollowing)
    }
}
