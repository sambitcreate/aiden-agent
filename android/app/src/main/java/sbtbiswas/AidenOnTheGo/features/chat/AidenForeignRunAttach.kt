package sbtbiswas.AidenOnTheGo.features.chat

import kotlinx.coroutines.delay

/**
 * When an open chat looks again for a run started elsewhere, such as on the
 * Mac, after the lookup it made on opening found nothing or the run it
 * followed has ended.
 *
 * A device that may read the chat's agent roster learns of each new turn from
 * the roster feed and attaches then. The roster can announce a turn just
 * before its run is registered, so a "no current run" answer to that attach is
 * retried once after [notFoundRetryMillis]. A device without roster access has
 * no such signal, so it probes the current run while the chat is on screen,
 * backing off from 5 s to 30 s, and never in the background. Each probe wait
 * starts once the previous lookup has answered.
 */
class AidenForeignRunAttachPolicy(
    /** Waits before each probe, in order; the last one repeats. */
    val probeDelaysMillis: List<Long> = listOf(5_000L, 10_000L, 20_000L, 30_000L),
    val notFoundRetryMillis: Long = 400L,
    /** Performs each of the waits above; tests substitute a controllable clock. */
    val pause: suspend (Long) -> Unit = { delay(it) }
) {
    init {
        require(probeDelaysMillis.isNotEmpty()) { "The probe needs at least one delay." }
    }

    /** The wait before probe [attempt] (0-based). */
    fun probeDelayMillis(attempt: Int): Long = probeDelaysMillis[attempt.coerceIn(0, probeDelaysMillis.lastIndex)]
}
