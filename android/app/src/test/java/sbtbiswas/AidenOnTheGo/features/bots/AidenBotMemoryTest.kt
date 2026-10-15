package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
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
import java.util.Locale
import java.util.UUID

/** Profile → Memory, driven through [AidenBotMemoryController] against the shared fixture views. */
@OptIn(ExperimentalCoroutinesApi::class)
class AidenBotMemoryTest {
    private val json = AidenBotWireJson.json
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json"))
            .bufferedReader().use { it.readText() }
        json.parseToJsonElement(text).jsonObject
    }
    private val view by lazy { json.decodeFromJsonElement(AidenBotMemory.serializer(), fixture.getValue("botMemory")) }
    private val edited by lazy {
        json.decodeFromJsonElement(
            AidenBotMemoryEditResponse.serializer(),
            fixture.getValue("botMemoryEdit").jsonObject.getValue("response")
        ).view
    }

    private fun refusal(status: Int, code: AidenRemoteErrorCode) =
        AidenRemoteClientException.Server(status, AidenRemoteErrorEnvelope.Body(code, "Nope.", "req_1", false))

    /** A Mac that holds one memory view and applies edits to it. */
    private class FakeMac(var view: AidenBotMemory) : AidenBotMemoryTransport {
        var reads = 0
        data class Call(val edit: AidenBotMemoryEdit, val key: UUID)
        val calls = mutableListOf<Call>()
        /** Failures the next edits throw, in order. */
        val failures = ArrayDeque<Exception>()
        /** The view the next successful edit answers with; by default the edit is applied here. */
        var nextView: AidenBotMemory? = null
        /** Holds the next edits until completed, so a test can look at the page meanwhile. */
        var gate: kotlinx.coroutines.CompletableDeferred<Unit>? = null

        /** Failures the next reads throw, in order. */
        val readFailures = ArrayDeque<Exception>()

        override suspend fun memory(botId: String): AidenBotMemory {
            reads += 1
            readFailures.removeFirstOrNull()?.let { throw it }
            return view
        }

        override suspend fun edit(botId: String, edit: AidenBotMemoryEdit, key: UUID): AidenBotMemory {
            calls += Call(edit, key)
            gate?.await()
            failures.removeFirstOrNull()?.let { throw it }
            view = nextView ?: apply(view, edit)
            nextView = null
            return view
        }

        private fun apply(view: AidenBotMemory, edit: AidenBotMemoryEdit): AidenBotMemory {
            fun AidenBotMemoryStore.without(id: String) = copy(entries = entries.filterNot { it.id == id })
            return when (edit) {
                is AidenBotMemoryEdit.Remove -> when (edit.target) {
                    AidenBotMemoryTarget.USER -> view.copy(user = view.user.without(edit.entryId))
                    AidenBotMemoryTarget.MEMORY -> view.copy(memory = view.memory.without(edit.entryId))
                }
                AidenBotMemoryEdit.Clear -> view.copy(
                    readable = true,
                    user = view.user.copy(entries = emptyList(), usedChars = 0, overBudget = false),
                    memory = view.memory.copy(entries = emptyList(), usedChars = 0, overBudget = false)
                )
                is AidenBotMemoryEdit.Replace -> error("Replace answers come from nextView in these tests")
            }
        }
    }

    private suspend fun loaded(mac: FakeMac): AidenBotMemoryController {
        val controller = AidenBotMemoryController(view.botId, mac)
        assertTrue(controller.load())
        return controller
    }

    @Test
    fun loadingShowsBothGroupsAndFailingWithNothingShownSaysSo() = runTest {
        val controller = loaded(FakeMac(view))
        val ui = controller.state.value
        assertFalse(ui.isLoading)
        assertEquals(2, ui.view?.user?.entries?.size)
        assertEquals(1, ui.view?.memory?.entries?.size)

        val offline = object : AidenBotMemoryTransport {
            override suspend fun memory(botId: String): AidenBotMemory = throw IOException("offline")
            override suspend fun edit(botId: String, edit: AidenBotMemoryEdit, key: UUID): AidenBotMemory = throw IOException("offline")
        }
        val failing = AidenBotMemoryController(view.botId, offline)
        assertFalse(failing.load())
        assertTrue(failing.state.value.loadFailed)
    }

    @Test
    fun editingSendsATrimmedReplaceAndClosesWithTheMacsView() = runTest {
        val mac = FakeMac(view).apply { nextView = edited }
        val controller = loaded(mac)
        val entry = view.user.entries.first()

        controller.beginEdit(AidenBotMemoryTarget.USER, entry)
        assertEquals(entry.text, controller.state.value.editing?.text)
        controller.updateDraft("  Prefers short, friendly answers.  ")
        assertTrue(controller.saveEdit())

        assertEquals(
            AidenBotMemoryEdit.Replace(AidenBotMemoryTarget.USER, entry.id, "Prefers short, friendly answers."),
            mac.calls.single().edit
        )
        assertNull(controller.state.value.editing)
        // The replaced entry now has the Mac's new id.
        assertEquals("5e5e5e5e5e5e5e5e", controller.state.value.view?.user?.entries?.first()?.id)
    }

    @Test
    fun aDraftIsClampedTo500CharactersAndABlankOneCannotBeSaved() = runTest {
        val mac = FakeMac(view)
        val controller = loaded(mac)
        controller.beginEdit(AidenBotMemoryTarget.MEMORY, view.memory.entries.first())

        controller.updateDraft("x".repeat(600))
        assertEquals(500, controller.state.value.editing?.text?.length)
        controller.updateDraft("   ")
        assertFalse(controller.state.value.editing!!.canSave)
        assertFalse(controller.saveEdit())
        assertTrue(mac.calls.isEmpty())
    }

    @Test
    fun aStaleEntryKeepsTheDialogOpenWithTheChangedCopyAndReloads() = runTest {
        val mac = FakeMac(view)
        val controller = loaded(mac)
        controller.beginEdit(AidenBotMemoryTarget.USER, view.user.entries.first())
        controller.updateDraft("Prefers long answers.")
        // The Bot rewrote the entry in the meantime: the Mac answers without a view.
        mac.view = edited
        mac.failures += refusal(404, AidenRemoteErrorCode.MEMORY_ENTRY_NOT_FOUND)

        assertFalse(controller.saveEdit())
        val ui = controller.state.value
        assertEquals(AidenBotMemoryError.NOT_FOUND, ui.editing?.error)
        assertFalse(ui.editing!!.isSaving)
        assertEquals(2, mac.reads)
        assertEquals(edited, ui.view)
    }

    @Test
    fun blockedAndOverBudgetEditsExplainWhy() = runTest {
        val mac = FakeMac(view)
        val controller = loaded(mac)
        controller.beginEdit(AidenBotMemoryTarget.USER, view.user.entries.first())
        controller.updateDraft("My password is hunter2")
        mac.failures += refusal(422, AidenRemoteErrorCode.MEMORY_BLOCKED)
        assertFalse(controller.saveEdit())
        assertEquals(AidenBotMemoryError.BLOCKED, controller.state.value.editing?.error)

        // Typing again clears the old reason.
        controller.updateDraft("A".repeat(400))
        assertNull(controller.state.value.editing?.error)
        mac.failures += refusal(422, AidenRemoteErrorCode.MEMORY_OVER_BUDGET)
        assertFalse(controller.saveEdit())
        assertEquals(AidenBotMemoryError.OVER_BUDGET, controller.state.value.editing?.error)

        // A dropped connection is a plain failure, and the retry of the same text reuses its key.
        mac.failures += IOException("offline")
        assertFalse(controller.saveEdit())
        assertEquals(AidenBotMemoryError.FAILED, controller.state.value.editing?.error)
        mac.nextView = edited
        assertTrue(controller.saveEdit())
        assertEquals(mac.calls[mac.calls.size - 2].key, mac.calls.last().key)
    }

    @Test
    fun deleteRemovesTheEntryRightAway() = runTest {
        val mac = FakeMac(view)
        val controller = loaded(mac)
        val gone = view.user.entries.last()

        assertTrue(controller.delete(AidenBotMemoryTarget.USER, gone.id))
        assertEquals(AidenBotMemoryEdit.Remove(AidenBotMemoryTarget.USER, gone.id), mac.calls.single().edit)
        assertEquals(listOf(view.user.entries.first()), controller.state.value.view?.user?.entries)
        assertTrue(controller.state.value.deleting.isEmpty())
    }

    @Test
    fun aFailedDeleteSaysSoAndReloads() = runTest {
        val mac = FakeMac(view)
        val controller = loaded(mac)
        mac.failures += refusal(404, AidenRemoteErrorCode.MEMORY_ENTRY_NOT_FOUND)

        assertFalse(controller.delete(AidenBotMemoryTarget.MEMORY, "ffffffffffffffff"))
        assertEquals(AidenBotMemoryError.NOT_FOUND, controller.state.value.actionError)
        assertEquals(2, mac.reads)
    }

    @Test
    fun eraseEmptiesBothGroups() = runTest {
        val mac = FakeMac(view)
        val controller = loaded(mac)

        assertTrue(controller.erase())
        assertEquals(AidenBotMemoryEdit.Clear, mac.calls.single().edit)
        val after = controller.state.value.view!!
        assertEquals(AidenBotMemorySummary.Empty, AidenBotMemorySummary.of(after))
        assertFalse(controller.state.value.isErasing)
    }

    @Test
    fun aFailedEraseKeepsEverythingAndSaysSo() = runTest {
        val mac = FakeMac(view)
        val controller = loaded(mac)
        mac.failures += IOException("offline")

        assertFalse(controller.erase())
        assertTrue(controller.state.value.eraseFailed)
        assertEquals(AidenBotMemorySummary.Things(3), AidenBotMemorySummary.of(controller.state.value.view!!))
        // Trying again reuses the unanswered request's key, so the Mac erases once.
        assertTrue(controller.erase())
        assertEquals(mac.calls[0].key, mac.calls[1].key)
        assertFalse(controller.state.value.eraseFailed)
    }

    @Test
    fun anUnreadableMemoryOffersOnlyErase() = runTest {
        val damaged = view.copy(readable = false)
        val mac = FakeMac(damaged)
        val controller = loaded(mac)

        // Edit and Delete are not available on files the Mac couldn't read.
        controller.beginEdit(AidenBotMemoryTarget.USER, view.user.entries.first())
        assertNull(controller.state.value.editing)
        assertFalse(controller.delete(AidenBotMemoryTarget.USER, view.user.entries.first().id))
        assertTrue(mac.calls.isEmpty())

        // Erase starts the memory fresh.
        assertTrue(controller.erase())
        assertTrue(controller.state.value.view!!.readable)
        assertEquals(AidenBotMemorySummary.Empty, AidenBotMemorySummary.of(controller.state.value.view!!))
    }

    @Test
    fun theUsageMeterReadsAsCharactersOfTheLimit() {
        val store = view.user.copy(usedChars = 563, limitChars = 1_375)
        assertEquals("563" to "1,375", aidenBotMemoryUsageNumbers(store, Locale.US))
        assertEquals(563f / 1_375f, aidenBotMemoryUsageFraction(store), 0.0001f)
        // Over budget (a hand-edited file) never draws past full.
        assertEquals(1f, aidenBotMemoryUsageFraction(store.copy(usedChars = 2_000, overBudget = true)), 0f)
    }

    @Test
    fun onlyTheMemoryErrorCodesGetTheirOwnCopy() {
        assertEquals(AidenBotMemoryError.BLOCKED, aidenBotMemoryError(refusal(422, AidenRemoteErrorCode.MEMORY_BLOCKED)))
        assertEquals(AidenBotMemoryError.OVER_BUDGET, aidenBotMemoryError(refusal(422, AidenRemoteErrorCode.MEMORY_OVER_BUDGET)))
        assertEquals(AidenBotMemoryError.NOT_FOUND, aidenBotMemoryError(refusal(404, AidenRemoteErrorCode.MEMORY_ENTRY_NOT_FOUND)))
        assertEquals(AidenBotMemoryError.FAILED, aidenBotMemoryError(refusal(422, AidenRemoteErrorCode.INVALID_REQUEST)))
        assertEquals(AidenBotMemoryError.FAILED, aidenBotMemoryError(IOException("offline")))
    }

    // --- R15: memory edits apply at once and go back on failure ---

    @Test
    fun anEditShowsItsNewWordsAtOnceAndAFailurePutsThemBackWithTheDialogOpen() = runTest {
        val mac = FakeMac(view).apply { gate = CompletableDeferred() }
        val controller = loaded(mac)
        val entry = view.user.entries.first()
        controller.beginEdit(AidenBotMemoryTarget.USER, entry)
        controller.updateDraft("Prefers short answers.")
        mac.failures += refusal(422, AidenRemoteErrorCode.MEMORY_BLOCKED)
        val saving = async { controller.saveEdit() }
        runCurrent()
        assertNull("the dialog closed at once", controller.state.value.editing)
        assertEquals("Prefers short answers.", controller.state.value.view?.user?.entries?.first()?.text)
        mac.gate!!.complete(Unit)
        assertFalse(saving.await())
        assertEquals("back as it was", entry.text, controller.state.value.view?.user?.entries?.first()?.text)
        val reopened = controller.state.value.editing!!
        assertEquals("on the person's words", "Prefers short answers.", reopened.text)
        assertEquals(AidenBotMemoryError.BLOCKED, reopened.error)
    }

    @Test
    fun aDeleteAndAnEraseApplyAtOnceAndComeBackOnFailure() = runTest {
        val mac = FakeMac(view).apply { gate = CompletableDeferred() }
        val controller = loaded(mac)
        val gone = view.user.entries.last()
        mac.failures += IOException("offline")
        val deleting = async { controller.delete(AidenBotMemoryTarget.USER, gone.id) }
        runCurrent()
        assertEquals("the row went at once", listOf(view.user.entries.first()), controller.state.value.view?.user?.entries)
        mac.gate!!.complete(Unit)
        assertFalse(deleting.await())
        assertEquals(view.user.entries, controller.state.value.view?.user?.entries)

        mac.gate = CompletableDeferred()
        mac.failures += IOException("offline")
        val erasing = async { controller.erase() }
        runCurrent()
        assertEquals(AidenBotMemorySummary.Empty, AidenBotMemorySummary.of(controller.state.value.view!!))
        mac.gate!!.complete(Unit)
        assertFalse(erasing.await())
        assertEquals(AidenBotMemorySummary.Things(3), AidenBotMemorySummary.of(controller.state.value.view!!))
        assertTrue(controller.state.value.eraseFailed)
    }

    @Test
    fun aViewTheMacSentMeanwhileIsNotRolledBack() = runTest {
        val mac = FakeMac(view).apply { gate = CompletableDeferred() }
        val controller = loaded(mac)
        mac.failures += IOException("offline")
        val deleting = async { controller.delete(AidenBotMemoryTarget.USER, view.user.entries.last().id) }
        runCurrent()
        // The page reloads while the delete waits: the Mac's newer view stands, even when the
        // reload after the failure can't reach the Mac.
        mac.view = edited
        controller.load()
        mac.readFailures += IOException("offline")
        mac.gate!!.complete(Unit)
        assertFalse(deleting.await())
        assertEquals(edited, controller.state.value.view)
    }

    @Test
    fun thePageWaitsForTheMacOnSkeletonsAndThenSaysItCouldNotLoad() = runTest {
        val connection = CompletableDeferred<Boolean>()
        val controller = AidenBotMemoryController(view.botId, FakeMac(view), waitForConnection = { connection.await() })
        val loading = async { controller.load() }
        runCurrent()
        assertTrue("skeletons while the Mac connects", controller.state.value.isLoading)
        advanceTimeBy(AIDEN_BOT_SAVE_HOLD_MILLIS + 1)
        assertFalse(loading.await())
        assertTrue(controller.state.value.loadFailed)

        val connected = AidenBotMemoryController(view.botId, FakeMac(view), waitForConnection = { true })
        assertTrue(connected.load())
    }
}
