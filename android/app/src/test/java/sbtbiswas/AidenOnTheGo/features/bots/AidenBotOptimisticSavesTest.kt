package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairingIdentity
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenBotCache
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.IOException
import java.time.Instant
import java.util.UUID

/** R15: Bot edits on the phone apply at once, wait for the connection on their own, and roll back on failure. */
@OptIn(ExperimentalCoroutinesApi::class)
class AidenBotOptimisticSavesTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private val json = AidenBotWireJson.json
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json"))
            .bufferedReader().use { it.readText() }
        json.parseToJsonElement(text).jsonObject
    }
    private val bot by lazy { json.decodeFromJsonElement(AidenBotDetail.serializer(), fixture.getValue("botDetail")) }

    private fun conflict() = AidenRemoteClientException.Server(409, AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.REVISION_CONFLICT, "Stale.", "req_1", false))
    private fun refused() = AidenRemoteClientException.Server(422, AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.INVALID_REQUEST, "No.", "req_1", false))

    /** A Mac holding one Bot: each save applies the patch on the revision it was sent on, unless told to fail or hang. */
    private inner class Mac {
        var held = bot
        val sends = mutableListOf<Pair<String, AidenBotIdentityPatch>>()
        val failures = ArrayDeque<Exception>()
        var gate: CompletableDeferred<Unit>? = null
        var hang = false
        /** The save landed on the Mac, but its answer never came. */
        var landsThenHangs = false
        var refreshes = 0

        suspend fun save(saved: AidenBotDetail, patch: AidenBotIdentityPatch): AidenBotDetail {
            sends += saved.revision to patch
            gate?.await()
            failures.removeFirstOrNull()?.let { throw it }
            if (landsThenHangs) {
                held = held.applying(patch).copy(revision = "${held.revision}+")
                awaitCancellation()
            }
            if (hang) awaitCancellation()
            if (saved.revision != held.revision) throw conflict()
            held = held.applying(patch).copy(revision = "${held.revision}+", updatedAt = held.updatedAt.plusSeconds(1))
            return held
        }

        suspend fun refresh(): AidenBotDetail {
            refreshes += 1
            return held
        }
    }

    private fun TestScope.editor(
        mac: Mac,
        connected: suspend () -> Boolean = { true },
        shown: MutableList<AidenBotDetail> = mutableListOf(),
        saved: MutableList<AidenBotDetail> = mutableListOf()
    ) = AidenBotIdentityEditor(
        bot,
        save = mac::save,
        refresh = mac::refresh,
        onSaved = { saved += it },
        onShown = { shown += it },
        waitForConnection = connected
    )

    @Test
    fun anEditShowsAtOnceAndTheMacsBotReplacesIt() = runTest {
        val mac = Mac().apply { gate = CompletableDeferred() }
        val shown = mutableListOf<AidenBotDetail>()
        val editor = editor(mac, shown = shown)
        val editing = async { editor.edit(AidenBotIdentityPatch(name = "Chef")) }
        runCurrent()
        assertEquals("shown before the Mac answers", "Chef", editor.state.value.bot.name)
        assertEquals("every screen sees it through the cache", "Chef", shown.last().name)
        assertTrue(editor.state.value.isSaving)
        mac.gate!!.complete(Unit)
        editing.await()
        assertEquals("Chef", editor.state.value.bot.name)
        assertEquals("${bot.revision}+", editor.state.value.bot.revision)
        assertFalse(editor.state.value.isSaving)
        assertNull(editor.state.value.failure)
    }

    @Test
    fun editsMadeWhileOneSavesGoOutTogetherNextOnTheNewestRevision() = runTest {
        val mac = Mac().apply { gate = CompletableDeferred() }
        val editor = editor(mac)
        val first = async { editor.edit(AidenBotIdentityPatch(name = "Chef")) }
        runCurrent()
        // Picked while the first saves: they return at once and show at once.
        editor.edit(AidenBotIdentityPatch(purpose = "Plans meals"))
        editor.edit(AidenBotIdentityPatch(purpose = "Plans dinners"))
        assertEquals("Plans dinners", editor.state.value.bot.purpose)
        mac.gate!!.complete(Unit)
        first.await()
        assertEquals(2, mac.sends.size)
        assertEquals("${bot.revision}+", mac.sends[1].first)
        assertEquals(AidenBotIdentityPatch(purpose = "Plans dinners"), mac.sends[1].second)
        assertEquals("Plans dinners", mac.held.purpose)
    }

    @Test
    fun aRefusedEditGoesBackAndSaysSoWhileALaterOneStays() = runTest {
        val mac = Mac().apply {
            gate = CompletableDeferred()
            failures += refused()
        }
        val editor = editor(mac)
        val first = async { editor.edit(AidenBotIdentityPatch(name = "Chef")) }
        runCurrent()
        editor.edit(AidenBotIdentityPatch(purpose = "Plans meals"))
        mac.gate!!.complete(Unit)
        first.await()
        assertEquals("the refused name went back", bot.name, editor.state.value.bot.name)
        assertEquals("the later edit still saved", "Plans meals", editor.state.value.bot.purpose)
        assertEquals("Plans meals", mac.held.purpose)
        assertEquals(AidenBotChatActivityFailure.GENERIC, editor.state.value.failure)
    }

    @Test
    fun anEditOfflineWaitsForTheMacThenGoesBackAsUnreachable() = runTest {
        val mac = Mac()
        val connection = CompletableDeferred<Boolean>()
        val editor = editor(mac, connected = { connection.await() })
        val editing = async { editor.edit(AidenBotIdentityPatch(name = "Chef")) }
        runCurrent()
        assertEquals("shown while the Mac connects", "Chef", editor.state.value.bot.name)
        assertTrue("nothing sent before the connection", mac.sends.isEmpty())
        advanceTimeBy(AIDEN_BOT_SAVE_HOLD_MILLIS + 1)
        editing.await()
        assertEquals(bot.name, editor.state.value.bot.name)
        assertEquals(AidenBotChatActivityFailure.OFFLINE, editor.state.value.failure)
        assertTrue(mac.sends.isEmpty())
    }

    @Test
    fun aConnectionThatComesInTimeSendsTheEdit() = runTest {
        val mac = Mac()
        val connection = CompletableDeferred<Boolean>()
        val editor = editor(mac, connected = { connection.await() })
        val editing = async { editor.edit(AidenBotIdentityPatch(name = "Chef")) }
        advanceTimeBy(3_000)
        connection.complete(true)
        editing.await()
        assertEquals("Chef", mac.held.name)
        assertNull(editor.state.value.failure)
    }

    @Test
    fun anEditThatLandedButGotNoAnswerShowsAsSaved() = runTest {
        val mac = Mac().apply { landsThenHangs = true }
        val saved = mutableListOf<AidenBotDetail>()
        val editor = editor(mac, saved = saved)
        val editing = async { editor.edit(AidenBotIdentityPatch(name = "Chef")) }
        advanceTimeBy(AIDEN_BOT_SAVE_LIMIT_MILLIS + 1)
        editing.await()
        assertEquals(1, mac.refreshes)
        assertEquals("Chef", editor.state.value.bot.name)
        assertNull("no error for a save that landed", editor.state.value.failure)
        assertEquals("the screens behind hear the Mac's Bot", "Chef", saved.last().name)
    }

    @Test
    fun aStaleRevisionAdoptsTheMacsBotSoTheNextEditSaves() = runTest {
        val mac = Mac()
        mac.held = bot.copy(revision = "changed_on_mac", purpose = "From the Mac")
        val editor = editor(mac)
        editor.edit(AidenBotIdentityPatch(name = "Chef"))
        assertEquals(AidenBotChatActivityFailure.CONFLICT, editor.state.value.failure)
        assertEquals("what the Mac holds now", "From the Mac", editor.state.value.bot.purpose)
        assertEquals(bot.name, editor.state.value.bot.name)
        editor.edit(AidenBotIdentityPatch(name = "Chef"))
        assertEquals("changed_on_mac", mac.sends.last().first)
        assertEquals("Chef", editor.state.value.bot.name)
        assertNull(editor.state.value.failure)
    }

    @Test
    fun aReadDoesNotOverwriteAnEditStillSavingAndNeverGoesBackInTime() = runTest {
        val mac = Mac().apply { gate = CompletableDeferred() }
        val editor = editor(mac)
        val editing = async { editor.edit(AidenBotIdentityPatch(name = "Chef")) }
        runCurrent()
        editor.adopt(bot.copy(name = "From a read", updatedAt = bot.updatedAt.plusSeconds(60)))
        assertEquals("Chef", editor.state.value.bot.name)
        mac.gate!!.complete(Unit)
        editing.await()
        editor.adopt(bot.copy(name = "Older", updatedAt = bot.createdAt))
        assertEquals("Chef", editor.state.value.bot.name)
        val newer = mac.held.copy(name = "Renamed on the Mac", updatedAt = mac.held.updatedAt.plusSeconds(60))
        editor.adopt(newer)
        assertEquals("Renamed on the Mac", editor.state.value.bot.name)
    }

    @Test
    fun aRequestThatHasGoneOutFinishesWhenItsCallerLeaves() = runTest {
        val mac = Mac().apply { gate = CompletableDeferred() }
        val saved = mutableListOf<AidenBotDetail>()
        val editor = editor(mac, saved = saved)
        val job = launch { editor.edit(AidenBotIdentityPatch(name = "Chef")) }
        runCurrent()
        job.cancel()
        mac.gate!!.complete(Unit)
        runCurrent()
        assertEquals("Chef", mac.held.name)
        assertEquals("the screens behind still hear it", "Chef", saved.single().name)
    }

    // Advanced's Save (model pick and access).
    private val catalog by lazy {
        json.decodeFromJsonElement(AidenBotCapabilityCatalog.serializer(), fixture.getValue("botCapabilityCatalog"))
    }

    @Test
    fun advancedSaveShowsTheNewModelAtOnceAndPutsTheBotBackWhenItCantReachTheMac() = runTest {
        val start = bot.copy(sessionState = AidenBotSessionState.NEEDS_MODEL)
        val draft = AidenBotAdvancedDraft.fromDetail(start, catalog)!!.let { it.copy(usesFullAccess = !it.usesFullAccess) }
        val cache = mutableMapOf<String, AidenBotDetail>()
        val disk = mutableListOf<AidenBotDetail>()
        val shown = mutableListOf<AidenBotDetail>()
        val settled = mutableListOf<AidenBotDetail>()
        val failures = mutableListOf<AidenBotChatActivityFailure>()
        val host = AidenBotSaveHost(
            client = { null },
            waitForConnection = { false },
            launch = { block -> launch { block() } },
            show = { cache[it.id] = it },
            cache = { cache[it.id] = it; disk += it },
            cached = { cache[it] }
        )
        aidenBotSaveAdvancedOptimistically(host, start, draft, catalog, show = { shown += it }, settled = { settled += it }, failed = { failures += it })
        val optimistic = shown.single()
        assertEquals(AidenBotModelSelection(draft.customAccess.providerID, draft.customAccess.modelID), optimistic.modelSelection)
        assertEquals("a Bot that needed a model doesn't now", AidenBotSessionState.IDLE, optimistic.sessionState)
        assertEquals("the cache shows it at once", optimistic, cache[bot.id])

        runCurrent()
        assertEquals(listOf(AidenBotChatActivityFailure.OFFLINE), failures)
        assertEquals(start, cache[bot.id])
        assertEquals(listOf(start), settled)
        assertTrue("nothing the Mac didn't confirm is kept", disk.isEmpty())
    }

    @Test
    fun aFailedAdvancedSaveLeavesANewerBotInTheCache() = runTest {
        val draft = AidenBotAdvancedDraft.fromDetail(bot, catalog)!!.let { it.copy(usesFullAccess = !it.usesFullAccess) }
        val cache = mutableMapOf<String, AidenBotDetail>()
        val gate = CompletableDeferred<Boolean>()
        val host = AidenBotSaveHost(
            client = { null },
            waitForConnection = { gate.await() },
            launch = { block -> launch { block() } },
            show = { cache[it.id] = it },
            cache = { cache[it.id] = it },
            cached = { cache[it] }
        )
        aidenBotSaveAdvancedOptimistically(host, bot, draft, catalog, show = {}, settled = {}, failed = {})
        runCurrent()
        val newer = bot.copy(name = "Saved elsewhere")
        cache[bot.id] = newer
        gate.complete(false)
        runCurrent()
        assertEquals("nothing newer is rolled back", newer, cache[bot.id])
    }

    @Test
    fun aHeldRequestWaitsForTheConnectionAndIsBounded() = runTest {
        val never = CompletableDeferred<Boolean>()
        val unreachable = async { runCatching { aidenBotHeldRequest({ never.await() }) { "sent" } } }
        advanceTimeBy(AIDEN_BOT_SAVE_HOLD_MILLIS + 1)
        assertTrue(unreachable.await().exceptionOrNull() is AidenBotChatActivityUnreachable)

        val slow = async { runCatching { aidenBotHeldRequest({ true }) { awaitCancellation() } } }
        advanceTimeBy(AIDEN_BOT_SAVE_LIMIT_MILLIS + 1)
        val timeout = slow.await().exceptionOrNull()
        assertTrue(timeout is AidenBotChatActivityTimeout)
        assertTrue("a timeout may have reached the Mac", aidenBotChatActivityTransportFailure(timeout!!))
    }

    // Bot create stays idempotent when its request times out (R15 bounds it).
    @Test
    fun aCreateThatTimedOutReplaysItsKey() {
        val keys = ArrayDeque(List(2) { UUID.randomUUID() })
        val attempts = AidenBotCreateAttempts(makeKey = { keys.removeFirst() })
        val draft = AidenBotCreateDraft(name = "Chef", help = "Plans meals")
        val first = attempts.begin(draft, catalog)!!
        attempts.failed(first, AidenBotChatActivityTimeout())
        assertTrue(attempts.replays(draft))
        assertEquals("the Mac may have made it", first.key, attempts.begin(draft, catalog)!!.key)
    }

    // --- What a relaunch reads: only what the Mac confirmed reaches the disk (as on iOS) ---

    private val pairing = AidenPairingExchange(
        instanceId = "one",
        deviceId = "device-one",
        endpoint = "https://one.test/api/aiden/v1",
        serverSpkiSha256 = "sha256/one",
        credential = "secret-one",
        capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ)
    )

    /** A paired phone whose Mac never answers: its scope runs nothing, so no request leaves. */
    private fun pairedPhone(): AidenRemoteCoordinator {
        val installations = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        installations.addInstallation(pairing, null)
        return AidenRemoteCoordinator(
            installationStore = installations,
            storageDir = tempFolder.root,
            scope = CoroutineScope(StandardTestDispatcher() + SupervisorJob())
        ).also { it.refreshClient() }
    }

    /** The Bot as the next launch reads it, after the process died. */
    private fun afterRelaunch(id: String): AidenBotDetail? =
        AidenBotCache(tempFolder.root).apply { activate(pairing.instanceId, pairing.deviceId) }.getBotDetail(id)

    @Test
    fun aProfileEditStillSavingShowsEverywhereButARelaunchReadsTheMacsBot() = runTest {
        val phone = pairedPhone()
        phone.pinnedBotCache()(bot)
        val editor = phone.botIdentityEditor(bot)
        val editing = launch { editor.edit(AidenBotIdentityPatch(name = "Chef")) }
        runCurrent()
        assertEquals("every screen shows the edit at once", "Chef", phone.botCache.getBotDetail(bot.id)?.name)
        assertEquals("a process that dies mid-save never comes back showing it saved", bot, afterRelaunch(bot.id))

        // The Mac never connects: the edit goes back, and the disk still holds the Mac's Bot.
        advanceTimeBy(AIDEN_BOT_SAVE_HOLD_MILLIS + 1)
        editing.join()
        assertEquals(bot, phone.botCache.getBotDetail(bot.id))
        assertEquals(bot, afterRelaunch(bot.id))
    }

    @Test
    fun anAdvancedSaveStillSavingShowsAtOnceButARelaunchReadsTheMacsBot() {
        val phone = pairedPhone()
        phone.pinnedBotCache()(bot)
        val draft = AidenBotAdvancedDraft.fromDetail(bot, catalog)!!.let { it.copy(usesFullAccess = !it.usesFullAccess) }
        aidenBotSaveAdvancedOptimistically(phone.botSaveHost(), bot, draft, catalog, show = {}, settled = {}, failed = {})
        assertEquals("shown at once", draft.optimistic(bot, catalog), phone.botCache.getBotDetail(bot.id))
        assertEquals("the disk holds only what the Mac confirmed", bot, afterRelaunch(bot.id))
    }

    @Test
    fun onlyTheMacsAnswerToAProfileEditIsKept() = runBlocking {
        val response = fixture.getValue("botActivity").jsonObject.getValue("identityPatch").jsonObject.getValue("response")
        val answered = json.decodeFromJsonElement(AidenBotDetail.serializer(), response)
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200).setBody(response.toString()))
            val client = AidenRemoteClient(
                endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
                credential = "test_credential_123",
                customOkHttpClient = OkHttpClient()
            )
            val shown = mutableListOf<AidenBotDetail>()
            val kept = mutableListOf<AidenBotDetail>()
            val host = AidenBotSaveHost(
                client = { client },
                waitForConnection = { true },
                launch = { },
                show = { shown += it },
                cache = { kept += it }
            )
            aidenBotIdentityEditor(bot, host).edit(AidenBotIdentityPatch(name = "Chef"))
            assertTrue("the edit showed while it saved", shown.any { it.name == "Chef" && it.revision == bot.revision })
            assertEquals("only the Mac's Bot is kept", listOf(answered), kept)
        } finally {
            server.shutdown()
        }
    }

    // --- New Bot (R15, as on iOS): Create closes at once; Bots home shows it on its way ---

    /** A Mac that makes one Bot per idempotency key, and can lose its answer or refuse. */
    private inner class CreatingMac {
        val made = linkedMapOf<UUID, AidenBotDetail>()
        val requests = mutableListOf<Pair<AidenBotCreateRequest, UUID>>()
        var gate: CompletableDeferred<Unit>? = null
        /** The next create lands but its answer never comes. */
        var losesAnswer = false
        var refuses = false
        var revoked = false

        suspend fun create(request: AidenBotCreateRequest, key: UUID): AidenBotDetail {
            requests += request to key
            gate?.await()
            if (refuses) throw refused()
            if (revoked) throw AidenRemoteClientException.UnexpectedStatus(401)
            val created = made.getOrPut(key) { bot.copy(name = request.name, purpose = request.purpose, revision = "bot_made_${made.size + 1}") }
            if (losesAnswer) {
                losesAnswer = false
                awaitCancellation()
            }
            return created
        }
    }

    private fun TestScope.createFlow(
        mac: CreatingMac,
        connected: suspend () -> Boolean = { true },
        kept: MutableList<AidenBotDetail> = mutableListOf()
    ) = AidenBotCreateFlow(waitForConnection = connected, create = mac::create, cache = { kept += it })

    @Test
    fun aNewBotShowsAsOnItsWayAtOnceAndOpensOnceTheMacMadeIt() = runTest {
        val mac = CreatingMac().apply { gate = CompletableDeferred() }
        val kept = mutableListOf<AidenBotDetail>()
        val flow = createFlow(mac, kept = kept)
        val opened = mutableListOf<AidenBotDetail>()
        val listening = launch { flow.created.collect { opened += it } }
        runCurrent()
        val draft = AidenBotCreateDraft(name = "  Chef ", help = "Plans meals")

        val attempt = flow.start(draft, catalog)!!
        assertEquals("the row shows before anything is sent", "Chef", flow.pending.value?.name)
        assertNull("a second Create waits for this one", flow.start(AidenBotCreateDraft(name = "Other"), catalog))
        val sending = launch { flow.send(attempt) }
        runCurrent()
        assertEquals("Chef", flow.pending.value?.name)

        mac.gate!!.complete(Unit)
        sending.join()
        assertNull("the row gives way to the Bot", flow.pending.value)
        assertNull(flow.failure.value)
        assertEquals(listOf(mac.made.values.single()), kept)
        assertEquals(listOf(mac.made.values.single()), opened)
        listening.cancel()
    }

    @Test
    fun aFailedCreateLeavesTryAgainWithTheSameAnswersAndKeyAndNeverMakesTwoBots() = runTest {
        val mac = CreatingMac().apply { losesAnswer = true }
        val flow = createFlow(mac)
        val draft = AidenBotCreateDraft(name = "Chef", help = "Plans meals", model = aidenBotRecommendedModel(catalog))

        val first = flow.start(draft, catalog)!!
        val sending = launch { flow.send(first) }
        advanceTimeBy(AIDEN_BOT_SAVE_LIMIT_MILLIS + 1)
        sending.join()
        assertNull("the row goes", flow.pending.value)
        val failure = flow.failure.value!!
        assertEquals(draft, failure.draft)
        assertEquals(sbtbiswas.AidenOnTheGo.R.string.bot_editor_create_unreachable, failure.message)

        // Try again reopens New Bot as it was. The Mac's catalog moved on meanwhile.
        assertNull("this launch's failure reopens New Bot", flow.retry())
        assertNull(flow.failure.value)
        val reopened = flow.reopening()
        assertEquals(draft, reopened)
        assertTrue("Create stays enabled for the same answers", flow.replays(reopened!!))
        val moved = catalog.copy(revision = "catalog_revision_moved")
        val second = flow.start(reopened, moved)!!
        assertNull("Create takes the reopened answers", flow.reopening())
        assertEquals("the same Idempotency-Key", first.key, second.key)
        assertEquals("the frozen request, not one rebuilt on the new catalog", first.request, second.request)
        flow.send(second)

        assertEquals("one Bot, however many tries", 1, mac.made.size)
        assertEquals(listOf(first.key, first.key), mac.requests.map { it.second })
        assertNull(flow.failure.value)
        // Made: the same answers again are another Bot, not a replay of this one.
        assertFalse(flow.replays(draft))
        assertFalse(flow.start(draft, catalog)!!.key == first.key)
    }

    @Test
    fun aTryThatNeverReachedTheMacKeepsTheKeyOfOneThatMayHave() = runTest {
        val mac = CreatingMac().apply { losesAnswer = true }
        var reachable = true
        val flow = createFlow(mac, connected = { reachable })
        val draft = AidenBotCreateDraft(name = "Chef")
        val first = flow.start(draft, catalog)!!
        val timedOut = launch { flow.send(first) }
        advanceTimeBy(AIDEN_BOT_SAVE_LIMIT_MILLIS + 1)
        timedOut.join()

        // Offline: nothing goes out, and the try that may have made the Bot stays the one to replay.
        reachable = false
        flow.send(flow.start(draft, catalog)!!)
        assertEquals(1, mac.requests.size)
        reachable = true
        val third = flow.start(draft, catalog)!!
        assertEquals(first.key, third.key)
        flow.send(third)
        assertEquals(1, mac.made.size)
    }

    @Test
    fun aRefusedCreateTriesAgainAsANewRequestAndAMadeBotIsNotReplayedLater() = runTest {
        val mac = CreatingMac().apply { refuses = true }
        val flow = createFlow(mac)
        val draft = AidenBotCreateDraft(name = "Chef")
        val refusedTry = flow.start(draft, catalog)!!
        flow.send(refusedTry)
        assertEquals(sbtbiswas.AidenOnTheGo.R.string.bot_editor_create_failed, flow.failure.value?.message)
        assertFalse("a refusal is never replayed", flow.replays(draft))

        mac.refuses = false
        val made = flow.start(draft, catalog)!!
        assertFalse(made.key == refusedTry.key)
        flow.send(made)
        // Another Bot with the same answers is another Bot.
        val another = flow.start(draft, catalog)!!
        assertFalse(another.key == made.key)
    }

    // --- A New Bot cut off by a process death comes back (as iOS 9685204a9) ---

    private fun body(request: AidenBotCreateRequest) = json.encodeToString(AidenBotCreateRequest.serializer(), request)

    /** The pairing these launches' asks belong to. */
    private val paired = AidenPairingIdentity("one", "device-one", Instant.ofEpochMilli(1_000))

    /** One launch of the app: a flow whose ask waits in a session store over [root], its disk work run on [io]. */
    private fun TestScope.launchWith(
        root: java.io.File,
        mac: CreatingMac,
        io: java.util.concurrent.Executor = java.util.concurrent.Executor { it.run() },
        clock: () -> Long = { currentTime }
    ): AidenBotCreateFlow {
        val sessions = AidenBotSessionStore(root, io = io, nowMs = clock)
        return AidenBotCreateFlow(
            waitForConnection = { true },
            create = mac::create,
            cache = {},
            store = AidenBotCreateStore(
                load = { sessions.pendingCreate(paired) },
                save = { sessions.savePendingCreate(paired, it) },
                remove = { sessions.removePendingCreate(paired) }
            ),
            nowMs = clock
        )
    }

    @Test
    fun aCreateCutOffByAProcessDeathComesBackAndTryAgainReplaysTheSameKeyAndBody() = runTest {
        val root = tempFolder.newFolder("outbox")
        // The Mac makes the Bot, but the process dies before its answer comes.
        val mac = CreatingMac().apply { losesAnswer = true }
        val draft = AidenBotCreateDraft(name = "Chef", help = "Plans meals", model = aidenBotRecommendedModel(catalog))
        val before = launchWith(root, mac)
        val first = before.start(draft, catalog)!!
        val sending = launch { before.send(first) }
        runCurrent()
        sending.cancel()

        val after = launchWith(root, mac)
        after.restore()
        val failure = after.failure.value!!
        assertEquals("the answers come back", draft, failure.draft)
        assertEquals(sbtbiswas.AidenOnTheGo.R.string.bot_create_interrupted, failure.message)
        assertTrue("it may have reached the Mac, so Try again sends it again", failure.replays)

        val again = after.retry()!!
        assertEquals("the row shows again", "Chef", after.pending.value?.name)
        assertEquals("the same Idempotency-Key", first.key, again.key)
        assertEquals("the same body", body(first.request), body(again.request))
        after.send(again)
        assertEquals(listOf(first.key, first.key), mac.requests.map { it.second })
        assertEquals(1, mac.requests.map { body(it.first) }.toSet().size)
        assertEquals("one Bot, however many launches", 1, mac.made.size)

        // Made: nothing waits for the next launch.
        val later = launchWith(root, mac)
        later.restore()
        assertNull(later.failure.value)
    }

    /** The store's disk queue, run by hand: a write waits until the test lets it through. */
    private class HeldIo : java.util.concurrent.Executor {
        private val queued = ArrayDeque<Runnable>()
        override fun execute(command: Runnable) {
            queued += command
        }

        fun release() {
            while (queued.isNotEmpty()) queued.removeFirst().run()
        }
    }

    /** The ask as the disk holds it now, read by a store of its own (a relaunch would read this). */
    private suspend fun onDisk(root: java.io.File): AidenBotPendingCreate? =
        AidenBotSessionStore(root, io = { it.run() }).pendingCreate(paired)

    @Test
    fun aCreateGoesOutOnlyOnceItsRequestAndKeyAreOnDiskAndADeathAfterTheMacTookItReplaysThem() = runTest {
        val root = tempFolder.newFolder("outbox")
        val io = HeldIo()
        val mac = CreatingMac().apply { losesAnswer = true }
        val draft = AidenBotCreateDraft(name = "Chef", help = "Plans meals")
        val before = launchWith(root, mac, io = io)
        val first = before.start(draft, catalog)!!
        assertEquals("the row shows at once", "Chef", before.pending.value?.name)
        val sending = launch { before.send(first) }
        runCurrent()
        assertTrue("nothing goes out while the write waits", mac.requests.isEmpty())
        assertNull(onDisk(root))

        io.release()
        runCurrent()
        assertEquals("out once it's written", listOf(first.key), mac.requests.map { it.second })
        val kept = onDisk(root)!!
        assertEquals(first.key, kept.key)
        assertEquals(body(first.request), body(kept.request!!))

        // The Mac made the Bot; the process dies before its answer comes.
        sending.cancel()
        val io2 = HeldIo()
        val after = launchWith(root, mac, io = io2)
        val restoring = launch { after.restore() }
        runCurrent()
        io2.release()
        restoring.join()
        val again = after.retry()!!
        assertEquals("the same Idempotency-Key", first.key, again.key)
        assertEquals("the same body", body(first.request), body(again.request))
        // Try again waits for the disk too.
        val resending = launch { after.send(again) }
        runCurrent()
        assertEquals(1, mac.requests.size)
        io2.release()
        resending.join()
        assertEquals(listOf(first.key, first.key), mac.requests.map { it.second })
        assertEquals("one Bot, however many launches", 1, mac.made.size)
    }

    @Test
    fun aCreateThePhoneCouldntKeepIsNeverSentAndTryAgainReopensNewBot() = runTest {
        // A file where the store's folder should be: every write fails.
        val root = tempFolder.newFile("outbox")
        val mac = CreatingMac()
        val draft = AidenBotCreateDraft(name = "Chef")
        val flow = launchWith(root, mac)
        flow.send(flow.start(draft, catalog)!!)
        assertTrue("nothing went out", mac.requests.isEmpty())
        assertNull(flow.pending.value)
        val failure = flow.failure.value!!
        assertEquals(sbtbiswas.AidenOnTheGo.R.string.bot_create_not_kept, failure.message)
        assertEquals(draft, failure.draft)
        assertNull(flow.retry())
        assertEquals("New Bot opens as it was", draft, flow.reopening())
    }

    @Test
    fun aCutOffCreateWhoseKeyTheMacNoLongerKeepsReopensNewBotInstead() = runTest {
        val root = tempFolder.newFolder("outbox")
        val mac = CreatingMac().apply { losesAnswer = true }
        val draft = AidenBotCreateDraft(name = "Chef")
        var now = 0L
        val before = launchWith(root, mac) { now }
        val first = before.start(draft, catalog)!!
        launch { before.send(first) }.also { runCurrent() }.cancel()

        now = AidenBotSessionStore.LIFETIME_MS + 1
        val after = launchWith(root, mac) { now }
        after.restore()
        assertFalse("a day on, the same key could make a second Bot", after.failure.value!!.replays)
        assertNull(after.retry())
        assertEquals("New Bot opens as it was", draft, after.reopening())
        assertFalse(after.start(draft, catalog)!!.key == first.key)
    }

    @Test
    fun aCutOffCreateTheMacsListShowsGoesQuietlyAndOKLetsItGo() = runTest {
        val root = tempFolder.newFolder("outbox")
        val mac = CreatingMac().apply { losesAnswer = true }
        val before = launchWith(root, mac)
        val first = before.start(AidenBotCreateDraft(name = "Chef", help = "Plans meals"), catalog)!!
        launch { before.send(first) }.also { runCurrent() }.cancel()

        val after = launchWith(root, mac)
        after.restore()
        val failure = after.failure.value!!
        val made = mac.made.values.single().summary().copy(createdAt = java.time.Instant.ofEpochMilli(first.createdAtMs))
        assertFalse("another Bot isn't it", aidenBotCreateWasTaken(failure, listOf(made.copy(name = "Other"))))
        assertFalse("nor one made before it went out", aidenBotCreateWasTaken(failure, listOf(made.copy(createdAt = java.time.Instant.ofEpochMilli(first.createdAtMs - 3_600_000)))))
        assertTrue(aidenBotCreateWasTaken(failure, listOf(made)))
        after.settleTaken()
        assertNull(after.failure.value)
        assertFalse(after.replays(failure.draft))
        val later = launchWith(root, mac)
        later.restore()
        assertNull("nothing waits any more", later.failure.value)

        // OK lets a cut-off create go too.
        val other = launchWith(root, mac)
        other.start(AidenBotCreateDraft(name = "Scout"), catalog)!!
        val next = launchWith(root, mac)
        next.restore()
        next.dismissFailure()
        val last = launchWith(root, mac)
        last.restore()
        assertNull(last.failure.value)
    }

    @Test
    fun aCreateOnItsWayIsKeptPerPairingAndGoesWithAccessLossOrAnUnpair() = runTest {
        // Access lost on the create itself: nothing of it is kept.
        val root = tempFolder.newFolder("outbox")
        val mac = CreatingMac().apply { revoked = true }
        val flow = launchWith(root, mac)
        flow.send(flow.start(AidenBotCreateDraft(name = "Chef"), catalog)!!)
        val after = launchWith(root, mac)
        after.restore()
        assertNull(after.failure.value)

        // The coordinator keeps it per pairing, beside the chat outboxes, and an unpair purges it.
        val phone = pairedPhone()
        val first = phone.activePairing!!
        phone.botCreateFlow().start(AidenBotCreateDraft(name = "Chef"), catalog)!!
        assertEquals("Chef", phone.botSessionStore.pendingCreate(first)?.draft?.name)
        assertNull("another pairing has none", phone.botSessionStore.pendingCreate(first.copy(deviceId = "device-other")))
        phone.removeInstallation(phone.installationStore.installations.value.single().id)
        assertNull(phone.botSessionStore.pendingCreate(first))
        val late = phone.botSessionStore.savePendingCreate(first, AidenBotPendingCreate(AidenBotCreateDraft(name = "Late"), createdAtMs = 0))
        assertFalse(late.await())
        assertNull("never written again after the unpair", phone.botSessionStore.pendingCreate(first))

        // Pairing that Mac again is another pairing: its New Bot is kept again.
        phone.installationStore.addInstallation(pairing, null)
        phone.refreshClient()
        val again = phone.activePairing!!
        assertFalse(again == first)
        phone.botCreateFlow().start(AidenBotCreateDraft(name = "Scout"), catalog)!!
        assertEquals("Scout", phone.botSessionStore.pendingCreate(again)?.draft?.name)
    }

    @Test
    fun aNewBotKeptForOnePairingNeverComesBackOnAnotherPairingOfTheSameMac() = runTest {
        val root = tempFolder.newFolder("outbox")
        fun store() = AidenBotSessionStore(root, io = { it.run() })
        // The pairing as it was made (to the nanosecond) and as a relaunch reads it back (to the millisecond).
        val made = AidenPairingIdentity("one", "device-one", Instant.ofEpochSecond(1_000, 123_456_789))
        val relaunched = made.copy(pairedAt = Instant.ofEpochMilli(made.pairedAt.toEpochMilli()))
        assertTrue(store().savePendingCreate(made, AidenBotPendingCreate(AidenBotCreateDraft(name = "Chef"), createdAtMs = 0)).await())
        assertEquals("a relaunch reads its own pairing's ask", "Chef", store().pendingCreate(relaunched)?.draft?.name)

        // Unpaired, but its purge never landed; pairing the same Mac and device again is another pairing.
        val again = made.copy(pairedAt = made.pairedAt.plusSeconds(60))
        assertNull("the new pairing never sees the old one's ask", store().pendingCreate(again))
        assertNull("and it is gone", store().pendingCreate(made))
    }

    private val otherPairing = pairing.copy(
        instanceId = "two",
        deviceId = "device-two",
        endpoint = "https://two.test/api/aiden/v1",
        serverSpkiSha256 = "sha256/two",
        credential = "secret-two"
    )

    @Test
    fun aRestoreForOneMacThatLandsAfterASwitchToAnotherShowsNothingAndSendsNothing() = runTest {
        val io = HeldIo()
        val installations = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        val two = installations.addInstallation(otherPairing, null)
        val one = installations.addInstallation(pairing, null)
        val phone = AidenRemoteCoordinator(
            installationStore = installations,
            storageDir = tempFolder.root,
            scope = CoroutineScope(StandardTestDispatcher() + SupervisorJob()),
            botOutboxIo = io
        ).also { it.refreshClient() }
        // An earlier launch left Mac one's New Bot on its way, request and key alike.
        val draft = AidenBotCreateDraft(name = "Chef", help = "Plans meals")
        val left = AidenBotPendingCreate(draft, draft.request(catalog)!!, UUID.randomUUID(), System.currentTimeMillis())
        val seeded = phone.botSessionStore.savePendingCreate(phone.activePairing!!, left)
        io.release()
        assertTrue(seeded.await())

        val onOne = phone.botCreateFlow()
        val hostOne = phone.botSaveHost()
        assertNotNull(hostOne.client())
        val restoring = launch { onOne.restore() }
        runCurrent()
        // Its read waits on the disk while Mac two comes into use; two's client follows a moment later.
        installations.setActiveInstallation(two.id)
        assertNull("Mac two's work never gets Mac one's client", phone.botSaveHost().client())
        assertNull(hostOne.client())
        phone.refreshClient()
        io.release()
        restoring.join()

        val onTwo = phone.botCreateFlow()
        assertNotSame(onOne, onTwo)
        assertNull("nothing of Mac one's shows", onOne.failure.value)
        assertNull("Try again sends nothing", onOne.retry())
        assertNull(onOne.start(draft, catalog))
        assertNull(onOne.pending.value)
        val restoringTwo = launch { onTwo.restore() }
        runCurrent()
        io.release()
        restoringTwo.join()
        assertNull("Mac two shows none of it", onTwo.failure.value)
        assertNull(onTwo.reopening())

        // Back on Mac one, its New Bot comes back, and Try again replays its own key.
        installations.setActiveInstallation(one.id)
        phone.refreshClient()
        val back = phone.botCreateFlow()
        assertSame(onOne, back)
        val restoringOne = launch { back.restore() }
        runCurrent()
        io.release()
        restoringOne.join()
        assertEquals(draft, back.failure.value?.draft)
        assertEquals(left.key, back.retry()?.key)
    }
}
