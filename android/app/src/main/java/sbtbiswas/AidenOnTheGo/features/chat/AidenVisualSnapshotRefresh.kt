package sbtbiswas.AidenOnTheGo.features.chat

import java.time.Instant
import sbtbiswas.AidenOnTheGo.models.AidenChatMessage
import sbtbiswas.AidenOnTheGo.models.AidenChatRole

/**
 * When an open chat should read its transcript again to pick up a visual
 * snapshot the Mac stores after the reply settles. Capture runs after commit
 * (seconds per visual), so the terminal read usually arrives first, and phones
 * get no push when the snapshot lands. The newest assistant reply is re-read a
 * few times shortly after it finished, and never once every visual has a
 * usable snapshot or the reply is no longer recent.
 */
class AidenVisualSnapshotRefreshPolicy(
    val delaysMillis: List<Long> = listOf(4_000L, 10_000L, 20_000L),
    val recentWindowMillis: Long = 120_000L
) {
    /** The reply whose snapshots may still arrive: the newest assistant message. */
    fun watchedMessage(messages: List<AidenChatMessage>): AidenChatMessage? =
        messages.lastOrNull { it.role == AidenChatRole.ASSISTANT }

    /** The wait before re-read [attempt] (0-based), or null when no re-read is due. */
    fun nextDelayMillis(message: AidenChatMessage?, attempt: Int, now: Instant): Long? {
        if (message == null || message.role != AidenChatRole.ASSISTANT) return null
        val visuals = message.visuals.orEmpty()
        val attachments = message.attachments.orEmpty()
        // Same usability rule the visual row applies.
        if (visuals.none { aidenVisualDisplay(it, attachments).snapshot == null }) return null
        // A long turn counts from when it finished, which is when capture starts.
        val finishedAt = message.timeline?.finishedAt
            ?.takeIf { it.isFinite() && it > 0 }
            ?.let { Instant.ofEpochMilli(it.toLong()) }
        val settledAt = listOfNotNull(message.createdAt, finishedAt).max()
        if (now.toEpochMilli() - settledAt.toEpochMilli() > recentWindowMillis) return null
        return delaysMillis.getOrNull(attempt)
    }
}
