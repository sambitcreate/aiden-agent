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
     * Viewport samples that already include an insertion must not rewrite the latch.
     */
    fun shouldUpdateFollowLatchFromViewport(contentChanged: Boolean): Boolean {
        return !contentChanged
    }

    fun latestItemIndex(): Int = 0

    fun taskListEndIndex(visibleCount: Int): Int = maxOf(0, visibleCount - 1)

    fun shouldPinTaskList(alreadyPinned: Boolean, visibleCount: Int): Boolean {
        return visibleCount > 0 && !alreadyPinned
    }
}
