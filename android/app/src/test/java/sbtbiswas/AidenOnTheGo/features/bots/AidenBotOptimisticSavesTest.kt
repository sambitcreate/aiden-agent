package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.IOException
import java.util.UUID

/** R15: Bot edits on the phone apply at once, wait for the connection on their own, and roll back on failure. */
@OptIn(ExperimentalCoroutinesApi::class)
class AidenBotOptimisticSavesTest {
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
        val shown = mutableListOf<AidenBotDetail>()
        val settled = mutableListOf<AidenBotDetail>()
        val failures = mutableListOf<AidenBotChatActivityFailure>()
        val host = AidenBotSaveHost(
            client = { null },
            waitForConnection = { false },
            launch = { block -> launch { block() } },
            cache = { cache[it.id] = it },
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
        val attempts = AidenBotCreateAttempts { keys.removeFirst() }
        val draft = AidenBotCreateDraft(name = "Chef", help = "Plans meals")
        val first = attempts.begin(draft, catalog)!!
        attempts.failed(first, AidenBotChatActivityTimeout())
        assertTrue(attempts.replays(draft))
        assertEquals("the Mac may have made it", first.key, attempts.begin(draft, catalog)!!.key)
    }
}
