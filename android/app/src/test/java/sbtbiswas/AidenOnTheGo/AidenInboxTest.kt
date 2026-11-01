package sbtbiswas.AidenOnTheGo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenInboxNotice
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenInboxNoticeText
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenInboxRowStatus
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatSummaryActivity
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageChange
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageResult
import sbtbiswas.AidenOnTheGo.models.AidenInbox
import sbtbiswas.AidenOnTheGo.models.AidenInboxDuration
import sbtbiswas.AidenOnTheGo.models.AidenInboxProjection
import sbtbiswas.AidenOnTheGo.models.AidenInboxRow
import sbtbiswas.AidenOnTheGo.models.AidenInboxSection
import sbtbiswas.AidenOnTheGo.models.AidenSnoozeOption
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale

class AidenInboxTest {
    private val now = Instant.parse("2026-09-09T12:00:00Z") // a Wednesday
    private val names = mapOf("ws" to "Workspace")

    private fun chat(
        id: String,
        updatedAgo: Duration = Duration.ofMinutes(5),
        activity: AidenChatSummaryActivity = AidenChatSummaryActivity.IDLE,
        rowState: String? = null,
        unread: Boolean = false,
        failed: Boolean = false,
        bucket: String? = null,
        sortAt: Instant? = null,
        title: String = "Chat $id",
        workspaceId: String = "ws",
        lastAssistantAt: Instant? = null,
        attentionSince: Instant? = null,
        runStartedAt: Instant? = null,
        pinnedAt: Instant? = null,
        doneAt: Instant? = null,
        snoozedUntil: Instant? = null,
        triageRevision: Int? = null
    ): AidenChatSummary {
        val updatedAt = now.minus(updatedAgo)
        return AidenChatSummary(
            id = id,
            workspaceId = workspaceId,
            title = title,
            titlePending = false,
            createdAt = updatedAt.minus(Duration.ofDays(30)),
            updatedAt = updatedAt,
            revision = "rev-$id",
            activity = activity,
            rowStateWire = rowState,
            unread = unread,
            lastRunFailed = failed,
            inboxBucketWire = bucket,
            inboxSortAtWire = sortAt,
            lastAssistantAt = lastAssistantAt,
            attentionSince = attentionSince,
            runStartedAt = runStartedAt,
            pinnedAt = pinnedAt,
            doneAt = doneAt,
            snoozedUntil = snoozedUntil,
            triageRevision = triageRevision
        )
    }

    private fun section(summary: AidenChatSummary, isOpen: Boolean = false) =
        AidenInbox.placement(summary, isOpen, now).section

    @Test
    fun localRulesPlaceEachRowWhereTheDesktopWould() {
        val active = AidenChatSummaryActivity.ACTIVE
        assertEquals(AidenInboxSection.NEEDS_YOU, section(chat("a", activity = active, rowState = "needs_approval")))
        assertEquals(AidenInboxSection.NEEDS_YOU, section(chat("q", activity = active, rowState = "needs_input")))
        assertEquals(AidenInboxSection.WORKING, section(chat("w", activity = active, rowState = "working")))
        assertEquals(AidenInboxSection.NEEDS_YOU, section(chat("f", unread = true, failed = true)))
        assertEquals(AidenInboxSection.UPDATES, section(chat("u", unread = true)))
        assertEquals(AidenInboxSection.EARLIER, section(chat("e")))
        assertEquals(AidenInboxSection.PINNED, section(chat("p", unread = true, pinnedAt = now.minusSeconds(60))))
        // Older than the recent window drops out, unless it is the open chat.
        assertNull(section(chat("old", updatedAgo = Duration.ofDays(8))))
        assertEquals(AidenInboxSection.EARLIER, section(chat("old", updatedAgo = Duration.ofDays(8)), isOpen = true))
        // Done holds until newer output; a snooze until it ends.
        assertNull(section(chat("d", doneAt = now.minusSeconds(60), lastAssistantAt = now.minusSeconds(120))))
        assertEquals(AidenInboxSection.UPDATES,
            section(chat("d2", unread = true, doneAt = now.minusSeconds(120), lastAssistantAt = now.minusSeconds(60))))
        assertNull(section(chat("s", snoozedUntil = now.plusSeconds(600))))
        // A live prompt overrides Done and Snooze.
        assertEquals(AidenInboxSection.NEEDS_YOU, section(chat("ad", activity = active, rowState = "needs_approval",
            doneAt = now.minusSeconds(60), snoozedUntil = now.plusSeconds(600))))
        // The open chat is never unread, so never in Updates or the failed tier.
        assertEquals(AidenInboxSection.EARLIER, section(chat("fo", unread = true, failed = true), isOpen = true))
    }

