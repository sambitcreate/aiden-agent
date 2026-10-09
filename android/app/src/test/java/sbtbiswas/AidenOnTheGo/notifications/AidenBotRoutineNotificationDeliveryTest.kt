package sbtbiswas.AidenOnTheGo.notifications

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenBotRoutineNotification
import sbtbiswas.AidenOnTheGo.models.AidenBotRoutineNotificationList
import sbtbiswas.AidenOnTheGo.models.AidenBotWireJson
import java.io.IOException
import java.time.Instant

/** The Bot variant of the routine notifier: cursor per paired Mac, posts once, never replays history. */
class AidenBotRoutineNotificationDeliveryTest {
    private val fixtureFeed: AidenBotRoutineNotificationList by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json"))
            .bufferedReader().use { it.readText() }
        AidenBotWireJson.json.decodeFromJsonElement(
            AidenBotRoutineNotificationList.serializer(),
            AidenBotWireJson.json.parseToJsonElement(text).jsonObject.getValue("botRoutineNotifications")
        )
    }
    private val fixtureRun get() = fixtureFeed.notifications.single()

    private class MemoryLedger : AidenBotRoutineNotificationLedger {
        val cursors = mutableMapOf<String, Instant>()
        val delivered = mutableMapOf<String, List<String>>()
        override fun cursor(instanceId: String) = cursors[instanceId]
        override fun delivered(instanceId: String) = delivered[instanceId].orEmpty()
        override fun save(instanceId: String, cursor: Instant, delivered: List<String>) {
            cursors[instanceId] = cursor
            this.delivered[instanceId] = delivered
        }
    }

    private fun run(id: String, finishedAt: String) = fixtureRun.copy(id = id, finishedAt = Instant.parse(finishedAt))

    private fun feed(now: String, vararg runs: AidenBotRoutineNotification) =
        AidenBotRoutineNotificationList(runs.toList(), Instant.parse(now))

    @Test
    fun theFirstPollForAMacOnlyRecordsWhereTheFeedStands() = runTest {
        val ledger = MemoryLedger()
        val posted = mutableListOf<AidenBotRoutineNotification>()
        val delivery = AidenBotRoutineNotificationDelivery(ledger) { _, item -> posted += item; true }
        val sinces = mutableListOf<Instant?>()

        assertEquals(0, delivery.deliver("mac-1") { since -> sinces += since; fixtureFeed })
        assertTrue(posted.isEmpty())
        assertEquals(listOf<Instant?>(null), sinces)
        assertEquals(fixtureFeed.now, ledger.cursors["mac-1"])
        assertEquals(listOf(fixtureRun.id), ledger.delivered["mac-1"])
    }

    @Test
    fun laterRunsArePostedOnceOldestFirstAndTheCursorMovesToTheHostsNow() = runTest {
        val ledger = MemoryLedger().apply { cursors["mac-1"] = Instant.parse("2026-08-19T15:01:00Z") }
        val posted = mutableListOf<String>()
        val delivery = AidenBotRoutineNotificationDelivery(ledger) { _, item -> posted += item.id; true }
        val newer = run("run_2", "2026-08-19T16:00:00Z")
        val older = run("run_1", "2026-08-19T15:30:00Z")
        val sinces = mutableListOf<Instant?>()

        assertEquals(2, delivery.deliver("mac-1") { since -> sinces += since; feed("2026-08-19T16:01:00Z", newer, older) })
        assertEquals(listOf("run_1", "run_2"), posted)
        assertEquals(listOf<Instant?>(Instant.parse("2026-08-19T15:01:00Z")), sinces)
        assertEquals(Instant.parse("2026-08-19T16:01:00Z"), ledger.cursors["mac-1"])

        // The foreground and Bots home both poll: the same runs are never posted twice.
        assertEquals(0, delivery.deliver("mac-1") { feed("2026-08-19T16:02:00Z", newer, older) })
        assertEquals(listOf("run_1", "run_2"), posted)
    }

    @Test
    fun aFailedPostStopsAndStaysInsideTheNextPollsWindow() = runTest {
        val ledger = MemoryLedger().apply { cursors["mac-1"] = Instant.parse("2026-08-19T15:00:00Z") }
        val posted = mutableListOf<String>()
        var allow = setOf("run_1")
        val delivery = AidenBotRoutineNotificationDelivery(ledger) { _, item ->
            (item.id in allow).also { if (it) posted += item.id }
        }
        val first = run("run_1", "2026-08-19T15:10:00Z")
        val second = run("run_2", "2026-08-19T15:20:00Z")

        assertEquals(1, delivery.deliver("mac-1") { feed("2026-08-19T15:30:00Z", first, second) })
        // The cursor stops just before the run that could not be posted.
        val cursor = ledger.cursors.getValue("mac-1")
        assertTrue(cursor.isBefore(second.finishedAt))

        allow = setOf("run_1", "run_2")
        assertEquals(1, delivery.deliver("mac-1") { since ->
            assertEquals(cursor, since)
            feed("2026-08-19T15:31:00Z", first, second)
        })
        assertEquals(listOf("run_1", "run_2"), posted)
    }

    @Test
    fun anUnreachableMacKeepsTheCursorAndEachMacHasItsOwn() = runTest {
        val start = Instant.parse("2026-08-19T15:00:00Z")
        val ledger = MemoryLedger().apply {
            cursors["mac-1"] = start
            cursors["mac-2"] = start
        }
        val posted = mutableListOf<Pair<String, String>>()
        val delivery = AidenBotRoutineNotificationDelivery(ledger) { instance, item -> posted += instance to item.id; true }

        assertEquals(0, delivery.deliver("mac-1") { throw IOException("offline") })
        assertEquals(start, ledger.cursors["mac-1"])

        delivery.deliver("mac-2") { feed("2026-08-19T15:30:00Z", run("run_9", "2026-08-19T15:10:00Z")) }
        assertEquals(listOf("mac-2" to "run_9"), posted)
        assertEquals(start, ledger.cursors["mac-1"])
        assertEquals(Instant.parse("2026-08-19T15:30:00Z"), ledger.cursors["mac-2"])
    }

    @Test
    fun eachRunIsTaggedByItsRunId() {
        assertEquals("aiden.bot-routine.run_fixture_bot_01", AidenBotRoutineNotificationDelivery.tag(fixtureRun))
    }
}
