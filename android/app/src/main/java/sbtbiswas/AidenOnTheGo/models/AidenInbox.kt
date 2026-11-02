package sbtbiswas.AidenOnTheGo.models

import java.time.DayOfWeek
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit

/**
 * The Inbox bucket a host reports on a summary row (`inboxBucket`, Remote
 * revision 50). Unknown values never map to a case, so a newer host's bucket
 * falls back to local placement instead of failing the page.
 */
enum class AidenInboxBucket(val wire: String) {
    NEEDS_YOU("needs_you"),
    PINNED("pinned"),
    UPDATES("updates"),
    EARLIER("earlier"),
    WORKING("working"),
    SNOOZED("snoozed"),
    DONE("done");

    companion object {
        fun fromWire(value: String?): AidenInboxBucket? = entries.firstOrNull { it.wire == value }
    }
}

/** The Inbox sections, in on-screen order. Working is the shelf under the list. */
enum class AidenInboxSection { NEEDS_YOU, PINNED, UPDATES, EARLIER, WORKING }

/**
 * Where one row sits in the Inbox. A null [section] means hidden (Done,
 * snoozed, or older than the recent window).
 */
data class AidenInboxPlacement(
    val section: AidenInboxSection?,
    /** The Needs you tier (approval 0, question 1, failed 2); 0 elsewhere. */
    val tier: Int,
    val sortAt: Instant
) {
    companion object {
        fun hidden(sortAt: Instant) = AidenInboxPlacement(null, 0, sortAt)
    }
}

/**
 * The desktop Inbox's placement rules (`renderer/shared/inbox-state.ts`),
 * ported for phones as on iOS. The host's `inboxBucket` is used when it still
 * agrees with what the phone knows; otherwise, and for hosts that send no
 * bucket, the row is placed here from its signals.
 */
object AidenInbox {
    val RECENT_WINDOW: Duration = Duration.ofDays(7)
    const val EARLIER_LIMIT = 20

    const val TIER_APPROVAL = 0
    const val TIER_INPUT = 1
    const val TIER_FAILED = 2

    /** The signals the rules read, in desktop terms. */
    data class Signals(
        val rowState: AidenChatRowState,
        val unread: Boolean = false,
        val failed: Boolean = false,
        val isOpen: Boolean = false,
        val updatedAt: Instant,
        val lastAssistantAt: Instant? = null,
        val attentionSince: Instant? = null,
        val runStartedAt: Instant? = null,
        val pinnedAt: Instant? = null,
        val doneAt: Instant? = null,
        val snoozedUntil: Instant? = null
    ) {
        companion object {
            fun of(summary: AidenChatSummary, isOpen: Boolean) = Signals(
                rowState = summary.displayRowState,
                unread = summary.unread,
                failed = summary.lastRunFailed,
                isOpen = isOpen,
                updatedAt = summary.updatedAt,
                lastAssistantAt = summary.lastAssistantAt,
                attentionSince = summary.attentionSince,
                runStartedAt = summary.runStartedAt,
                pinnedAt = summary.pinnedAt,
                doneAt = summary.doneAt,
                snoozedUntil = summary.snoozedUntil
            )
        }
    }

    /** Done holds until newer output lands; a snooze holds until it ends on this phone's clock. */
    fun holdsDone(signals: Signals): Boolean {
        val doneAt = signals.doneAt ?: return false
        return signals.lastAssistantAt?.let { !it.isAfter(doneAt) } ?: true
    }

    fun holdsSnooze(snoozedUntil: Instant?, now: Instant): Boolean = snoozedUntil?.isAfter(now) == true

    private fun withinWindow(updatedAt: Instant, now: Instant, window: Duration?): Boolean =
        window == null || Duration.between(updatedAt, now) <= window

