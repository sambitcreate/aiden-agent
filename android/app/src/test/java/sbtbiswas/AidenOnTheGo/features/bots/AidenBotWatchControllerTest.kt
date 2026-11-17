package sbtbiswas.AidenOnTheGo.features.bots

import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.*
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.*
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournalStore
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournal
import java.time.Instant

class AidenBotWatchControllerTest {
    private class Host : AidenBotWatchTransport {
        var watches = listOf(watchFixture())
        var templates = watchList().templates
        var sourceChoices = listOf(AidenBotWatchSourceChoice(SOURCE_ID, AidenBotWatchTemplateId.MAIL, "Mail", "Personal", "Inbox", true))
        var calendarSaveResult: AidenBotWatch? = null
        var reads = 0
        var discoveries = 0
        var saves = mutableListOf<AidenBotWatchSaveRequest>()
        var removes = 0
        var runs = mutableListOf<AidenBotWatchMutation>()
        var failSave = false
        var conflict = false
        var failRun = false
        var inFlight = false
        var deniedRun = false
        var runError: Exception? = null
        var read: (suspend () -> AidenBotWatchList)? = null
        var testRequest: AidenBotWatchTestRequest? = null
        override suspend fun list(): AidenBotWatchList { reads++; return read?.invoke() ?: watchList(watches).copy(templates = templates) }
        override suspend fun sources(): AidenBotWatchSourceList { discoveries++; return AidenBotWatchSourceList(sourceChoices, emptyList()) }
        override suspend fun save(id: String?, request: AidenBotWatchSaveRequest): AidenBotWatch {
            saves.add(request)
            if (conflict) throw AidenRemoteClientException.Server(409, AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.REVISION_CONFLICT, "Changed", "req_1", false))
            val value = calendarSaveResult ?: watchFixture().copy(id = id ?: request.mutationId, name = request.name, prompt = request.prompt, revision = "2")
            watches = listOf(value)
            if (failSave) throw IOException("Response lost")
            return value
        }
        override suspend fun enable(id: String, request: AidenBotWatchMutation) = watches.first().copy(enabled = request.enabled!!, revision = "2").also { watches = listOf(it) }
        override suspend fun remove(id: String, request: AidenBotWatchMutation): AidenBotWatchRemoval { removes++; watches = emptyList(); throw IOException("Response lost") }
        override suspend fun test(request: AidenBotWatchTestRequest): AidenBotWatchTestResult { testRequest = request; return AidenBotWatchTestResult(1, AidenBotWatchCheckResult.UNCHANGED, 3, 0, emptyList()) }
        override suspend fun run(id: String, request: AidenBotWatchMutation): AidenBotWatchRunResult { runs.add(request); runError?.let { throw it }; if (deniedRun) throw AidenRemoteClientException.Server(403, AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.CAPABILITY_DENIED, "Denied", "req_1", false)); if (inFlight) throw AidenRemoteClientException.Server(409, AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT, "Pending", "req_1", true)); if (failRun) throw IOException("Response lost"); return AidenBotWatchRunResult(id, "2", false) }
    }
    @Test fun availableCalendarPreservesOpaqueSourceWindowAndEditedTimezoneThroughPreviewAndSave() = runTest {
        val host = Host()
        host.watches = emptyList()
        host.templates = listOf(WATCH_TEMPLATE, WATCH_CALENDAR.copy(available = true, unavailableReason = null))
        host.sourceChoices = listOf(AidenBotWatchSourceChoice(SOURCE_ID, AidenBotWatchTemplateId.CALENDAR, "Composio Calendar", "Work", "Planning", true))
        val controller = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID })
        controller.load()
        assertEquals(0, host.discoveries)
        controller.begin(); controller.discover(); controller.choose(controller.state.value.sources!!.choices.single())
        controller.edit { it.copy(name = "Upcoming planning", prompt = "Prepare a short agenda", condition = AidenBotWatchCondition.Calendar(120, "UTC"), calendarTimezone = "America/New_York") }
        controller.test()
        assertEquals(SOURCE_ID, host.testRequest!!.sourceChoiceId)
        val preview = host.testRequest!!.condition as AidenBotWatchCondition.Calendar
        assertEquals(120, preview.lookAheadMinutes)
        assertEquals("America/New_York", preview.timezone)
        assertTrue(host.saves.isEmpty()); assertTrue(host.runs.isEmpty())
        host.calendarSaveResult = watchFixture().copy(id = MUTATION_ID, revision = "2", name = "Upcoming planning", prompt = "Prepare a short agenda", templateId = AidenBotWatchTemplateId.CALENDAR,
            condition = AidenBotWatchCondition.Calendar(120, "America/New_York"), source = AidenBotWatchSource("Composio Calendar", "Work", "Planning"))
        controller.save()
        assertEquals(1, host.saves.size)
        assertEquals(SOURCE_ID, host.saves.single().sourceChoiceId)
        val saved = host.saves.single().condition as AidenBotWatchCondition.Calendar
        assertEquals(120, saved.lookAheadMinutes)
        assertEquals("America/New_York", saved.timezone)
        assertEquals(AidenBotWatchTemplateId.CALENDAR, controller.state.value.view!!.watches.single().templateId)
        assertNull(controller.state.value.draft); assertFalse(controller.state.value.pending)
    }
    @Test fun uncertainEditPreservesFrozenRevisionWordsAndIdentityUntilExplicitRetry() = runTest {
        val host = Host(); val controller = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID })
        controller.load(); controller.begin(host.watches.first()); controller.edit { it.copy(name = "Important mail") }
        host.failSave = true
        controller.save()
        assertTrue(controller.state.value.pending)
        assertEquals("Important mail", controller.state.value.draft!!.name)
        assertEquals("1", controller.state.value.draft!!.revision)
        controller.edit { it.copy(name = "Different") }; controller.save(); controller.run(host.watches.first())
        assertEquals(1, host.saves.size); assertTrue(host.runs.isEmpty())
        host.failSave = false; controller.retry()
        assertEquals(2, host.saves.size)
        assertEquals("Important mail", host.saves[1].name)
        assertEquals("1", host.saves[1].expectedRevision)
        assertEquals(MUTATION_ID, host.saves[1].mutationId)
        assertNull(controller.state.value.draft); assertFalse(controller.state.value.pending)
    }
    @Test fun uncertainCreateSettlesOnlyItsExactMutationIdAndDeleteSettlesFromAbsence() = runTest {
        val host = Host(); val controller = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID })
        controller.load(); controller.begin(); controller.discover(); controller.choose(controller.state.value.sources!!.choices.first())
        controller.edit { it.copy(name = "Mail", prompt = "Review changes") }; host.failSave = true
        controller.save()
        assertFalse(controller.state.value.pending); assertNull(controller.state.value.draft)
        assertEquals(MUTATION_ID, controller.state.value.view!!.watches.single().id)
        controller.remove(controller.state.value.view!!.watches.single())
        assertFalse(controller.state.value.pending); assertTrue(controller.state.value.view!!.watches.isEmpty()); assertEquals(1, host.removes)
    }
    @Test fun staleSaveDoesNotOverwriteCurrentHostUntilPersonReviewsNewRevision() = runTest {
        val host = Host(); val controller = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID })
        controller.load(); controller.begin(host.watches.first()); controller.edit { it.copy(name = "My draft") }
        host.watches = listOf(watchFixture().copy(revision = "3", name = "Desktop title")); host.conflict = true
        controller.save()
        assertEquals(AidenBotWatchError.CONFLICT, controller.state.value.error)
        assertEquals("Desktop title", controller.state.value.view!!.watches.single().name)
        assertEquals("My draft", controller.state.value.draft!!.name)
        assertEquals("1", controller.state.value.draft!!.revision)
        controller.useLatestRevision()
        assertEquals("3", controller.state.value.draft!!.revision)
        assertEquals("My draft", controller.state.value.draft!!.name)
    }
    @Test fun testDoesNotRunAndUncertainRunReusesItsIdentityAndRevision() = runTest {
        val host = Host(); val controller = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID })
        controller.load(); controller.test(host.watches.first())
        assertTrue(host.runs.isEmpty()); assertEquals("1", host.testRequest!!.expectedRevision)
        assertEquals(3, controller.state.value.testResult!!.itemCount)
        host.failRun = true; controller.run(host.watches.first()); controller.load()
        assertTrue(controller.state.value.pending); assertEquals(1, host.runs.size)
        host.failRun = false; controller.retry()
        assertEquals(MUTATION_ID, host.runs[1].mutationId); assertEquals("1", host.runs[1].expectedRevision)
        assertEquals(false, controller.state.value.runAdmitted); assertFalse(controller.state.value.pending)
    }
    @Test fun inFlightReceiptNeverBecomesANewRunIdentity() = runTest {
        val host = Host(); val controller = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID })
        controller.load(); host.inFlight = true; controller.run(host.watches.first())
        assertTrue(controller.state.value.pending)
        controller.run(host.watches.first()); assertEquals(1, host.runs.size)
        host.inFlight = false; controller.retry()
        assertEquals(2, host.runs.size)
        assertEquals(MUTATION_ID, host.runs[1].mutationId)
        assertEquals("1", host.runs[1].expectedRevision)
    }

    @Test fun permissionRefusalDuringUnknownReplayKeepsTheOriginalRequest() = runTest {
        val host = Host(); val controller = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID })
        controller.load(); host.failRun = true; controller.run(host.watches.first())
        host.failRun = false; host.deniedRun = true; controller.retry()
        assertTrue(controller.state.value.pending)
        assertEquals(AidenBotWatchError.PERMISSION, controller.state.value.error)
        host.deniedRun = false; controller.retry()
        assertEquals(3, host.runs.size)
        assertEquals(MUTATION_ID, host.runs.last().mutationId)
        assertEquals("1", host.runs.last().expectedRevision)
        assertFalse(controller.state.value.pending)
    }

    @Test fun unknownRunKeepsItsIdentityAcrossLaterGuardErrorsUntilSameKeySettlement() = runTest {
        val refusals = listOf(400 to AidenRemoteErrorCode.INVALID_REQUEST, 404 to AidenRemoteErrorCode.NOT_FOUND,
            422 to AidenRemoteErrorCode.INVALID_REQUEST, 409 to AidenRemoteErrorCode.REVISION_CONFLICT)
        for ((status, code) in refusals) {
            val host = Host(); var minted = 0
            val controller = AidenBotWatchController(host, { true }, { true }, { if (minted++ == 0) MUTATION_ID else SOURCE_ID })
            controller.load(); host.failRun = true; controller.run(host.watches.first())
            host.failRun = false
            host.runError = AidenRemoteClientException.Server(status, AidenRemoteErrorEnvelope.Body(code, "Refused", "req_1", false))
            controller.retry()
            assertTrue("$status does not settle the original run", controller.state.value.pending)
            assertEquals(AidenBotWatchError.UNCERTAIN, controller.state.value.error)
            controller.run(host.watches.first())
            assertEquals("fresh Run remains blocked", 2, host.runs.size)
            assertEquals("no replacement UUID is minted", 1, minted)
            host.runError = null; controller.retry()
            assertEquals(3, host.runs.size)
            assertEquals(MUTATION_ID, host.runs.last().mutationId)
            assertEquals("1", host.runs.last().expectedRevision)
            assertFalse(controller.state.value.pending)
        }
    }
    @Test fun firstDefinitiveRunDenialMayClearBeforeAnotherExplicitRun() = runTest {
        val host = Host(); var minted = 0
        val controller = AidenBotWatchController(host, { true }, { true }, { if (minted++ == 0) MUTATION_ID else SOURCE_ID })
        controller.load()
        host.runError = AidenRemoteClientException.Server(404, AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.NOT_FOUND, "Missing", "req_1", false))
        controller.run(host.watches.first())
        assertFalse(controller.state.value.pending)
        assertEquals(AidenBotWatchError.FAILED, controller.state.value.error)
        host.runError = null; controller.run(host.watches.first())
        assertEquals(2, host.runs.size)
        assertEquals(SOURCE_ID, host.runs.last().mutationId)
    }

    @Test fun revokedWritePermissionAndGatedSourcesCannotTriggerHostWork() = runTest {
        val host = Host(); var write = true
        val controller = AidenBotWatchController(host, { true }, { write }, { MUTATION_ID })
        controller.load(); controller.begin(); controller.discover()
        controller.choose(AidenBotWatchSourceChoice(SOURCE_ID, AidenBotWatchTemplateId.CALENDAR, "Calendar", "Personal", "Calendar", true))
        assertNull(controller.state.value.draft!!.sourceChoiceId)
        write = false; controller.choose(controller.state.value.sources!!.choices.first()); controller.run(host.watches.first()); controller.remove(host.watches.first())
        assertTrue(host.runs.isEmpty()); assertEquals(0, host.removes)
    }
    @Test fun processRestartRestoresDraftAndExactUncertainEditWithoutAutomaticReplay() = runTest {
        val secure = InMemoryAidenSecureStore(); val host = Host()
        fun disk() = AidenBotWatchJournalStore(secure).journal("host", "device", Instant.EPOCH, "bot_fixture_01") { true }
        val first = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID }, disk())
        first.load(); first.begin(host.watches.first()); first.edit { it.copy(name = "Keep this draft", prompt = "Use these instructions") }
        host.failSave = true; first.save()
        assertTrue(first.state.value.pending)
        val restarted = AidenBotWatchController(host, { true }, { true }, { error("Must not mint another identity") }, disk())
        assertEquals(1, host.saves.size)
        assertEquals("Keep this draft", restarted.state.value.draft!!.name)
        assertEquals("Use these instructions", restarted.state.value.draft!!.prompt)
        assertEquals("1", restarted.state.value.draft!!.revision)
        restarted.load(); assertEquals(1, host.saves.size)
        host.failSave = false; restarted.retry()
        assertEquals(MUTATION_ID, host.saves[1].mutationId)
        assertEquals("1", host.saves[1].expectedRevision)
        assertEquals("Use these instructions", host.saves[1].prompt)
        assertFalse(restarted.state.value.pending)
        assertNull(AidenBotWatchController(host, { true }, { true }, journal = disk()).state.value.draft)
    }
    @Test fun processRestartKeepsRunIdentityAndDoesNotInferSuccessFromTimestamps() = runTest {
        val secure = InMemoryAidenSecureStore(); val host = Host()
        fun disk() = AidenBotWatchJournalStore(secure).journal("host", "device", Instant.EPOCH, "bot_fixture_01") { true }
        val first = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID }, disk())
        first.load(); host.failRun = true; first.run(host.watches.first())
        val restarted = AidenBotWatchController(host, { true }, { true }, { error("Must keep original run identity") }, disk())
        restarted.load(); assertTrue(restarted.state.value.pending); assertEquals(1, host.runs.size)
        host.failRun = false; restarted.retry()
        assertEquals(MUTATION_ID, host.runs[1].mutationId); assertEquals("1", host.runs[1].expectedRevision)
        assertFalse(AidenBotWatchController(host, { true }, { true }, journal = disk()).state.value.pending)
    }
    @Test fun failedDurableCommitPreventsNetworkTransmissionAndKeepsDraftVisible() = runTest {
        val host = Host()
        val disk = object : AidenBotWatchJournal {
            override fun read(): String? = null
            override fun write(record: String?) { throw IOException("Secure storage unavailable") }
        }
        val controller = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID }, disk)
        controller.load(); controller.begin(host.watches.first()); controller.edit { it.copy(name = "Unsaved draft") }; controller.save()
        assertTrue(host.saves.isEmpty())
        assertEquals("Unsaved draft", controller.state.value.draft!!.name)
        assertEquals(AidenBotWatchError.STORAGE, controller.state.value.error)
        assertTrue(controller.state.value.pending)
    }

    @Test fun visibleRefreshReadsHostStatusPreservesDraftAndUnknownRunAndStopsOnCancellation() = runTest {
        val host = Host(); val controller = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID })
        controller.load(); controller.begin(host.watches.first()); controller.edit { it.copy(name = "Keep my draft") }
        val refresh = launch { controller.refreshWhileActive() }
        testScheduler.runCurrent()
        host.watches = listOf(watchFixture().copy(state = AidenBotWatchState.CHANGED, revision = "2"))
        testScheduler.advanceTimeBy(15_000); testScheduler.runCurrent()
        assertEquals(AidenBotWatchState.CHANGED, controller.state.value.view!!.watches.single().state)
        assertEquals("Keep my draft", controller.state.value.draft!!.name)
        assertEquals("1", controller.state.value.draft!!.revision)
        host.failRun = true; controller.run(host.watches.first())
        val beforeRefresh = host.reads
        testScheduler.advanceTimeBy(15_000); testScheduler.runCurrent()
        assertEquals(beforeRefresh + 1, host.reads)
        assertTrue(controller.state.value.pending)
        assertEquals(1, host.runs.size)
        assertTrue(host.saves.isEmpty()); assertEquals(0, host.removes)
        assertEquals(0, host.discoveries); assertNull(host.testRequest)
        refresh.cancelAndJoin()
        val afterPause = host.reads
        testScheduler.advanceTimeBy(30_000); testScheduler.runCurrent()
        assertEquals("paused/disposed screen stops status reads", afterPause, host.reads)
    }

    @Test fun oldReadCannotRollBackASuccessfulMutation() = runTest {
        val host = Host(); val controller = AidenBotWatchController(host, { true }, { true }, { MUTATION_ID })
        controller.load()
        val answer = CompletableDeferred<AidenBotWatchList>(); host.read = { answer.await() }
        val reading = launch { controller.load() }
        testScheduler.runCurrent()
        host.read = null
        controller.setEnabled(host.watches.first())
        answer.complete(watchList()); reading.join()
        assertFalse(controller.state.value.view!!.watches.single().enabled)
    }
}
