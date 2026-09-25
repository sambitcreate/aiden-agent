package sbtbiswas.AidenOnTheGo.features.chat

/** Reverse-layout transcripts keep the latest item at index 0. */
object AidenChatScroll {
    const val FOLLOW_OFFSET_PX = 80

    fun isFollowingLatest(
        firstVisibleItemIndex: Int,
        firstVisibleItemScrollOffset: Int,
        thresholdPx: Int = FOLLOW_OFFSET_PX
    ): Boolean {
        return firstVisibleItemIndex == 0 && firstVisibleItemScrollOffset <= thresholdPx
    }

    /**
     * Reverse-layout insertions shift the previously visible latest item to index 1.
     * Pin from the pre-update latch, not the post-layout first-visible index.
     */
    fun shouldPinLatestAfterContentChange(wasFollowingLatest: Boolean): Boolean {
        return wasFollowingLatest
    }

    fun reverseLayoutItemCount(messageCount: Int, streaming: Boolean): Int {
        return messageCount + if (streaming) 1 else 0
    }

    /**
     * Viewport samples that already include an unmatched insertion must not rewrite
     * the latch. The epoch stays pending until the content-change effect records
     * [consumedItemCount], not merely after the first sample whose count changed.
     */
    fun shouldUpdateFollowLatchFromViewport(
        contentChanged: Boolean,
        itemCount: Int = 0,
        consumedItemCount: Int = -1,
    ): Boolean {
        return !isInsertionEpochPending(contentChanged, itemCount, consumedItemCount)
    }

    fun isInsertionEpochPending(
        contentChanged: Boolean,
        itemCount: Int,
        consumedItemCount: Int,
    ): Boolean {
        return contentChanged || (consumedItemCount >= 0 && itemCount != consumedItemCount)
    }

    fun latestItemIndex(): Int = 0

    fun taskListEndIndex(visibleCount: Int): Int = maxOf(0, visibleCount - 1)

    fun isFollowingTaskListEnd(
        firstVisibleItemIndex: Int,
        visibleCount: Int,
    ): Boolean {
        if (visibleCount <= 0) return false
        return firstVisibleItemIndex >= taskListEndIndex(visibleCount)
    }

    fun taskListFollowKey(
        tasks: List<Triple<Long, String, String>>,
    ): String {
        return tasks.joinToString("|") { (id, status, activeForm) ->
            "$id:$status:$activeForm"
        }
    }

    fun shouldPinTaskList(alreadyPinned: Boolean, visibleCount: Int): Boolean {
        return visibleCount > 0 && !alreadyPinned
    }

    fun applyViewportFollowSample(state: FollowLatchState, sample: ViewportFollowSample): FollowLatchState {
        val contentChanged = state.lastItemCount >= 0 && sample.itemCount != state.lastItemCount
        var followLatest = state.followLatest
        var wasScrolling = state.wasScrolling
        if (shouldUpdateFollowLatchFromViewport(contentChanged, sample.itemCount, state.consumedItemCount)) {
            if (sample.scrolling) {
                wasScrolling = true
                followLatest = isFollowingLatest(sample.index, sample.offset)
            } else if (wasScrolling) {
                wasScrolling = false
                followLatest = isFollowingLatest(sample.index, sample.offset)
            }
        }
        return state.copy(
            lastItemCount = sample.itemCount,
            followLatest = followLatest,
            wasScrolling = wasScrolling,
        )
    }

    fun consumeInsertionEpoch(state: FollowLatchState, itemCount: Int): FollowLatchState {
        val followLatest = if (shouldPinLatestAfterContentChange(state.followLatest)) true else state.followLatest
        return state.copy(consumedItemCount = itemCount, followLatest = followLatest)
    }
}

data class ViewportFollowSample(
    val itemCount: Int,
    val index: Int,
    val offset: Int,
    val scrolling: Boolean,
)

data class FollowLatchState(
    val lastItemCount: Int = -1,
    val consumedItemCount: Int = -1,
    val followLatest: Boolean = true,
    val wasScrolling: Boolean = false,
)