    /**
     * `inboxState`: the rules in the plan's order. A null [recentWindow] has
     * no limit; [includeTriaged] (search) skips the Done and Snooze rule.
     */
    fun localPlacement(
        signals: Signals,
        now: Instant,
        recentWindow: Duration? = RECENT_WINDOW,
        includeTriaged: Boolean = false
    ): AidenInboxPlacement {
        val unread = signals.unread && !signals.isOpen
        fun needsYou(tier: Int) =
            AidenInboxPlacement(AidenInboxSection.NEEDS_YOU, tier, signals.attentionSince ?: signals.updatedAt)
        // 1. A live prompt overrides Done and Snooze.
        if (signals.rowState == AidenChatRowState.NEEDS_APPROVAL) return needsYou(TIER_APPROVAL)
        if (signals.rowState == AidenChatRowState.NEEDS_INPUT) return needsYou(TIER_INPUT)
        // 2. Unseen output from a failed run.
        if (signals.rowState == AidenChatRowState.IDLE && signals.failed && unread) return needsYou(TIER_FAILED)
        // 3. (Local desktop prompts only; phones never see them.)
        // 4. Running.
        if (signals.rowState == AidenChatRowState.WORKING) {
            return AidenInboxPlacement(AidenInboxSection.WORKING, 0, signals.runStartedAt ?: signals.updatedAt)
        }
        // 5. Done with no newer output, or snoozed.
        if (!includeTriaged && (holdsDone(signals) || holdsSnooze(signals.snoozedUntil, now))) {
            return AidenInboxPlacement.hidden(signals.updatedAt)
        }
        // 6–8.
        signals.pinnedAt?.let { return AidenInboxPlacement(AidenInboxSection.PINNED, 0, it) }
        if (unread) {
            return AidenInboxPlacement(AidenInboxSection.UPDATES, 0, signals.lastAssistantAt ?: signals.updatedAt)
        }
        if (signals.isOpen || withinWindow(signals.updatedAt, now, recentWindow)) {
            return AidenInboxPlacement(AidenInboxSection.EARLIER, 0, signals.updatedAt)
        }
        return AidenInboxPlacement.hidden(signals.updatedAt)
    }

    /**
     * The row's placement: the host's bucket when the phone has nothing
     * newer, else the local rules. The phone rechecks what the host can't
     * know: the open chat is never unread (so never in Updates or the failed
     * tier), a snooze past its end on this phone's clock is awake, the recent
     * window runs on this phone's clock, and live row state seen here wins.
     */
    fun placement(
        summary: AidenChatSummary,
        isOpen: Boolean,
        now: Instant,
        recentWindow: Duration = RECENT_WINDOW
    ): AidenInboxPlacement {
        val signals = Signals.of(summary, isOpen)
        val local = localPlacement(signals, now, recentWindow)
        val bucket = summary.inboxBucket ?: return local
        val sortAt = summary.inboxSortAt ?: return local
        when (signals.rowState) {
            AidenChatRowState.NEEDS_APPROVAL, AidenChatRowState.NEEDS_INPUT -> {
                // The tier comes from the row state; the host's time orders it.
                if (bucket != AidenInboxBucket.NEEDS_YOU) return local
                return AidenInboxPlacement(AidenInboxSection.NEEDS_YOU, local.tier, sortAt)
            }
            AidenChatRowState.WORKING -> {
                if (bucket != AidenInboxBucket.WORKING) return local
                return AidenInboxPlacement(AidenInboxSection.WORKING, 0, sortAt)
            }
            AidenChatRowState.IDLE -> Unit
        }
        val unread = signals.unread && !isOpen
        return when (bucket) {
            // Idle in Needs you is the failed tier; it holds only while unseen here.
            AidenInboxBucket.NEEDS_YOU ->
                if (signals.failed && unread) AidenInboxPlacement(AidenInboxSection.NEEDS_YOU, TIER_FAILED, sortAt)
                else local
            AidenInboxBucket.WORKING -> local
            AidenInboxBucket.PINNED -> AidenInboxPlacement(AidenInboxSection.PINNED, 0, sortAt)
            AidenInboxBucket.UPDATES ->
                if (unread) AidenInboxPlacement(AidenInboxSection.UPDATES, 0, sortAt) else local
            AidenInboxBucket.EARLIER ->
                if (isOpen || withinWindow(summary.updatedAt, now, recentWindow)) {
                    AidenInboxPlacement(AidenInboxSection.EARLIER, 0, sortAt)
                } else AidenInboxPlacement.hidden(sortAt)
            // Awake on this phone's clock: place it as if never snoozed.
            AidenInboxBucket.SNOOZED ->
                if (holdsSnooze(summary.snoozedUntil, now)) AidenInboxPlacement.hidden(sortAt) else local
            AidenInboxBucket.DONE -> AidenInboxPlacement.hidden(sortAt)
        }
    }

