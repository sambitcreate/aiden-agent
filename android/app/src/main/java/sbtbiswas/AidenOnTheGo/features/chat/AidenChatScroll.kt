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

    fun latestItemIndex(): Int = 0

    fun taskListEndIndex(visibleCount: Int): Int = maxOf(0, visibleCount - 1)
}