    @Test
    fun hostBucketIsUsedUntilThePhoneKnowsBetter() {
        val hostTime = now.minus(Duration.ofHours(3))
        // The host's bucket and time win when they agree with what the phone sees.
        val pinned = AidenInbox.placement(chat("p", bucket = "pinned", sortAt = hostTime), false, now)
        assertEquals(AidenInboxSection.PINNED, pinned.section)
        assertEquals(hostTime, pinned.sortAt)
        assertEquals(AidenInboxSection.UPDATES, section(chat("u", unread = true, bucket = "updates", sortAt = hostTime)))
        assertNull(section(chat("d", bucket = "done", sortAt = hostTime)))

        // A snooze that ended on this phone's clock is awake.
        assertEquals(AidenInboxSection.EARLIER,
            section(chat("s", bucket = "snoozed", sortAt = hostTime, snoozedUntil = now.minusSeconds(1))))
        assertNull(section(chat("s2", bucket = "snoozed", sortAt = hostTime, snoozedUntil = now.plusSeconds(60))))
        // The open chat leaves Updates and the failed tier.
        assertEquals(AidenInboxSection.EARLIER,
            section(chat("uo", unread = true, bucket = "updates", sortAt = hostTime), isOpen = true))
        assertEquals(AidenInboxSection.EARLIER,
            section(chat("fo", unread = true, failed = true, bucket = "needs_you", sortAt = hostTime), isOpen = true))
        // Earlier past the window on the phone's clock drops out.
        assertNull(section(chat("e", updatedAgo = Duration.ofDays(9), bucket = "earlier", sortAt = hostTime)))
        // Live row state seen here wins over a stale bucket.
        assertEquals(AidenInboxSection.WORKING, section(chat("w", activity = AidenChatSummaryActivity.ACTIVE,
            rowState = "working", bucket = "earlier", sortAt = hostTime)))
        assertEquals(AidenInboxSection.EARLIER, section(chat("wi", bucket = "working", sortAt = hostTime)))
        // An approval keeps its tier but takes the host's time.
        val approval = AidenInbox.placement(chat("a", activity = AidenChatSummaryActivity.ACTIVE,
            rowState = "needs_approval", bucket = "needs_you", sortAt = hostTime), false, now)
        assertEquals(AidenInbox.TIER_APPROVAL, approval.tier)
        assertEquals(hostTime, approval.sortAt)
        // A bucket without a sort time is not used.
        assertEquals(AidenInboxSection.EARLIER, section(chat("half", bucket = "pinned")))
    }

    @Test
    fun projectionOrdersSectionsCapsEarlierAndSearchFindsTriagedRows() {
        val active = AidenChatSummaryActivity.ACTIVE
        val chats = listOf(
            chat("failed", unread = true, failed = true, attentionSince = now.minusSeconds(30)),
            chat("question", activity = active, rowState = "needs_input", attentionSince = now.minusSeconds(10)),
            chat("approval-new", activity = active, rowState = "needs_approval", attentionSince = now.minusSeconds(20)),
            chat("approval-old", activity = active, rowState = "needs_approval", attentionSince = now.minusSeconds(900)),
            chat("run-late", activity = active, rowState = "working", runStartedAt = now.minusSeconds(10)),
            chat("run-early", activity = active, rowState = "working", runStartedAt = now.minusSeconds(100)),
            chat("hidden", doneAt = now.minusSeconds(10), title = "Quarterly report"),
            chat("elsewhere", workspaceId = "gone")
        ) + (1..23).map { chat("earlier-%02d".format(it), updatedAgo = Duration.ofMinutes(it.toLong())) }

        val inbox = AidenInboxProjection.make(chats, names, openChatId = null, now = now)
        assertEquals(listOf("approval-old", "approval-new", "question", "failed"), inbox.needsYou.map { it.id })
        assertEquals(listOf("run-early", "run-late"), inbox.working.map { it.id })
        assertEquals(AidenInbox.EARLIER_LIMIT, inbox.earlier.size)
        assertEquals("earlier-01", inbox.earlier.first().id)
        assertEquals(3, inbox.earlierOverflow)
        assertFalse(AidenInboxSection.entries.any { s -> inbox.rows(s).any { it.id == "hidden" || it.id == "elsewhere" } })

        val all = AidenInboxProjection.make(chats, names, null, now, showAllEarlier = true)
        assertEquals(23, all.earlier.size)
        assertEquals(0, all.earlierOverflow)

        // Search lists a Done match where it would sit untriaged.
        val found = AidenInboxProjection.make(chats, names, null, now, searchText = "quarterly")
        assertEquals(listOf("hidden"), found.earlier.map { it.id })
        assertTrue(found.needsYou.isEmpty())
        assertTrue(AidenInboxProjection.make(emptyList(), names, null, now).isEmpty)
    }