    /**
     * Done or Snooze on unseen failed output also reads it, as on the
     * desktop (`inboxTriageOffer`): the open chat is already seen.
     */
    fun alsoMarksRead(summary: AidenChatSummary, isOpen: Boolean): Boolean =
        summary.displayRowState == AidenChatRowState.IDLE && summary.showsFailed && !isOpen

    /**
     * The swipe actions one row offers, as on the desktop
     * (`inboxTriageOffer`). Mark read needs read markers and an unread row,
     * whatever it waits on. Done and Snooze need `chat-triage-v1` with
     * chat:write and are never offered on a row that waits on approval or
     * input or is running; each is offered unless the row already holds it.
     * Done and Snooze on unseen failed output also read it, so a host
     * without read markers is offered neither there.
     */
    fun rowOffer(
        summary: AidenChatSummary,
        isOpen: Boolean,
        now: Instant,
        supportsReadState: Boolean,
        supportsTriage: Boolean
    ): AidenInboxRowOffer {
        val markRead = summary.unread && supportsReadState
        val idle = summary.displayRowState == AidenChatRowState.IDLE
        if (!supportsTriage || !idle) return AidenInboxRowOffer(markRead = markRead)
        val alsoMarkRead = alsoMarksRead(summary, isOpen)
        if (alsoMarkRead && !supportsReadState) return AidenInboxRowOffer(markRead = markRead)
        val signals = Signals.of(summary, isOpen)
        return AidenInboxRowOffer(
            markRead = markRead,
            done = !holdsDone(signals),
            snooze = !holdsSnooze(summary.snoozedUntil, now),
            alsoMarkRead = alsoMarkRead
        )
    }

    /**
     * The write that puts [change] back, built from what the row held
     * [before] it: Undo of Done re-holds Done only if it held before, Undo of
     * a Snooze returns to an earlier snooze still running, else wakes.
     */
    fun undo(change: AidenChatTriageChange, before: AidenChatSummary, now: Instant): AidenChatTriageChange? {
        val pinned = change.pinned?.let { before.pinnedAt != null }
        val done = change.done?.let { holdsDone(Signals.of(before, isOpen = false)) }
        val snooze = change.snooze?.let {
            before.snoozedUntil?.takeIf { holdsSnooze(it, now) }
                ?.let { until -> AidenChatTriageChange.Snooze.Until(until) }
                ?: AidenChatTriageChange.Snooze.Wake
        }
        return AidenChatTriageChange(pinned, done, snooze).takeIf { pinned != null || done != null || snooze != null }
    }

    /**
     * Puts back what a refused write changed. Only the fields the write
     * changed that still hold its optimistic value go back, so newer output,
     * run times and later writes on [current] stay. The host's old bucket
     * returns only when the row is then exactly as it was. Without
     * [restoresUnread] (the chat was viewed while the write was out) the row
     * stays read.
     */
    fun rollingBack(
        current: AidenChatSummary,
        optimistic: AidenChatSummary,
        before: AidenChatSummary,
        restoresUnread: Boolean = true
    ): AidenChatSummary {
        var row = current
        if (optimistic.pinnedAt != before.pinnedAt && current.pinnedAt == optimistic.pinnedAt) {
            row = row.copy(pinnedAt = before.pinnedAt)
        }
        if (optimistic.doneAt != before.doneAt && current.doneAt == optimistic.doneAt) {
            row = row.copy(doneAt = before.doneAt)
        }
        if (optimistic.snoozedUntil != before.snoozedUntil && current.snoozedUntil == optimistic.snoozedUntil) {
            row = row.copy(snoozedUntil = before.snoozedUntil)
        }
        if (restoresUnread && optimistic.unread != before.unread && current.unread == optimistic.unread) {
            row = row.copy(unread = before.unread)
        }
        if (row.inboxBucketWire == null && row.inboxSortAtWire == null) {
            val placed = row.copy(inboxBucketWire = before.inboxBucketWire, inboxSortAtWire = before.inboxSortAtWire)
            if (placed == before) row = placed
        }
        return row
    }

