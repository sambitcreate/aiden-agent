package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.gestures.stopScroll
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * Owns whether a reverse-layout transcript follows its live edge (index 0,
 * offset 0). A drag turns following off the moment it starts; following comes
 * back only when that gesture settles within [AidenChatScroll.FOLLOW_REARM_DP]
 * of the edge, or when the reader jumps to the latest message.
 */
@Stable
class AidenTranscriptFollowState internal constructor(
    val listState: LazyListState,
    private val scope: CoroutineScope,
    initiallyFollowing: Boolean,
) {
    private var latch by mutableStateOf(AidenFollowLatch(initiallyFollowing))

    internal var reArmPx: Int = 0
    internal var nearIdlePx: Int = 0
    internal var nearStreamingPx: Int = 0

    private var isUserScrolling = false
    private var sawMomentum = false
    private var settleJob: Job? = null
    private var jumpGeneration = 0
    private var leadingItemKey: Any? = null
    private var leadingItemSize = 0

    val isFollowing: Boolean get() = latch.isFollowing

    val nestedScrollConnection: NestedScrollConnection = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            // A sideways swipe through a wide code block is not a transcript scroll.
            if (source == NestedScrollSource.UserInput && abs(available.y) > abs(available.x)) beginUserScroll()
            return Offset.Zero
        }

        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            if (isUserScrolling && source == NestedScrollSource.SideEffect && consumed != Offset.Zero) {
                sawMomentum = true
            }
            return Offset.Zero
        }

        override suspend fun onPreFling(available: Velocity): Velocity {
            if (isUserScrolling) {
                // The finger lifted. Without momentum the release position decides.
                val releasedAtEdge = isAtLiveEdge()
                scheduleSettle(AidenChatScroll.DRAG_SETTLE_MILLIS) { releasedAtEdge }
            }
            return Velocity.Zero
        }

        override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
            if (isUserScrolling && sawMomentum) {
                scheduleSettle(AidenChatScroll.MOMENTUM_SETTLE_MILLIS) { isAtLiveEdge() }
            }
            return Velocity.Zero
        }
    }

    fun isAtLiveEdge(): Boolean = AidenChatScroll.isAtLiveEdge(
        listState.firstVisibleItemIndex,
        listState.firstVisibleItemScrollOffset,
        reArmPx,
    )

    /** Snapshot-reading, so callers can wrap it in derivedStateOf. */
    fun showsJumpToLatest(isStreaming: Boolean): Boolean {
        val near = AidenChatScroll.isNearLiveEdge(
            listState.firstVisibleItemIndex,
            listState.firstVisibleItemScrollOffset,
            isStreaming,
            nearIdlePx,
            nearStreamingPx,
        )
        return AidenChatScroll.showsJumpToLatest(near, isStreaming, isFollowing)
    }

    /** Re-pins the live edge after an item was inserted or removed, before the next measure. */
    fun pinAfterContentChange() {
        if (isFollowing && !isUserScrolling) listState.requestScrollToItem(0, 0)
    }

    /** One follow step per streaming reveal: snap (never animate) back to offset 0. */
    fun followLiveEdge() {
        if (!isFollowing || isUserScrolling) return
        if (listState.firstVisibleItemIndex != 0 || listState.firstVisibleItemScrollOffset != 0) {
            listState.requestScrollToItem(0, 0)
        }
    }

    /**
     * Holds a detached reader's place inside the live item. In a reverse
     * layout the list anchors item 0 by its bottom, so text appended below the
     * reader would push what they are reading upward; growing the offset by
     * the same amount keeps it still.
     */
    internal fun holdReaderInsideLeadingItem(layoutInfo: LazyListLayoutInfo) {
        val leading = layoutInfo.visibleItemsInfo.firstOrNull()?.takeIf { it.index == 0 }
        val previousKey = leadingItemKey
        val previousSize = leadingItemSize
        leadingItemKey = leading?.key
        leadingItemSize = leading?.size ?: 0
        if (leading == null || leading.key != previousKey || isFollowing || isUserScrolling) return
        val growth = leading.size - previousSize
        val offset = listState.firstVisibleItemScrollOffset
        if (growth != 0 && offset > 0) {
            listState.requestScrollToItem(0, (offset + growth).coerceAtLeast(0))
        }
    }

    /** The reader asked to see the latest message. Any coasting fling is discarded. */
    fun jumpToLatest() {
        settleJob?.cancel()
        isUserScrolling = false
        latch = AidenChatScroll.resolveFollow(latch, AidenFollowEvent.Reset)
        val generation = ++jumpGeneration
        scope.launch {
            listState.stopScroll(MutatePriority.UserInput)
            listState.scrollToItem(0, 0)
            // Content measured in the frame after the jump can still move the edge.
            withFrameNanos { }
            if (generation == jumpGeneration && isFollowing && !isExactlyAtLiveEdge()) {
                listState.scrollToItem(0, 0)
            }
        }
    }

    /** Stops following without a gesture, e.g. while older messages load above. */
    fun detach() {
        settleJob?.cancel()
        isUserScrolling = false
        latch = AidenChatScroll.resolveFollow(latch, AidenFollowEvent.UserScrollBegin)
    }

    private fun isExactlyAtLiveEdge(): Boolean =
        listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0

    private fun beginUserScroll() {
        settleJob?.cancel()
        settleJob = null
        if (isUserScrolling) return
        isUserScrolling = true
        sawMomentum = false
        latch = AidenChatScroll.resolveFollow(latch, AidenFollowEvent.UserScrollBegin)
    }

    private fun scheduleSettle(delayMillis: Long, isAtEdge: () -> Boolean) {
        settleJob?.cancel()
        settleJob = scope.launch {
            delay(delayMillis)
            if (listState.isScrollInProgress) {
                // Still coasting: wait for the fling to go quiet.
                scheduleSettle(AidenChatScroll.MOMENTUM_SETTLE_MILLIS) { isAtLiveEdge() }
                return@launch
            }
            finishUserScroll(isAtEdge())
        }
    }

    private fun finishUserScroll(atEdge: Boolean) {
        if (!isUserScrolling) return
        isUserScrolling = false
        sawMomentum = false
        latch = AidenChatScroll.resolveFollow(latch, AidenFollowEvent.UserScrollEnd(atEdge))
        if (isFollowing) followLiveEdge()
    }
}

