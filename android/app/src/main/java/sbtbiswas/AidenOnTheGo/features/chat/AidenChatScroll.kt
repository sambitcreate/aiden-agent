package sbtbiswas.AidenOnTheGo.features.chat

import sbtbiswas.AidenOnTheGo.models.AidenChatTask
import sbtbiswas.AidenOnTheGo.models.AidenChatTaskStatus
import sbtbiswas.AidenOnTheGo.models.AidenStreamState

/** Reverse-layout transcripts keep the latest item at index 0. */
object AidenChatScroll {
    const val FOLLOW_OFFSET_PX = 80

    /**
     * Reverse-layout insertions shift the previously visible latest item to index 1.
     * Pin from the pre-update latch, not the post-layout first-visible index.
     */
    fun shouldPinLatestAfterContentChange(wasFollowingLatest: Boolean): Boolean {
        return wasFollowingLatest
    }

    /**
     * The live card stays until the final message replaces it. A run that
     * ended still shows its card while it has output, because the transcript
     * holding that output is read afterwards; the view model clears the output
     * in the same main-thread step that publishes the transcript.
     */
    fun showsLiveCard(streamState: AidenStreamState?, hasLiveOutput: Boolean): Boolean {
        if (streamState == null) return false
        return !streamState.isTerminal || hasLiveOutput
    }

    fun reverseLayoutItemCount(messageCount: Int, streaming: Boolean): Int {
        return messageCount + if (streaming) 1 else 0
    }

    fun taskListEndIndex(visibleCount: Int): Int = maxOf(0, visibleCount - 1)

    /**
     * Forward-layout task lists show several rows at once, so the live edge is
     * reached when the last visible row is the last task and its bottom sits
     * within [thresholdPx] of the viewport's content end. Read these values from
     * the live `layoutInfo` so appends and deletions never use a stale count.
     */
    fun isFollowingTaskListEnd(
        lastVisibleItemIndex: Int,
        lastVisibleItemEndOffset: Int,
        viewportContentEndOffset: Int,
        totalItemCount: Int,
        thresholdPx: Int = FOLLOW_OFFSET_PX,
    ): Boolean {
        if (totalItemCount <= 0) return false
        if (lastVisibleItemIndex < taskListEndIndex(totalItemCount)) return false
        return lastVisibleItemEndOffset - viewportContentEndOffset <= thresholdPx
    }

    /**
     * Every field a task row renders, so any visible change re-arms follow.
     * Structured (not a joined string) so free-text fields cannot collide.
     */
    fun taskListFollowKey(tasks: List<AidenChatTask>): List<TaskFollowEntry> {
        return tasks.map { task ->
            TaskFollowEntry(
                id = task.id,
                status = task.status,
                activeForm = task.activeForm,
                subject = task.subject,
                blockedBy = task.blockedBy.orEmpty(),
            )
        }
    }

    fun shouldPinTaskList(alreadyPinned: Boolean, visibleCount: Int): Boolean {
        return visibleCount > 0 && !alreadyPinned
    }

    /** Hermex's follow re-arm slop: a settled gesture this close to the live edge resumes following. */
    const val FOLLOW_REARM_DP = 12

    /** How far from the live edge the jump button stays hidden while idle. */
    const val NEAR_LIVE_EDGE_IDLE_DP = 80

    /** Streaming pushes the edge away every tick, so the button tolerates a larger gap. */
    const val NEAR_LIVE_EDGE_STREAMING_DP = 160

    /** A lifted drag with no momentum is treated as settled after this long. */
    const val DRAG_SETTLE_MILLIS = 160L

    /** A fling is treated as settled after this much quiet. */
    const val MOMENTUM_SETTLE_MILLIS = 50L

    /**
     * Reverse layout anchors the live edge at index 0. Past the first item the
     * exact distance is not known without measuring, and it is at least one
     * full item, so it counts as far.
     */
    fun distanceFromLiveEdge(firstVisibleItemIndex: Int, firstVisibleItemScrollOffset: Int): Int {
        return if (firstVisibleItemIndex == 0) firstVisibleItemScrollOffset else Int.MAX_VALUE
    }

    fun isAtLiveEdge(firstVisibleItemIndex: Int, firstVisibleItemScrollOffset: Int, reArmPx: Int): Boolean {
        return distanceFromLiveEdge(firstVisibleItemIndex, firstVisibleItemScrollOffset) <= reArmPx
    }

    fun isNearLiveEdge(
        firstVisibleItemIndex: Int,
        firstVisibleItemScrollOffset: Int,
        isStreaming: Boolean,
        idlePx: Int,
        streamingPx: Int,
    ): Boolean {
        val threshold = if (isStreaming) streamingPx else idlePx
        return distanceFromLiveEdge(firstVisibleItemIndex, firstVisibleItemScrollOffset) <= threshold
    }

    /**
     * The proximity thresholds only decide whether the button shows. While a
     * stream is followed the follow loop owns the edge, so the button stays
     * hidden even when a tick briefly opens a gap.
     */
    fun showsJumpToLatest(isNearLiveEdge: Boolean, isStreaming: Boolean, isFollowing: Boolean): Boolean {
        return !isNearLiveEdge && (!isStreaming || !isFollowing)
    }

    /**
     * The follow latch. A drag turns following off as soon as it starts, and
     * only a gesture that settles at the live edge (or an explicit jump or
     * send) turns it back on. Distance alone never re-arms it.
     */
    fun resolveFollow(current: AidenFollowLatch, event: AidenFollowEvent): AidenFollowLatch {
        return when (event) {
            AidenFollowEvent.Reset -> AidenFollowLatch(isFollowing = true)
            AidenFollowEvent.UserScrollBegin -> AidenFollowLatch(isFollowing = false)
            is AidenFollowEvent.UserScrollEnd ->
                AidenFollowLatch(isFollowing = event.isAtLiveEdge || current.isFollowing)
        }
    }
}

data class AidenFollowLatch(val isFollowing: Boolean)

sealed interface AidenFollowEvent {
    /** An explicit jump to the latest message, or the reader sending a message. */
    data object Reset : AidenFollowEvent

    /** A finger started moving the transcript. */
    data object UserScrollBegin : AidenFollowEvent

    /** The gesture that started with [UserScrollBegin] has settled. */
    data class UserScrollEnd(val isAtLiveEdge: Boolean) : AidenFollowEvent
}

data class TaskFollowEntry(
    val id: Long,
    val status: AidenChatTaskStatus,
    val activeForm: String?,
    val subject: String,
    val blockedBy: List<Long>,
)