    /**
     * The row a triage write leaves behind, before the host answers. Fields
     * follow the host's rules: Done stamps now, Snooze keeps only a future
     * time, and each field is independent of the others.
     */
    fun applyingOptimisticTriage(
        change: AidenChatTriageChange,
        summary: AidenChatSummary,
        now: Instant,
        alsoMarkRead: Boolean = false
    ): AidenChatSummary {
        var row = summary
        change.pinned?.let { pinned -> row = row.copy(pinnedAt = if (pinned) row.pinnedAt ?: now else null) }
        change.done?.let { done -> row = row.copy(doneAt = if (done) now else null) }
        when (val snooze = change.snooze) {
            is AidenChatTriageChange.Snooze.Until ->
                row = row.copy(snoozedUntil = snooze.at.takeIf { it.isAfter(now) })
            AidenChatTriageChange.Snooze.Wake -> row = row.copy(snoozedUntil = null)
            null -> Unit
        }
        if (alsoMarkRead) row = row.copy(unread = false)
        // The host's bucket described the row before this change.
        return row.withoutHostPlacement()
    }

    /** The row after the host answered a triage write. */
    fun applyingTriageResult(result: AidenChatTriageResult, summary: AidenChatSummary): AidenChatSummary =
        summary.copy(
            pinnedAt = result.pinnedAt,
            doneAt = result.doneAt,
            snoozedUntil = result.snoozedUntil,
            triageRevision = result.revision.takeIf { it > 0 }
        ).withoutHostPlacement()
}

/** The swipe actions one Inbox row offers ([AidenInbox.rowOffer]). */
data class AidenInboxRowOffer(
    val markRead: Boolean = false,
    val done: Boolean = false,
    val snooze: Boolean = false,
    /** Done or Snooze also reads the row's unseen failed output. */
    val alsoMarkRead: Boolean = false
) {
    val triage: Boolean get() = done || snooze
}

/** One Inbox row and where it sits. */
data class AidenInboxRow(val summary: AidenChatSummary, val placement: AidenInboxPlacement) {
    val id: String get() = summary.id
}

/**
 * The Inbox sections for the phone's sidebar, ordered like the desktop's
 * (`organizeInbox`): Needs you by tier then oldest first; Pinned, Updates and
 * Earlier newest first; the Working shelf oldest first. Ties go by id.
 */
data class AidenInboxProjection(
    val needsYou: List<AidenInboxRow> = emptyList(),
    val pinned: List<AidenInboxRow> = emptyList(),
    val updates: List<AidenInboxRow> = emptyList(),
    val earlier: List<AidenInboxRow> = emptyList(),
    val working: List<AidenInboxRow> = emptyList(),
    /** Earlier rows past the cap, reached through Show more. */
    val earlierOverflow: Int = 0
) {
    val isEmpty: Boolean
        get() = needsYou.isEmpty() && pinned.isEmpty() && updates.isEmpty() && earlier.isEmpty() && working.isEmpty()

    fun rows(section: AidenInboxSection): List<AidenInboxRow> = when (section) {
        AidenInboxSection.NEEDS_YOU -> needsYou
        AidenInboxSection.PINNED -> pinned
        AidenInboxSection.UPDATES -> updates
        AidenInboxSection.EARLIER -> earlier
        AidenInboxSection.WORKING -> working
    }

    companion object {
        private val newestFirst = compareByDescending<AidenInboxRow> { it.placement.sortAt }.thenBy { it.id }
        private val oldestFirst = compareBy<AidenInboxRow> { it.placement.sortAt }.thenBy { it.id }

        /**
         * Search lists every match where it would sit untriaged, past the
         * recent window and the Earlier cap. Rows whose workspace is not
         * listed are left out.
         */
        fun make(
            chats: List<AidenChatSummary>,
            workspaceNames: Map<String, String>,
            openChatId: String?,
            now: Instant,
            searchText: String = "",
            showAllEarlier: Boolean = false,
            recentWindow: Duration = AidenInbox.RECENT_WINDOW,
            earlierLimit: Int = AidenInbox.EARLIER_LIMIT
        ): AidenInboxProjection {
            val query = searchText.trim()
            val searching = query.isNotEmpty()
            val bySection = AidenInboxSection.entries.associateWith { mutableListOf<AidenInboxRow>() }
            for (chat in chats) {
                val workspaceName = workspaceNames[chat.workspaceId] ?: continue
                if (searching && !chat.title.contains(query, ignoreCase = true) &&
                    !workspaceName.contains(query, ignoreCase = true)) continue
                val isOpen = chat.id == openChatId
                var placement = AidenInbox.placement(chat, isOpen, now, recentWindow)
                if (searching && placement.section == null) {
                    placement = AidenInbox.localPlacement(
                        AidenInbox.Signals.of(chat, isOpen),
                        now,
                        recentWindow = null,
                        includeTriaged = true
                    )
                }
                val section = placement.section ?: continue
                bySection.getValue(section).add(AidenInboxRow(chat, placement))
            }
            val earlier = bySection.getValue(AidenInboxSection.EARLIER).sortedWith(newestFirst)
            val capped = !searching && !showAllEarlier && earlier.size > earlierLimit
            return AidenInboxProjection(
                needsYou = bySection.getValue(AidenInboxSection.NEEDS_YOU)
                    .sortedWith(compareBy<AidenInboxRow> { it.placement.tier }.then(oldestFirst)),
                pinned = bySection.getValue(AidenInboxSection.PINNED).sortedWith(newestFirst),
                updates = bySection.getValue(AidenInboxSection.UPDATES).sortedWith(newestFirst),
                earlier = if (capped) earlier.take(earlierLimit) else earlier,
                working = bySection.getValue(AidenInboxSection.WORKING).sortedWith(oldestFirst),
                earlierOverflow = if (capped) earlier.size - earlierLimit else 0
            )
        }
    }
}