@Composable
fun rememberAidenTranscriptFollowState(listState: LazyListState): AidenTranscriptFollowState {
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val reArmPx = with(density) { AidenChatScroll.FOLLOW_REARM_DP.dp.roundToPx() }
    val state = remember(listState, scope) {
        AidenTranscriptFollowState(
            listState = listState,
            scope = scope,
            // A restored position away from the edge must not snap back.
            initiallyFollowing = AidenChatScroll.isAtLiveEdge(
                listState.firstVisibleItemIndex,
                listState.firstVisibleItemScrollOffset,
                reArmPx,
            ),
        )
    }
    state.reArmPx = reArmPx
    state.nearIdlePx = with(density) { AidenChatScroll.NEAR_LIVE_EDGE_IDLE_DP.dp.roundToPx() }
    state.nearStreamingPx = with(density) { AidenChatScroll.NEAR_LIVE_EDGE_STREAMING_DP.dp.roundToPx() }
    return state
}

/** Attach to the transcript's LazyColumn so drags and flings reach the follow latch. */
fun Modifier.aidenTranscriptFollow(state: AidenTranscriptFollowState): Modifier =
    nestedScroll(state.nestedScrollConnection)

/**
 * Re-pins the live edge whenever the transcript gains or loses an item. It
 * runs as a side effect of the same composition, so the next measure already
 * uses index 0 instead of keeping the displaced item by key.
 */
@Composable
fun AidenTranscriptFollowEffects(state: AidenTranscriptFollowState, itemCount: Int) {
    val lastCount = remember(state) { intArrayOf(-1) }
    SideEffect {
        if (lastCount[0] != itemCount) {
            if (lastCount[0] >= 0) state.pinAfterContentChange()
            lastCount[0] = itemCount
        }
    }
    LaunchedEffect(state) {
        snapshotFlow { state.listState.layoutInfo }.collect(state::holdReaderInsideLeadingItem)
    }
}

/**
 * A leaf placed inside the live item: each revealed chunk takes one follow
 * step, so only this leaf recomposes per tick rather than the transcript.
 */
@Composable
fun AidenStreamingFollowTrigger(state: AidenTranscriptFollowState, revealedLength: Int) {
    LaunchedEffect(state, revealedLength) { state.followLiveEdge() }
}