    @Test
    fun snoozePresetsMatchTheDesktop() {
        val zone = ZoneOffset.UTC
        // Wednesday noon: an hour, this evening, tomorrow, next Monday.
        val noon = AidenSnoozeOption.options(now, zone)
        assertEquals(
            listOf("2026-09-09T13:00:00Z", "2026-09-09T18:00:00Z", "2026-09-10T09:00:00Z", "2026-09-14T09:00:00Z"),
            noon.map { it.until.toString() }
        )
        // Within an hour of 18:00 there is no "this evening".
        val late = AidenSnoozeOption.options(Instant.parse("2026-09-09T17:30:00Z"), zone)
        assertFalse(late.any { it.preset == AidenSnoozeOption.Preset.EVENING })
        // On a Sunday, next week skips tomorrow's Monday.
        val sunday = AidenSnoozeOption.options(Instant.parse("2026-09-13T20:00:00Z"), zone)
        assertEquals(Instant.parse("2026-09-14T09:00:00Z"), sunday.first { it.preset == AidenSnoozeOption.Preset.TOMORROW }.until)
        assertEquals(Instant.parse("2026-09-21T09:00:00Z"), sunday.first { it.preset == AidenSnoozeOption.Preset.NEXT_WEEK }.until)
        // Saturday: Monday is two days away, so it stays.
        val saturday = AidenSnoozeOption.options(Instant.parse("2026-09-12T10:00:00Z"), zone)
        assertEquals(Instant.parse("2026-09-14T09:00:00Z"), saturday.first { it.preset == AidenSnoozeOption.Preset.NEXT_WEEK }.until)
        // Presets follow the phone's zone.
        val tokyo = AidenSnoozeOption.options(now, ZoneId.of("Asia/Tokyo"))
        assertEquals(Instant.parse("2026-09-10T00:00:00Z"), tokyo.first { it.preset == AidenSnoozeOption.Preset.TOMORROW }.until)
    }

    @Test
    fun durationsReadLikeTheDesktop() {
        assertEquals("<1m", AidenInboxDuration.text(now.minusSeconds(30), now))
        assertEquals("<1m", AidenInboxDuration.text(now.plusSeconds(30), now))
        assertEquals("4m", AidenInboxDuration.text(now.minusSeconds(4 * 60 + 59), now))
        assertEquals("2h", AidenInboxDuration.text(now.minus(Duration.ofMinutes(150)), now))
        assertEquals("3d", AidenInboxDuration.text(now.minus(Duration.ofHours(80)), now))
    }