/** One triage write. Each field present is set; the rest are left alone. */
data class AidenChatTriageChange(
    val pinned: Boolean? = null,
    val done: Boolean? = null,
    val snooze: Snooze? = null
) {
    sealed interface Snooze {
        data class Until(val at: Instant) : Snooze
        data object Wake : Snooze
    }

    /** Whether the change takes the row out of the Inbox (Done or a Snooze). */
    val hidesRow: Boolean get() = done == true || snooze is Snooze.Until

    companion object {
        fun done(value: Boolean) = AidenChatTriageChange(done = value)
        fun snooze(until: Instant) = AidenChatTriageChange(snooze = Snooze.Until(until))
        val wake = AidenChatTriageChange(snooze = Snooze.Wake)
    }
}

/** The chat's triage after a write. */
data class AidenChatTriageResult(
    val chatId: String,
    val revision: Int,
    val updatedAt: Instant,
    val pinnedAt: Instant? = null,
    val doneAt: Instant? = null,
    val snoozedUntil: Instant? = null
)

/** The desktop's Snooze presets (`snoozeOptions`), on this phone's clock and zone. */
data class AidenSnoozeOption(val preset: Preset, val until: Instant) {
    enum class Preset { HOUR, EVENING, TOMORROW, NEXT_WEEK }

    companion object {
        /**
         * One hour from now; this evening at 18:00 only while that is more
         * than an hour away; tomorrow at 09:00; and the next Monday at 09:00
         * at least two days away, so it never repeats Tomorrow.
         */
        fun options(now: Instant, zone: ZoneId = ZoneId.systemDefault()): List<AidenSnoozeOption> {
            val hour = now.plus(1, ChronoUnit.HOURS)
            val today = ZonedDateTime.ofInstant(now, zone).toLocalDate()
            fun at(dayOffset: Long, hourOfDay: Int): Instant =
                today.plusDays(dayOffset).atTime(hourOfDay, 0).atZone(zone).toInstant()
            val options = mutableListOf(AidenSnoozeOption(Preset.HOUR, hour))
            val evening = at(0, 18)
            if (evening.isAfter(hour)) options += AidenSnoozeOption(Preset.EVENING, evening)
            options += AidenSnoozeOption(Preset.TOMORROW, at(1, 9))
            // Days until the next Monday, 1…7; one day away becomes eight.
            val untilMonday = ((DayOfWeek.MONDAY.value - today.dayOfWeek.value + 7) % 7).let { if (it == 0) 7 else it }
            val daysToMonday = if (untilMonday < 2) untilMonday + 7 else untilMonday
            options += AidenSnoozeOption(Preset.NEXT_WEEK, at(daysToMonday.toLong(), 9))
            return options
        }
    }
}

/** Inbox durations ("<1m", "4m", "2h", "3d"), as the desktop shows them. */
object AidenInboxDuration {
    fun text(since: Instant, now: Instant): String {
        val minutes = maxOf(0L, Duration.between(since, now).seconds) / 60
        if (minutes < 1) return "<1m"
        if (minutes < 60) return "${minutes}m"
        val hours = minutes / 60
        if (hours < 24) return "${hours}h"
        return "${hours / 24}d"
    }
}
