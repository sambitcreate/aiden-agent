package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
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
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class AidenBotChatActivityTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private val json = AidenBotWireJson.json
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json"))
            .bufferedReader().use { it.readText() }
        json.parseToJsonElement(text).jsonObject
    }
    private val bot by lazy { json.decodeFromJsonElement(AidenBotDetail.serializer(), fixture.getValue("botDetail")) }

    private fun choice(level: AidenBotChatActivityLevel, wording: AidenBotChatActivityWording = AidenBotChatActivityWording.FOLLOWS) =
        AidenBotChatActivity(level, wording)

    private val quiet = AidenBotChatActivity.DEFAULT
    private val summary = choice(AidenBotChatActivityLevel.SUMMARY)
    private val detailed = choice(AidenBotChatActivityLevel.DETAILED)
    private val summaryThinking = choice(AidenBotChatActivityLevel.SUMMARY, AidenBotChatActivityWording.THINKING)

    private fun detail(revision: String, activity: AidenBotChatActivity?) = bot.copy(revision = revision, chatActivity = activity)

    /** A save the test settles by hand, so it can look at the page while the request is in flight. */
    private class Call(val next: AidenBotChatActivity, val revision: String) {
        val result = CompletableDeferred<AidenBotDetail>()
    }

    private inner class Harness(
        initial: AidenBotDetail = detail("rev_1", null),
        refresh: (suspend () -> AidenBotDetail)? = null,
        waitForConnection: (suspend () -> Boolean)? = null
    ) {
        val calls = mutableListOf<Call>()
        val savedRevisions = mutableListOf<String>()
        val controller = AidenBotChatActivityController(
            initial,
            save = { next, revision -> Call(next, revision).also { calls += it }.result.await() },
            refresh = refresh,
            onSaved = { savedRevisions += it.revision },
            waitForConnection = waitForConnection
        )
        val state get() = controller.state.value
    }

    private fun TestScope.pick(controller: AidenBotChatActivityController, next: AidenBotChatActivity): Job =
        launch { controller.pick(next) }

    private fun server409() = AidenRemoteClientException.Server(
        409,
        AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.REVISION_CONFLICT, "The Bot changed.", "req_1", false)
    )

    // Picks apply at once and save in the background.
    @Test
    fun aPickShowsAtOnceAndSavesOnTheBotsRevision() = runTest {
        val h = Harness()
        assertEquals(quiet, h.state.value)
        pick(h.controller, summary)
        runCurrent()
        assertEquals("the page shows the pick while the Mac hasn't answered", summary, h.state.value)
        assertEquals("the saved choice is still the Mac's", quiet, h.state.saved)
        assertTrue(h.state.isSaving)
        assertEquals(listOf("rev_1"), h.calls.map { it.revision })

        h.calls[0].result.complete(detail("rev_2", summary))
        advanceUntilIdle()
        assertEquals(summary, h.state.saved)
        assertEquals("rev_2", h.state.revision)
        assertFalse(h.state.isSaving)
        assertEquals(listOf("rev_2"), h.savedRevisions)

        h.controller.pick(summary)
        assertEquals("the current choice sends nothing", 1, h.calls.size)
    }

    // Taps during a save coalesce: the latest goes out on the revision the first save returned.
    @Test
    fun tapsDuringASaveCoalesceAndTheLatestGoesOutOnTheReturnedRevision() = runTest {
        val h = Harness()
        pick(h.controller, summary)
        runCurrent()
        pick(h.controller, detailed)
        pick(h.controller, summaryThinking)
        runCurrent()
        assertEquals("each tap shows at once", summaryThinking, h.state.value)
        assertEquals("only the first request is out", 1, h.calls.size)

        h.calls[0].result.complete(detail("rev_2", summary))
        runCurrent()
        assertEquals(listOf(summary, summaryThinking), h.calls.map { it.next })
        assertEquals("the follow-up uses the revision the first save returned", listOf("rev_1", "rev_2"), h.calls.map { it.revision })
        assertEquals("the pick still shows while it is out", summaryThinking, h.state.value)

        h.calls[1].result.complete(detail("rev_3", summaryThinking))
        advanceUntilIdle()
        assertEquals(summaryThinking, h.state.saved)
        assertEquals(summaryThinking, h.state.value)
        assertEquals(listOf("rev_2", "rev_3"), h.savedRevisions)
        assertFalse(h.state.isSaving)
    }

    // Picking back to the saved value mid-flight: the Mac must end on it too.
    @Test
    fun pickingBackToTheSavedValueMidFlightLeavesTheMacOnIt() = runTest {
        val h = Harness()
        pick(h.controller, detailed)
        runCurrent()
        pick(h.controller, quiet)
        runCurrent()
        assertEquals(quiet, h.state.value)

        h.calls[0].result.complete(detail("rev_2", detailed))
        runCurrent()
        assertEquals("the Mac took the first pick, so the pick back must be sent", listOf(detailed, quiet), h.calls.map { it.next })
        h.calls[1].result.complete(detail("rev_3", quiet))
        advanceUntilIdle()
        assertEquals(quiet, h.state.saved)
        assertEquals(quiet, h.state.value)
    }

    @Test
    fun pickingBackAndForthToTheInFlightValueSendsNothingExtra() = runTest {
        val h = Harness()
        pick(h.controller, detailed)
        runCurrent()
        pick(h.controller, quiet)
        pick(h.controller, detailed)
        runCurrent()
        h.calls[0].result.complete(detail("rev_2", detailed))
        advanceUntilIdle()
        assertEquals("the Mac already holds the last pick", 1, h.calls.size)
        assertEquals(detailed, h.state.value)
        assertEquals(detailed, h.state.saved)
        assertFalse(h.state.isSaving)
    }

    // A failed save returns to the saved choice and leaves the revision where it was.
    @Test
    fun aFailedSaveReturnsToTheSavedChoiceAndSaysSo() = runTest {
        val h = Harness()
        pick(h.controller, detailed)
        runCurrent()
        h.calls[0].result.completeExceptionally(IOException("offline"))
        advanceUntilIdle()
        assertEquals(quiet, h.state.value)
        assertTrue(h.state.saveFailed)
        assertFalse(h.state.isSaving)
        assertEquals("rev_1", h.state.revision)
        assertEquals("a failed save tells nobody the Bot changed", emptyList<String>(), h.savedRevisions)

        pick(h.controller, detailed)
        runCurrent()
        assertFalse("the next pick clears the error", h.state.saveFailed)
        assertEquals("a failed save leaves the revision where it was", listOf("rev_1", "rev_1"), h.calls.map { it.revision })
        h.calls[1].result.complete(detail("rev_2", detailed))
        advanceUntilIdle()
        assertEquals(detailed, h.state.value)
    }

    @Test
    fun aFailureDropsTheTapsQueuedBehindItAndShowsTheSavedChoice() = runTest {
        val h = Harness()
        pick(h.controller, summary)
        runCurrent()
        pick(h.controller, detailed)
        runCurrent()
        h.calls[0].result.completeExceptionally(IOException("offline"))
        advanceUntilIdle()
        assertEquals("nothing queued behind a failure is sent", 1, h.calls.size)
        assertEquals(quiet, h.state.value)
        assertTrue(h.state.saveFailed)

        h.controller.dismissError()
        assertFalse(h.state.saveFailed)
    }

    // A stale revision refreshes the Bot, adopts the Mac's choice and reports the error once.
    @Test
    fun aRevisionConflictAdoptsTheMacsChoiceAndRollsBackToIt() = runTest {
        val fresh = detail("rev_9", summaryThinking)
        val h = Harness(refresh = { fresh })
        pick(h.controller, detailed)
        runCurrent()
        h.calls[0].result.completeExceptionally(server409())
        advanceUntilIdle()

        assertEquals("the radio shows what the Mac holds", summaryThinking, h.state.value)
        assertEquals(summaryThinking, h.state.saved)
        assertEquals("rev_9", h.state.revision)
        assertTrue("the person is told once", h.state.saveFailed)
        assertEquals("the screens behind hear about the fresh Bot", listOf("rev_9"), h.savedRevisions)

        h.controller.dismissError()
        pick(h.controller, detailed)
        runCurrent()
        assertEquals("the next pick can save", "rev_9", h.calls[1].revision)
        assertFalse(h.state.saveFailed)
    }

    @Test
    fun aConflictWhoseRefreshAlsoFailsStillRollsBack() = runTest {
        val h = Harness(refresh = { throw IOException("offline") })
        pick(h.controller, detailed)
        runCurrent()
        h.calls[0].result.completeExceptionally(server409())
        advanceUntilIdle()
        assertEquals(quiet, h.state.value)
        assertTrue(h.state.saveFailed)
        assertEquals("rev_1", h.state.revision)
        assertEquals(emptyList<String>(), h.savedRevisions)
    }

    // While connecting, a pick is held for a while, then sent or rolled back.
    @Test
    fun aPickMadeWhileConnectingIsHeldThenSentOnceTheMacIsUp() = runTest {
        val connected = CompletableDeferred<Boolean>()
        val h = Harness(waitForConnection = { connected.await() })
        pick(h.controller, summary)
        runCurrent()
        pick(h.controller, detailed)
        runCurrent()
        assertEquals("shown at once", detailed, h.state.value)
        assertTrue(h.state.isSaving)
        assertEquals("nothing is sent before the Mac is up", 0, h.calls.size)

        advanceTimeBy(AidenBotChatActivityController.CONNECTION_HOLD_MILLIS - 100)
        runCurrent()
        connected.complete(true)
        runCurrent()
        assertEquals(listOf(summary), h.calls.map { it.next })
        h.calls[0].result.complete(detail("rev_2", summary))
        runCurrent()
        assertEquals("the tap made during the hold goes out after it", listOf(summary, detailed), h.calls.map { it.next })
        h.calls[1].result.complete(detail("rev_3", detailed))
        advanceUntilIdle()
        assertEquals(detailed, h.state.saved)
    }

    @Test
    fun aPickHeldPastTheLimitRollsBackWithoutSending() = runTest {
        val h = Harness(waitForConnection = { awaitCancellation() })
        pick(h.controller, summary)
        runCurrent()
        advanceTimeBy(AidenBotChatActivityController.CONNECTION_HOLD_MILLIS - 1)
        runCurrent()
        assertEquals("still held", summary, h.state.value)
        assertTrue(h.state.isSaving)

        advanceTimeBy(2)
        runCurrent()
        assertEquals(0, h.calls.size)
        assertEquals(quiet, h.state.value)
        assertTrue(h.state.saveFailed)
        assertFalse(h.state.isSaving)
    }

    @Test
    fun noMacPairedRollsBackAtOnce() = runTest {
        val h = Harness(waitForConnection = { false })
        pick(h.controller, summary)
        runCurrent()
        assertEquals(0, h.calls.size)
        assertEquals(quiet, h.state.value)
        assertTrue(h.state.saveFailed)
    }

    // A request that never answers is bounded, so the page can't hang on a dead link.
    @Test
    fun aRequestThatNeverAnswersRollsBackAndTheNextPickKeepsTheRevision() = runTest {
        val h = Harness()
        pick(h.controller, summary)
        runCurrent()
        advanceTimeBy(AidenBotChatActivityController.REQUEST_LIMIT_MILLIS - 1)
        runCurrent()
        assertTrue(h.state.isSaving)
        assertEquals(summary, h.state.value)

        advanceTimeBy(2)
        runCurrent()
        assertEquals(quiet, h.state.value)
        assertTrue(h.state.saveFailed)
        assertFalse(h.state.isSaving)

        pick(h.controller, detailed)
        runCurrent()
        assertEquals("the same revision", listOf("rev_1", "rev_1"), h.calls.map { it.revision })
    }

    // A save the Mac took is reported even if the caller left meanwhile: the screens behind must hear.
    @Test
    fun aSaveConfirmedAfterTheCallerLeavesStillReports() = runTest {
        val h = Harness()
        val job = pick(h.controller, summary)
        runCurrent()
        job.cancel()
        runCurrent()
        h.calls[0].result.complete(detail("rev_2", summary))
        advanceUntilIdle()
        assertEquals(listOf("rev_2"), h.savedRevisions)
        assertEquals(summary, h.state.saved)
        assertEquals("rev_2", h.state.revision)
        assertEquals("the page shows what the Mac holds", summary, h.state.value)
        assertFalse(h.state.isSaving)
        assertFalse("leaving is not a failure to report", h.state.saveFailed)
    }

    @Test
    fun leavingStopsThePicksQueuedBehindTheSaveThatIsOut() = runTest {
        val h = Harness()
        val job = pick(h.controller, summary)
        runCurrent()
        pick(h.controller, detailed)
        runCurrent()
        job.cancel()
        runCurrent()
        h.calls[0].result.complete(detail("rev_2", summary))
        advanceUntilIdle()
        assertEquals("the queued pick is not sent for someone who left", 1, h.calls.size)
        assertEquals(listOf("rev_2"), h.savedRevisions)
        assertEquals(summary, h.state.value)
        assertEquals(summary, h.state.saved)
        assertFalse(h.state.isSaving)
    }

    // A Mac that applies the pick and then answers too late: the radio ends on the applied value.
    @Test
    fun aSaveThatLandedButTimedOutShowsAsSaved() = runTest {
        val h = Harness(refresh = { detail("rev_2", summary) })
        pick(h.controller, summary)
        runCurrent()
        advanceTimeBy(AidenBotChatActivityController.REQUEST_LIMIT_MILLIS + 1)
        advanceUntilIdle()
        assertEquals(summary, h.state.value)
        assertEquals(summary, h.state.saved)
        assertEquals("rev_2", h.state.revision)
        assertFalse("the Mac has the pick, so there is nothing to apologise for", h.state.saveFailed)
        assertEquals(listOf("rev_2"), h.savedRevisions)
        assertFalse(h.state.isSaving)
    }

    @Test
    fun aTimeoutWhereTheMacHoldsSomethingElseShowsWhatItHoldsAndSaysItChanged() = runTest {
        val h = Harness(refresh = { detail("rev_5", summaryThinking) })
        pick(h.controller, detailed)
        runCurrent()
        advanceTimeBy(AidenBotChatActivityController.REQUEST_LIMIT_MILLIS + 1)
        advanceUntilIdle()
        assertEquals(summaryThinking, h.state.value)
        assertEquals("rev_5", h.state.revision)
        assertEquals(AidenBotChatActivityFailure.CONFLICT, h.state.saveFailure)
    }

    @Test
    fun aTimeoutWhereTheMacNeverTookThePickSaysOffline() = runTest {
        val h = Harness(refresh = { detail("rev_1", null) })
        pick(h.controller, detailed)
        runCurrent()
        advanceTimeBy(AidenBotChatActivityController.REQUEST_LIMIT_MILLIS + 1)
        advanceUntilIdle()
        assertEquals(quiet, h.state.value)
        assertEquals(AidenBotChatActivityFailure.OFFLINE, h.state.saveFailure)
    }

    @Test
    fun aTransportFailureAlsoLooksForALateSuccess() = runTest {
        val h = Harness(refresh = { detail("rev_2", detailed) })
        pick(h.controller, detailed)
        runCurrent()
        h.calls[0].result.completeExceptionally(IOException("connection reset"))
        advanceUntilIdle()
        assertEquals(detailed, h.state.value)
        assertEquals(detailed, h.state.saved)
        assertFalse(h.state.saveFailed)
    }

    @Test
    fun aMacThatNeverReceivedThePickIsNotAskedWhatItHolds() = runTest {
        var refreshed = false
        val h = Harness(refresh = { refreshed = true; detail("rev_2", detailed) }, waitForConnection = { false })
        pick(h.controller, detailed)
        runCurrent()
        assertFalse(refreshed)
        assertEquals(quiet, h.state.value)
    }

    @Test
    fun theFailureSaysWhetherTheMacRefusedWasUnreachableOrChanged() = runTest {
        suspend fun failureOf(error: Exception): AidenBotChatActivityFailure? {
            val controller = AidenBotChatActivityController(detail("rev_1", null), save = { _, _ -> throw error })
            controller.pick(detailed)
            return controller.state.value.saveFailure
        }
        assertEquals(AidenBotChatActivityFailure.OFFLINE, failureOf(IOException("offline")))
        assertEquals(AidenBotChatActivityFailure.OFFLINE, failureOf(AidenRemoteClientException.Disconnected()))
        assertEquals(AidenBotChatActivityFailure.CONFLICT, failureOf(server409()))
        assertEquals(
            AidenBotChatActivityFailure.GENERIC,
            failureOf(AidenRemoteClientException.Server(404, AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.NOT_FOUND, "Gone", "req_2", false)))
        )
    }

    // The Mac is the authority on what was saved.
    @Test
    fun theMacsAnswerWinsOverWhatWasPicked() = runTest {
        val h = Harness()
        pick(h.controller, detailed)
        runCurrent()
        h.calls[0].result.complete(detail("rev_2", summary))
        advanceUntilIdle()
        assertEquals(summary, h.state.saved)
        assertEquals("the radio settles on what the Mac kept", summary, h.state.value)
    }

    @Test
    fun anAnswerWithNoChoiceMeansThePickWasTaken() = runTest {
        val h = Harness()
        pick(h.controller, detailed)
        runCurrent()
        h.calls[0].result.complete(detail("rev_2", null))
        advanceUntilIdle()
        assertEquals(detailed, h.state.saved)
        assertEquals(detailed, h.state.value)
    }

    @Test
    fun aRefreshWithNoChoiceMeansTheDefault() = runTest {
        val h = Harness(initial = detail("rev_1", detailed), refresh = { detail("rev_9", null) })
        assertEquals(detailed, h.state.value)
        pick(h.controller, summary)
        runCurrent()
        h.calls[0].result.completeExceptionally(server409())
        advanceUntilIdle()
        assertEquals(quiet, h.state.saved)
        assertEquals(quiet, h.state.value)
        assertEquals("rev_9", h.state.revision)
    }

    // The connection is checked before every send, not just the first.
    @Test
    fun theHoldAppliesToTheFollowUpSendToo() = runTest {
        var waits = 0
        val h = Harness(waitForConnection = { waits += 1; waits == 1 })
        pick(h.controller, summary)
        runCurrent()
        pick(h.controller, detailed)
        runCurrent()
        h.calls[0].result.complete(detail("rev_2", summary))
        advanceUntilIdle()
        assertEquals(2, waits)
        assertEquals("the follow-up never went out", 1, h.calls.size)
        assertEquals("it rolls back to what the Mac confirmed", summary, h.state.value)
        assertEquals(AidenBotChatActivityFailure.OFFLINE, h.state.saveFailure)
    }

    // The client-bound controller patches with the chat activity opt-in, on the revision it was given.
    @Test
    fun theClientBoundControllerSendsTheChoiceAsAnIdentityPatch() = runBlocking {
        val patched = fixture.getValue("botActivity").jsonObject.getValue("identityPatch").jsonObject
        val server = MockWebServer()
        server.start()
        try {
            val client = AidenRemoteClient(
                endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
                credential = "test_credential_123",
                customOkHttpClient = OkHttpClient()
            )
            val saved = mutableListOf<AidenBotDetail>()
            val controller = aidenBotChatActivityController(bot.copy(revision = "bot_revision_8"), client = { client }, onSaved = { saved += it })
            server.enqueue(MockResponse().setResponseCode(200).setBody(patched.getValue("response").toString()))

            controller.pick(detailed)

            val request = server.takeRequest()
            assertEquals("PATCH", request.method)
            assertEquals("bot_revision_8", request.getHeader("If-Match"))
            assertEquals(patched.getValue("request"), json.parseToJsonElement(request.body.readUtf8()))
            assertEquals(detailed, controller.state.value.saved)
            assertEquals("bot_revision_9", controller.state.value.revision)
            assertEquals(1, saved.size)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun withoutAClientThePickRollsBackWithTheError() = runTest {
        val controller = aidenBotChatActivityController(bot, client = { null })
        controller.pick(detailed)
        assertEquals(quiet, controller.state.value.value)
        assertTrue(controller.state.value.saveFailed)
    }

    // The screens behind Advanced hear about picks once, when it closes; a late pick is reported at once.
    @Test
    fun theScreensBehindHearOnceWithTheNewestBotWhenAdvancedCloses() {
        val heard = mutableListOf<String>()
        val reporter = AidenBotChatActivityReporter { heard += it.revision }
        reporter.saved(detail("rev_2", summary))
        reporter.saved(detail("rev_3", detailed))
        assertEquals("nothing is reported while Advanced is open", emptyList<String>(), heard)
        reporter.close()
        reporter.close()
        assertEquals(listOf("rev_3"), heard)
    }

    @Test
    fun aPickThatFinishesAfterAdvancedClosedIsReportedAtOnce() {
        val heard = mutableListOf<String>()
        val reporter = AidenBotChatActivityReporter { heard += it.revision }
        reporter.close()
        assertEquals("no pick, nothing to report", emptyList<String>(), heard)
        reporter.saved(detail("rev_4", summary))
        assertEquals(listOf("rev_4"), heard)
    }

    @Test
    fun advancedsOwnSaveSettlesThePicksItAlreadyCarries() {
        val heard = mutableListOf<String>()
        val reporter = AidenBotChatActivityReporter { heard += it.revision }
        reporter.saved(detail("rev_2", summary))
        reporter.settle()
        reporter.close()
        assertEquals(emptyList<String>(), heard)
        reporter.saved(detail("rev_3", detailed))
        assertEquals("a later pick still reaches them", listOf("rev_3"), heard)
    }

    // The page waits for the Mac without blocking; it gives up only when there is no Mac to wait for.
    @Test
    fun theHoldEndsWhenTheMacIsUpAndKeepsWaitingThroughOffline() = runTest {
        val connection = MutableStateFlow(AidenConnectionState.CONNECTING)
        val client = MutableStateFlow<String?>(null)
        val result = async { aidenBotAwaitConnected(connection, client) }
        runCurrent()
        assertFalse(result.isCompleted)
        connection.value = AidenConnectionState.OFFLINE
        runCurrent()
        assertFalse(result.isCompleted)
        connection.value = AidenConnectionState.CONNECTED
        runCurrent()
        assertFalse("connected without a client is not yet usable", result.isCompleted)
        client.value = "client"
        runCurrent()
        assertTrue(result.await())
    }

    @Test
    fun theHoldGivesUpAtOnceWhenThePhoneNeedsPairing() = runTest {
        val connection = MutableStateFlow(AidenConnectionState.NEEDS_PAIRING)
        assertFalse(aidenBotAwaitConnected(connection, MutableStateFlow<String?>("stale client")))
    }

    // A pick is cached for the screens behind as soon as the Mac confirms it.
    @Test
    fun aConfirmedPickIsCachedAndReported() = runBlocking {
        val patched = fixture.getValue("botActivity").jsonObject.getValue("identityPatch").jsonObject
        val server = MockWebServer()
        server.start()
        try {
            val client = AidenRemoteClient(
                endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
                credential = "test_credential_123",
                customOkHttpClient = OkHttpClient()
            )
            val cached = mutableListOf<AidenBotDetail>()
            val host = AidenBotChatActivityHost(client = { client }, waitForConnection = { true }, launch = { }, cache = { cached += it })
            val reported = mutableListOf<AidenBotDetail>()
            server.enqueue(MockResponse().setResponseCode(200).setBody(patched.getValue("response").toString()))

            host.controller(bot.copy(revision = "bot_revision_8")) { reported += it }.pick(detailed)

            assertEquals(listOf("bot_revision_9"), cached.map { it.revision })
            assertEquals(cached, reported)
        } finally {
            server.shutdown()
        }
    }

    // --- The pairing pin (coordinator level) ---

    private fun exchange(instance: String, capabilities: List<AidenRemoteCapability> = listOf(AidenRemoteCapability.CHAT_READ)) =
        AidenPairingExchange(
            instanceId = instance,
            deviceId = "device-$instance",
            endpoint = "https://$instance.test/api/aiden/v1",
            serverSpkiSha256 = "sha256/$instance",
            credential = "secret-$instance",
            capabilities = capabilities
        )

    /** A coordinator whose scope never runs anything, so no request ever leaves. */
    private fun coordinatorFor(installations: AidenInstallationStore) = AidenRemoteCoordinator(
        installationStore = installations,
        storageDir = tempFolder.root,
        scope = CoroutineScope(StandardTestDispatcher() + SupervisorJob())
    )

    @Test
    fun aHostGoesQuietOnceItsPairingChanges() = runBlocking {
        val installations = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        installations.addInstallation(exchange("one"), null)
        val coordinator = coordinatorFor(installations)
        coordinator.refreshClient()
        val host = coordinator.botChatActivityHost()
        assertSame("one host per pairing", host, coordinator.botChatActivityHost())
        assertNotNull(host.client())
        host.cache(bot)
        assertEquals("the pairing's own pick is cached", bot, coordinator.botCache.getBotDetail(bot.id))

        installations.addInstallation(exchange("two"), null)
        coordinator.refreshClient()

        assertNull("no client for the old Mac", host.client())
        assertFalse(host.waitForConnection())
        host.cache(bot.copy(revision = "late_pick"))
        assertNull("the old Mac's Bot never reaches the new pairing's cache", coordinator.botCache.getBotDetail(bot.id))
        assertNotSame(host, coordinator.botChatActivityHost())

        val reported = mutableListOf<AidenBotDetail>()
        val controller = host.controller(bot) { reported += it }
        controller.pick(detailed)
        assertEquals("nothing was sent, so nothing was saved", quiet, controller.state.value.saved)
        assertEquals(quiet, controller.state.value.value)
        assertEquals(AidenBotChatActivityFailure.OFFLINE, controller.state.value.saveFailure)
        assertEquals(emptyList<AidenBotDetail>(), reported)
    }

    @Test
    fun detachedWorkStopsWhenItsPairingChangesOrIsRemoved() {
        val installations = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        installations.addInstallation(exchange("one"), null)
        val coordinator = coordinatorFor(installations)
        coordinator.refreshClient()
        val first = coordinator.launchDetached { awaitCancellation() }
        coordinator.refreshClient()
        assertTrue("reconnecting the same pairing keeps a pick going", first.isActive)

        installations.addInstallation(exchange("two"), null)
        val second = coordinator.launchDetached { awaitCancellation() }
        coordinator.refreshClient()
        assertTrue("another pairing is now active", first.isCancelled)
        assertTrue("work for the active pairing carries on", second.isActive)

        coordinator.removeInstallation("two")
        assertTrue(second.isCancelled)
    }

    @Test
    fun theCachedGrantIsTheNegotiatedOneForThePairingInUse() {
        val installations = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        val coordinator = coordinatorFor(installations)
        installations.addInstallation(
            exchange("one", listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_ACTIVITY)),
            null
        )
        assertTrue(coordinator.cachedBotActivityGrant)
        installations.addInstallation(exchange("two"), null)
        assertFalse("the active pairing never held it", coordinator.cachedBotActivityGrant)
    }

    // One writer per Bot: a sheet reopened while a pick is still saving gets the same controller.
    @Test
    fun aSheetReopenedMidSaveReusesTheControllerAndTheNewestSheetHearsTheResult() = runBlocking {
        val patched = fixture.getValue("botActivity").jsonObject.getValue("identityPatch").jsonObject
        val server = MockWebServer()
        server.start()
        try {
            val client = AidenRemoteClient(
                endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
                credential = "test_credential_123",
                customOkHttpClient = OkHttpClient()
            )
            server.enqueue(MockResponse().setResponseCode(200).setBody(patched.getValue("response").toString()))
            val connected = CompletableDeferred<Boolean>()
            val host = AidenBotChatActivityHost(client = { client }, waitForConnection = { connected.await() }, launch = { }, cache = { })
            val oldSheet = mutableListOf<String>()
            val newSheet = mutableListOf<String>()
            val first = host.controller(bot.copy(revision = "bot_revision_8")) { oldSheet += it.revision }
            val saving = async(Dispatchers.Unconfined) { first.pick(detailed) }
            assertTrue(first.state.value.isSaving)

            val second = host.controller(bot.copy(revision = "stale")) { newSheet += it.revision }
            assertSame("no second writer on a stale revision", first, second)

            connected.complete(true)
            saving.await()
            assertEquals(emptyList<String>(), oldSheet)
            assertEquals(listOf("bot_revision_9"), newSheet)
            assertNotSame("once it has settled a fresh sheet gets a fresh controller", first, host.controller(bot) { })
        } finally {
            server.shutdown()
        }
    }

    // Advanced offers the page only to a phone that can use it.
    @Test
    fun theRowNeedsTheMacsFeatureTheGrantAndABot() {
        fun mac(features: List<String>, capabilities: List<AidenRemoteCapability>) =
            AidenServer(instanceId = "inst", name = "Mac", capabilities = capabilities, features = features)
        val feature = listOf(AidenRemoteProtocol.BOT_ACTIVITY_FEATURE)
        val grant = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_ACTIVITY)
        assertTrue(aidenBotShowsChatActivity(mac(feature, grant), hasBaseline = true))
        assertFalse("no Bot detail on screen yet", aidenBotShowsChatActivity(mac(feature, grant), hasBaseline = false))
        assertFalse("an older Mac", aidenBotShowsChatActivity(mac(emptyList(), grant), hasBaseline = true))
        assertFalse("no grant", aidenBotShowsChatActivity(mac(feature, listOf(AidenRemoteCapability.CHAT_READ)), hasBaseline = true))
        assertFalse("no Mac", aidenBotShowsChatActivity(null, hasBaseline = true))
    }

    // A cold offline start has no /server answer yet: the persisted grant stands in until it comes.
    @Test
    fun theRowSurvivesAColdOfflineStartOnThePersistedGrant() {
        fun mac(features: List<String>, capabilities: List<AidenRemoteCapability>) =
            AidenServer(instanceId = "inst", name = "Mac", capabilities = capabilities, features = features)
        assertTrue(aidenBotShowsChatActivity(null, hasBaseline = true, cachedGrant = true))
        assertFalse("never granted", aidenBotShowsChatActivity(null, hasBaseline = true, cachedGrant = false))
        assertFalse("still needs a Bot on screen", aidenBotShowsChatActivity(null, hasBaseline = false, cachedGrant = true))
        assertFalse(
            "once the Mac answers it decides, whatever was cached",
            aidenBotShowsChatActivity(mac(emptyList(), listOf(AidenRemoteCapability.CHAT_READ)), hasBaseline = true, cachedGrant = true)
        )
        assertTrue(aidenBotActivitySupported(null, cachedGrant = true))
        assertFalse(aidenBotActivitySupported(null, cachedGrant = false))
    }

    // Previews: what each level shows on the Mac.
    private val levels = AidenBotChatActivityLevel.entries
    private val all = AidenBotChatActivityPreview.FRAME_MILLIS.indices

    @Test
    fun quietShowsOnlyTheLineAndNeverStepsOrARecap() {
        for (index in all) {
            val frame = AidenBotChatActivityPreview.frame(index, AidenBotChatActivityLevel.QUIET)
            assertEquals(emptyList<Int>(), frame.steps)
            assertNull(frame.running)
            assertFalse(frame.recapShown)
        }
    }

    @Test
    fun summaryAddsARecapAboveTheReplyOnly() {
        val reply = AidenBotChatActivityPreview.REPLY_FRAME
        for (index in all) {
            val frame = AidenBotChatActivityPreview.frame(index, AidenBotChatActivityLevel.SUMMARY)
            assertEquals("the recap folds the steps away", emptyList<Int>(), frame.steps)
            assertNull(frame.running)
            assertEquals("the recap comes with the reply", index == reply, frame.recapShown)
            assertFalse("it starts folded", frame.recapOpen)
        }
    }

    @Test
    fun detailedListsFinishedStepsAndShowsTheRunningOne() {
        val preview = AidenBotChatActivityPreview
        val thinking = preview.frame(0, AidenBotChatActivityLevel.DETAILED)
        assertNull("nothing has started yet", thinking.running)
        assertEquals(emptyList<Int>(), thinking.steps)

        for (index in 1 until preview.REPLY_FRAME) {
            val frame = preview.frame(index, AidenBotChatActivityLevel.DETAILED)
            val running = frame.running
            assertTrue("frame $index shows its running step", running != null)
            assertEquals("one more step has finished each frame", index - 1, frame.steps.size)
            assertFalse("a running step is not also listed as finished", frame.steps.contains(running))
            assertFalse(frame.recapShown)
        }

        val reply = preview.frame(preview.REPLY_FRAME, AidenBotChatActivityLevel.DETAILED)
        assertNull("the reply has landed", reply.phase)
        assertNull(reply.running)
        assertEquals(3, reply.steps.size)
        assertTrue(reply.recapShown)
        assertTrue("Detailed's recap is open", reply.recapOpen)
    }

    @Test
    fun theLineFollowsTheTurnAtEveryLevelAndEndsOnTheReply() {
        for (level in levels) {
            val phases = all.map { AidenBotChatActivityPreview.frame(it, level).phase }
            assertEquals("the line runs while it works and is gone once the reply lands", listOf(true, true, true, true, false), phases.map { it != null })
            assertEquals("the line tells the same story at every level", all.map { AidenBotChatActivityPreview.frame(it, AidenBotChatActivityLevel.QUIET).phase }, phases)
        }
    }

    @Test
    fun theTurnLoopsOnTheSharedClock() {
        val preview = AidenBotChatActivityPreview
        val total = preview.FRAME_MILLIS.sum()
        var start = 0L
        preview.FRAME_MILLIS.forEachIndexed { index, duration ->
            assertEquals("frame $index begins on time", index, preview.frameIndex(start))
            assertEquals("frame $index lasts its whole time", index, preview.frameIndex(start + duration - 1))
            start += duration
        }
        assertEquals("the turn loops", 0, preview.frameIndex(total))
        assertEquals(preview.REPLY_FRAME, preview.frameIndex(total - 1))
        assertEquals("a clock behind zero still lands on a frame", preview.REPLY_FRAME, preview.frameIndex(-1))
        assertEquals("every loop is the same", preview.frameIndex(1_500), preview.frameIndex(1_500 + 3 * total))
    }

    @Test
    fun reduceMotionHoldsAStillFrameThatShowsWhatTheLevelAdds() {
        val preview = AidenBotChatActivityPreview
        val stills = levels.associateWith { preview.stillFrame(it) }
        val quiet = preview.frame(stills.getValue(AidenBotChatActivityLevel.QUIET), AidenBotChatActivityLevel.QUIET)
        assertTrue("Quiet holds the line mid-turn", quiet.phase != null)

        val summary = preview.frame(stills.getValue(AidenBotChatActivityLevel.SUMMARY), AidenBotChatActivityLevel.SUMMARY)
        assertNull("Summary holds the reply", summary.phase)
        assertTrue("with its recap", summary.recapShown)

        val detailed = preview.frame(stills.getValue(AidenBotChatActivityLevel.DETAILED), AidenBotChatActivityLevel.DETAILED)
        assertTrue("Detailed holds the line mid-turn", detailed.phase != null)
        assertTrue("with a finished step and the running one", detailed.steps.isNotEmpty() && detailed.running != null)

        assertEquals("the stills tell the three levels apart", 3, setOf(quiet, summary, detailed).size)
    }

    @Test
    fun aPreviewMovesOnlyWhileInFrontOnScreenAndAllowedToMove() {
        val preview = AidenBotChatActivityPreview
        assertTrue(preview.plays(reduceMotion = false, resumed = true, onScreen = true))
        assertFalse("Reduce Motion", preview.plays(reduceMotion = true, resumed = true, onScreen = true))
        assertFalse("app in the background", preview.plays(reduceMotion = false, resumed = false, onScreen = true))
        assertFalse("scrolled out of view", preview.plays(reduceMotion = false, resumed = true, onScreen = false))
    }

    @Test
    fun whatAPreviewShowsFollowsTheClockOnlyWhilePlaying() {
        val preview = AidenBotChatActivityPreview
        val level = AidenBotChatActivityLevel.DETAILED
        val clockAtThirdFrame = preview.FRAME_MILLIS[0] + preview.FRAME_MILLIS[1] + 1
        assertEquals(2, preview.shownFrame(level, reduceMotion = false, playing = true, current = 0, nowMs = clockAtThirdFrame))
        assertEquals("paused keeps the frame it had", 4, preview.shownFrame(level, reduceMotion = false, playing = false, current = 4, nowMs = clockAtThirdFrame))
        for (level in levels) {
            assertEquals(
                "Reduce Motion ignores the clock",
                preview.stillFrame(level),
                preview.shownFrame(level, reduceMotion = true, playing = false, current = 0, nowMs = clockAtThirdFrame + preview.FRAME_MILLIS[2] + 5)
            )
        }
    }
}