    @Test
    fun triageWritesMoveTheRowAtOnceAndTheHostAnswerSettlesIt() {
        val row = chat("c", unread = true, failed = true, bucket = "needs_you", sortAt = now, triageRevision = 2)
        val done = AidenInbox.applyingOptimisticTriage(AidenChatTriageChange.done(true), row, now, alsoMarkRead = true)
        assertEquals(now, done.doneAt)
        assertFalse(done.unread)
        assertNull(done.inboxBucket)
        assertNull(section(done))

        // A snooze already past is no snooze.
        val past = AidenInbox.applyingOptimisticTriage(AidenChatTriageChange.snooze(now.minusSeconds(5)), row, now)
        assertNull(past.snoozedUntil)
        val later = now.plusSeconds(3600)
        val snoozed = AidenInbox.applyingOptimisticTriage(AidenChatTriageChange.snooze(later), chat("s"), now)
        assertEquals(later, snoozed.snoozedUntil)
        assertNull(section(snoozed))
        assertNull(AidenInbox.applyingOptimisticTriage(AidenChatTriageChange.wake, snoozed, now).snoozedUntil)

        val settled = AidenInbox.applyingTriageResult(
            AidenChatTriageResult("s", revision = 3, updatedAt = now, snoozedUntil = later), snoozed
        )
        assertEquals(3, settled.triageRevision)
        assertEquals(later, settled.snoozedUntil)

        assertEquals(AidenChatTriageChange.done(false), AidenChatTriageChange.done(true).undo)
        assertEquals(AidenChatTriageChange.wake, AidenChatTriageChange.snooze(later).undo)
        assertNull(AidenChatTriageChange.wake.undo)
        // Done and Snooze are never offered on a row that waits or runs.
        assertTrue(AidenInbox.offersDoneAndSnooze(chat("idle")))
        assertFalse(AidenInbox.offersDoneAndSnooze(chat("w", activity = AidenChatSummaryActivity.ACTIVE, rowState = "working")))
        assertFalse(AidenInbox.offersDoneAndSnooze(chat("a", activity = AidenChatSummaryActivity.ACTIVE, rowState = "needs_approval")))
    }

    @Test
    fun rowStatusAndNoticesSayWhatTheRowWaitsOn() {
        val zone = ZoneOffset.UTC
        val locale = Locale.US
        fun status(summary: AidenChatSummary) =
            AidenInboxRowStatus.make(AidenInboxRow(summary, AidenInbox.placement(summary, false, now)), now, zone, locale)

        val approval = status(chat("a", activity = AidenChatSummaryActivity.ACTIVE, rowState = "needs_approval",
            attentionSince = now.minus(Duration.ofMinutes(12))))
        assertEquals("Approval" to "12m", approval.label to approval.wait)
        assertEquals(AidenInboxRowStatus.Tone.WARNING, approval.tone)
        assertEquals("Question", status(chat("q", activity = AidenChatSummaryActivity.ACTIVE, rowState = "needs_input")).label)
        assertEquals(AidenInboxRowStatus.Tone.DANGER, status(chat("f", unread = true, failed = true)).tone)
        assertEquals("Working 2m", status(chat("w", activity = AidenChatSummaryActivity.ACTIVE, rowState = "working",
            runStartedAt = now.minus(Duration.ofMinutes(2)))).label)
        val snoozed = status(chat("s", snoozedUntil = Instant.parse("2026-09-10T09:00:00Z")))
        assertEquals("Until Thu 9:00 AM", snoozed.label)
        assertEquals("Snoozed until Thu 9:00 AM", snoozed.spokenLabel)
        assertEquals(
            "Plan, Workspace, Snoozed until Thu 9:00 AM, Unread",
            AidenInboxRowStatus.accessibilityName("Plan", "Workspace", snoozed, unread = true)
        )

        assertEquals("Marked done", AidenInboxNoticeText.message(
            AidenInboxNotice.Changed(AidenChatTriageChange.done(true), "c", AidenChatTriageChange.done(false)), now, zone, locale))
        // Localized short times may put a narrow no-break space before the meridiem.
        fun plain(text: String) = text.replace('\u202F', ' ')
        assertEquals("Snoozed until today at 6:00 PM", plain(AidenInboxNoticeText.confirmation(
            AidenChatTriageChange.snooze(Instant.parse("2026-09-09T18:00:00Z")), now, zone, locale)))
        assertEquals("Snoozed until Monday at 9:00 AM", plain(AidenInboxNoticeText.confirmation(
            AidenChatTriageChange.snooze(Instant.parse("2026-09-14T09:00:00Z")), now, zone, locale)))
        assertTrue(AidenInboxNoticeText.message(AidenInboxNotice.Conflict(), now, zone, locale).contains("another device"))
    }
}
