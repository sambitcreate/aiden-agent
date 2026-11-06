package sbtbiswas.AidenOnTheGo.notifications

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenBotRoutineNotification
import sbtbiswas.AidenOnTheGo.models.AidenBotRoutineNotificationList
import sbtbiswas.AidenOnTheGo.models.AidenBotWireJson
import sbtbiswas.AidenOnTheGo.models.AidenInstallation
import sbtbiswas.AidenOnTheGo.models.AidenServer
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
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
    private val allGrants = setOf(AidenRemoteCapability.BOT_READ, AidenRemoteCapability.CHAT_READ,
        AidenRemoteCapability.BOT_PEERS, AidenRemoteCapability.BOT_MESSAGING, AidenRemoteCapability.BOT_ISSUES, AidenRemoteCapability.BOT_ACCESS_REQUESTS)
    private fun installation(held: Set<AidenRemoteCapability>) = AidenInstallation(instanceId="host", deviceId="phone", name="Host",
        endpoint="https://host.test/api/aiden/v1", serverSpkiSha256="sha256/test", deviceCapabilities=held.toList(), serverCapabilities=allGrants.toList(), createdAt=Instant.EPOCH)
    private fun host(held: Set<AidenRemoteCapability>, offered: List<AidenRemoteCapability>? = allGrants.toList()) =
        AidenServer(protocolVersion=1, instanceId="host", name="Host", capabilities=held.toList(), serverCapabilities=offered)
    private fun projected(kind: String) = AidenBotWireJson.json.decodeFromString(AidenBotRoutineNotification.serializer(),
        """{"id":"projected-final","kind":"$kind","botId":"bot_fixture_01","botName":"Planner","routineName":"Needs you","finishedAt":"2026-11-03T12:00:00.000Z","preview":"A bounded host preview."}""")


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
    @Test fun peerResultUsesStableDedupAndLateCapabilityOrPairingLossKeepsCursor()=runTest {
        val item=AidenBotWireJson.json.decodeFromJsonElement(AidenBotRoutineNotification.serializer(),sbtbiswas.AidenOnTheGo.peerFixture().getValue("peerNotification"))
        val start=item.finishedAt.minusSeconds(1)
        val ledger=MemoryLedger().apply{cursors["host"]=start}
        val posted=mutableListOf<String>();var pairing=true;var peers=true
        val delivery=AidenBotRoutineNotificationDelivery(ledger){_,n->posted+=n.botId+":"+n.id;true}
        val feed=AidenBotRoutineNotificationList(listOf(item),item.finishedAt.plusSeconds(1))
        assertEquals(0,delivery.deliver("host",isCurrent={pairing},mayDeliver={peers},currentGrants={allGrants}){peers=false;feed})
        assertEquals(start,ledger.cursors["host"]);assertTrue(posted.isEmpty())
        peers=true
        assertEquals(0,delivery.deliver("host",isCurrent={pairing},mayDeliver={peers},currentGrants={allGrants}){pairing=false;feed})
        assertEquals(start,ledger.cursors["host"]);assertTrue(posted.isEmpty())
        pairing=true
        assertEquals(1,delivery.deliver("host",isCurrent={pairing},mayDeliver={peers},currentGrants={allGrants}){feed})
        assertEquals(listOf("bot_planner:peer_root_one"),posted)
        assertEquals(0,delivery.deliver("host",isCurrent={pairing},mayDeliver={peers},currentGrants={allGrants}){feed})
        assertEquals(listOf("bot_planner:peer_root_one"),posted)
        assertEquals("aiden.bot-routine.peer_root_one",AidenBotRoutineNotificationDelivery.tag(item))
    }



    @Test
    fun mergedMessageAndPeerFeedKeepsBothKindsAndDeduplicatesAfterAccessRestores() = runTest {
        val peer = AidenBotWireJson.json.decodeFromJsonElement(AidenBotRoutineNotification.serializer(), sbtbiswas.AidenOnTheGo.peerFixture().getValue("peerNotification"))
        val message = AidenBotWireJson.json.decodeFromString(AidenBotRoutineNotification.serializer(),
            """{"id":"message_merged","kind":"message","botId":"bot_fixture_01","botName":"COS","routineName":"COS replied","finishedAt":"2026-11-03T12:00:01.000Z","preview":"[redacted]"}""").copy(finishedAt = peer.finishedAt.plusSeconds(1))
        val ledger = MemoryLedger().apply { cursors["host"] = peer.finishedAt.minusSeconds(1) }
        val posted = mutableListOf<String>()
        val delivery = AidenBotRoutineNotificationDelivery(ledger) { _, item -> posted += item.id; true }
        var peers = false
        val mixed = AidenBotRoutineNotificationList(listOf(message, peer), message.finishedAt.plusSeconds(1))
        val allowed: (AidenBotRoutineNotification) -> Boolean = { it.kind != sbtbiswas.AidenOnTheGo.models.AidenBotNotificationKind.PEER || peers }
        assertEquals(0, delivery.deliver("host", mayDeliver = allowed, currentGrants = { allGrants }) { mixed })
        assertEquals(peer.finishedAt.minusSeconds(1), ledger.cursors["host"])
        peers = true
        assertEquals(2, delivery.deliver("host", mayDeliver = allowed, currentGrants = { allGrants }) { mixed })
        assertEquals(listOf(peer.id, "message_merged"), posted)
        assertEquals(0, delivery.deliver("host", mayDeliver = allowed, currentGrants = { allGrants }) { mixed })
        assertEquals(2, posted.size)
    }

    @Test
    fun originalMessageAndIssueAudienceIsRevalidatedBeforeAndAfterPosting() = runTest {
        val cases = listOf("message" to AidenRemoteCapability.BOT_MESSAGING, "issue" to AidenRemoteCapability.BOT_ISSUES, "issue" to AidenRemoteCapability.BOT_ACCESS_REQUESTS)
        for ((kind, lost) in cases) for (boundary in listOf("fetch", "post")) {
            val item = projected(kind)
            val start = item.finishedAt.minusSeconds(1)
            val ledger = MemoryLedger().apply { cursors["host"] = start; delivered["host"] = listOf("prior-receipt") }
            var installed = installation(allGrants)
            val server = host(allGrants)
            val posts = mutableListOf<String>()
            val delivery = AidenBotRoutineNotificationDelivery(ledger) { _, row ->
                posts += row.id
                if (boundary == "post") installed = installation(allGrants - lost)
                true
            }
            val result = delivery.deliverFromHost("host", { installed }, { server }, { true }) {
                if (boundary == "fetch") installed = installation(allGrants - lost)
                AidenBotRoutineNotificationList(listOf(item), item.finishedAt.plusSeconds(1))
            }
            assertEquals("$kind / $lost / $boundary", 0, result)
            assertEquals(if (boundary == "fetch") emptyList<String>() else listOf("projected-final"), posts)
            assertEquals(start, ledger.cursors["host"])
            assertEquals(listOf("prior-receipt"), ledger.delivered["host"])
        }
    }

    @Test
    fun restoredAudienceDeliversOnceAndPairingPurgeDuringPostCannotRecreateReceipts() = runTest {
        val item = projected("message")
        val start = item.finishedAt.minusSeconds(1)
        val ledger = MemoryLedger().apply { cursors["host"] = start }
        var installed = installation(allGrants)
        val server = host(allGrants)
        var current = true
        var purgeOnPost = true
        val posts = mutableListOf<String>()
        val delivery = AidenBotRoutineNotificationDelivery(ledger) { _, row ->
            posts += row.id
            if (purgeOnPost) { current = false; ledger.cursors.remove("host"); ledger.delivered.remove("host") }
            true
        }
        val batch = AidenBotRoutineNotificationList(listOf(item), item.finishedAt.plusSeconds(1))
        assertEquals(0, delivery.deliverFromHost("host", { installed }, { server }, { current }) { batch })
        assertTrue(ledger.cursors.isEmpty()); assertTrue(ledger.delivered.isEmpty())
        current = true; purgeOnPost = false; ledger.cursors["host"] = start
        installed = installation(allGrants - AidenRemoteCapability.BOT_MESSAGING)
        assertEquals(0, delivery.deliverFromHost("host", { installed }, { server }, { current }) { batch })
        installed = installation(allGrants)
        assertEquals(1, delivery.deliverFromHost("host", { installed }, { server }, { current }) { batch })
        assertEquals(0, delivery.deliverFromHost("host", { installed }, { server }, { current }) { batch })
        assertEquals(listOf("projected-final", "projected-final"), posts)
    }

    @Test
    fun productionAudienceRejectsOffersWithoutHeldGrantsAndKeepsLegacyRoutineDelivery() = runTest {
        val item = projected("message")
        val ledger = MemoryLedger().apply { cursors["host"] = item.finishedAt.minusSeconds(1) }
        val posts = mutableListOf<String>()
        val delivery = AidenBotRoutineNotificationDelivery(ledger) { _, row -> posts += row.id; true }
        val batch = AidenBotRoutineNotificationList(listOf(item), item.finishedAt.plusSeconds(1))
        assertEquals(0, delivery.deliverFromHost("host", { installation(allGrants - AidenRemoteCapability.BOT_MESSAGING) }, { host(allGrants) }, { true }) { batch })
        assertEquals(0, delivery.deliverFromHost("host", { installation(allGrants) }, { host(allGrants - AidenRemoteCapability.BOT_MESSAGING) }, { true }) { batch })
        assertEquals(0, delivery.deliverFromHost("host", { installation(allGrants) }, { host(allGrants, null) }, { true }) { batch })
        assertEquals(0, delivery.deliverFromHost("host", { installation(allGrants).copy(serverCapabilities = null) }, { host(allGrants) }, { true }) { batch })
        assertTrue(posts.isEmpty())
        val base = setOf(AidenRemoteCapability.BOT_READ, AidenRemoteCapability.CHAT_READ)
        val legacy = host(base, null)
        val routine = fixtureRun.copy(finishedAt = item.finishedAt)
        assertEquals(1, delivery.deliverFromHost("host", { installation(base) }, { legacy }, { true }) { AidenBotRoutineNotificationList(listOf(routine), item.finishedAt.plusSeconds(1)) })
        assertEquals(listOf(routine.id), posts)
    }

    @Test
    fun messageNotificationTapOpensItsBotAndRedactedPreviewStaysRedacted() = runTest {
        val item = AidenBotWireJson.json.decodeFromString(AidenBotRoutineNotification.serializer(),
            """{"id":"message_1","kind":"message","botId":"bot_fixture_01","botName":"COS","routineName":"COS replied","finishedAt":"2026-11-03T12:00:00.000Z","preview":"[redacted]"}""")
        val ledger = MemoryLedger().apply { cursors["mac-1"] = Instant.parse("2026-11-03T11:59:00Z") }
        val posted = mutableListOf<AidenBotRoutineNotification>()
        val delivery = AidenBotRoutineNotificationDelivery(ledger) { _, message -> posted += message; true }
        assertEquals(1, delivery.deliver("mac-1", currentGrants = { allGrants }) { feed("2026-11-03T12:01:00Z", item) })
        assertEquals("[redacted]", posted.single().preview)
        assertEquals(AidenDeepLink.botChatUrl("bot_fixture_01", "mac-1"), AidenBotRoutineNotificationDelivery.chatUrl("mac-1", item))
        assertEquals(0, delivery.deliver("mac-1", currentGrants = { allGrants }) { feed("2026-11-03T12:02:00Z", item) })
        assertEquals(1, posted.size)
    }
}
