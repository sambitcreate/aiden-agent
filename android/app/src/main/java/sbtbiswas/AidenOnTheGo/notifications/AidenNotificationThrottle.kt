package sbtbiswas.AidenOnTheGo.notifications

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.collectLatest

/**
 * Emits the first value at once, then at most one value per [periodMillis],
 * always the latest. Unlike `debounce`, a stream that changes continuously
 * still produces regular updates. Values for which [isUrgent] is true, such
 * as a terminal state or an approval request, are emitted without waiting.
 */
@OptIn(ExperimentalCoroutinesApi::class)
fun <T> Flow<T>.throttleLatest(
    periodMillis: Long,
    clockMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    isUrgent: (T) -> Boolean = { false }
): Flow<T> = channelFlow {
    var lastEmittedAt: Long? = null
    collectLatest { value ->
        val last = lastEmittedAt
        if (last != null && !isUrgent(value)) {
            val wait = last + periodMillis - clockMillis()
            if (wait > 0) delay(wait)
        }
        lastEmittedAt = clockMillis()
        send(value)
    }
}
