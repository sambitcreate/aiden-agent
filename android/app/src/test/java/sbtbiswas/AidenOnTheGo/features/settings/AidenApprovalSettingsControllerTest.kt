package sbtbiswas.AidenOnTheGo.features.settings

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenApprovalMode
import sbtbiswas.AidenOnTheGo.models.AidenApprovalModeView
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleGroup
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRulePickerOption
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleRow
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleScopeKind
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRulesView
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class AidenApprovalSettingsControllerTest {
    private fun ref(id: String) = JsonObject(mapOf("kind" to JsonPrimitive("tool"), "id" to JsonPrimitive(id)))

    private fun row(id: String, group: AidenApprovalRuleGroup, decisions: List<AidenApprovalRuleDecision> = AidenApprovalRuleDecision.entries) =
        AidenApprovalRuleRow(ref(id), group, "Rule $id", "Tool", AidenApprovalRuleScopeKind.MAC, null, false, decisions, null, null)

    private fun server(status: Int, message: String, code: AidenRemoteErrorCode = AidenRemoteErrorCode.INVALID_REQUEST) =
        AidenRemoteClientException.Server(status, AidenRemoteErrorEnvelope.Body(code, message, "req_1", false))

    /** A Mac that answers each write through a gate the test opens, so the in-between state can be seen. */
    private class FakeRemote : AidenApprovalSettingsRemote {
        var mode = AidenApprovalModeView(AidenApprovalMode.ASK, autoAvailable = true)
        var rules = AidenApprovalRulesView(emptyList(), unreadable = false)
        var gate: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        val writes = mutableListOf<String>()

        private suspend fun answer(label: String) {
            writes += label
            gate?.await()
            failure?.let { throw it }
        }

        override suspend fun mode() = mode
        override suspend fun rules() = rules
        override suspend fun picker() = listOf(
            AidenApprovalRulePickerOption(JsonObject(mapOf("kind" to JsonPrimitive("tool"), "name" to JsonPrimitive("bash"))), "Run commands", "Tools", null)
        )

        override suspend fun setMode(mode: AidenApprovalMode): AidenApprovalModeView {
            answer("mode:${mode.wire}")
            this.mode = this.mode.copy(mode = mode)
            return this.mode
        }

        override suspend fun add(target: JsonObject, decision: AidenApprovalRuleDecision): AidenApprovalRulesView {
            answer("add:${decision.wire}")
            val group = AidenApprovalRuleGroup.entries.first { it.wire == decision.wire }
            rules = rules.copy(rows = rules.rows + AidenApprovalRuleRow(JsonObject(mapOf("id" to JsonPrimitive("new"))), group, "Run commands", "Tool", AidenApprovalRuleScopeKind.MAC, null, false, AidenApprovalRuleDecision.entries, null, null))
            return rules
        }

        override suspend fun change(ref: JsonObject, decision: AidenApprovalRuleDecision): AidenApprovalRulesView {
            answer("change:${ref["id"]}:${decision.wire}")
            val group = AidenApprovalRuleGroup.entries.first { it.wire == decision.wire }
            rules = rules.copy(rows = rules.rows.map { if (it.ref == ref) it.copy(group = group) else it })
            return rules
        }

        override suspend fun remove(ref: JsonObject): AidenApprovalRulesView {
            answer("remove:${ref["id"]}")
            rules = rules.copy(rows = rules.rows.filterNot { it.ref == ref })
            return rules
        }
    }

    private fun TestScope.loaded(remote: FakeRemote): AidenApprovalSettingsController {
        val controller = AidenApprovalSettingsController(this)
        controller.bind(remote)
        controller.refresh()
        advanceUntilIdle()
        return controller
    }

    @Test fun modeChangeShowsAtOnceAndSettlesWithTheMac() = runTest {
        val remote = FakeRemote().apply { gate = CompletableDeferred() }
        val controller = loaded(remote)
        val pending = async { controller.setMode(AidenApprovalMode.NEVER) }
        runCurrent()
        assertEquals(AidenApprovalMode.NEVER, controller.state.value.mode?.mode)
        remote.gate!!.complete(Unit)
        assertTrue(pending.await())
        assertEquals(AidenApprovalMode.NEVER, controller.state.value.mode?.mode)
        assertEquals(listOf("mode:never"), remote.writes)
    }

    @Test fun refusedModeChangeRollsBackAndShowsTheMacsReason() = runTest {
        val remote = FakeRemote().apply {
            gate = CompletableDeferred()
            failure = server(400, "Auto needs a model. Connect one on your Mac first.")
        }
        val controller = loaded(remote)
        val pending = async { controller.setMode(AidenApprovalMode.AUTO) }
        runCurrent()
        assertEquals(AidenApprovalMode.AUTO, controller.state.value.mode?.mode)
        remote.gate!!.complete(Unit)
        assertFalse(pending.await())
        assertEquals(AidenApprovalMode.ASK, controller.state.value.mode?.mode)
        assertEquals("Auto needs a model. Connect one on your Mac first.", controller.state.value.modeError)
    }

    @Test fun autoIsRefusedWithoutARequestWhileTheMacHasNoModel() = runTest {
        val remote = FakeRemote().apply { mode = AidenApprovalModeView(AidenApprovalMode.ASK, autoAvailable = false) }
        val controller = loaded(remote)
        assertFalse(controller.state.value.canChoose(AidenApprovalMode.AUTO))
        assertTrue(controller.state.value.canChoose(AidenApprovalMode.NEVER))
        assertFalse(controller.setMode(AidenApprovalMode.AUTO))
        assertEquals(AidenApprovalMode.ASK, controller.state.value.mode?.mode)
        assertTrue(remote.writes.isEmpty())
    }

    @Test fun changingARuleMovesItAtOnceAndAFailureMovesItBack() = runTest {
        val remote = FakeRemote().apply {
            rules = AidenApprovalRulesView(listOf(row("a", AidenApprovalRuleGroup.ALLOW)), unreadable = false)
            gate = CompletableDeferred()
            failure = IOException("offline")
        }
        val controller = loaded(remote)
        val rule = controller.state.value.rows(AidenApprovalRuleGroup.ALLOW).single()
        val pending = async { controller.changeRule(rule, AidenApprovalRuleDecision.BLOCK) }
        runCurrent()
        assertEquals(listOf(rule.ref), controller.state.value.rows(AidenApprovalRuleGroup.BLOCK).map { it.ref })
        assertTrue(rule.ref in controller.state.value.savingRefs)
        remote.gate!!.complete(Unit)
        assertFalse(pending.await())
        assertEquals(listOf(rule.ref), controller.state.value.rows(AidenApprovalRuleGroup.ALLOW).map { it.ref })
        assertTrue(controller.state.value.rows(AidenApprovalRuleGroup.BLOCK).isEmpty())
        assertTrue(controller.state.value.savingRefs.isEmpty())
        assertEquals(AidenApprovalSettingsController.UNREACHABLE, controller.state.value.rulesError)
    }

    @Test fun aRuleTheMacNoLongerHasLeavesThePage() = runTest {
        val remote = FakeRemote().apply {
            rules = AidenApprovalRulesView(listOf(row("a", AidenApprovalRuleGroup.ASK), row("b", AidenApprovalRuleGroup.ASK)), unreadable = false)
            failure = server(404, "Not found", AidenRemoteErrorCode.NOT_FOUND)
        }
        val controller = loaded(remote)
        val rule = controller.state.value.rows(AidenApprovalRuleGroup.ASK).first()
        assertFalse(controller.changeRule(rule, AidenApprovalRuleDecision.ALLOW))
        assertEquals(listOf("Rule b"), controller.state.value.rules!!.rows.map { it.title })
        assertEquals(AidenApprovalSettingsController.GONE, controller.state.value.rulesError)
    }

    @Test fun onlyTheDecisionsARowOffersAreSent() = runTest {
        val remote = FakeRemote().apply {
            rules = AidenApprovalRulesView(listOf(row("a", AidenApprovalRuleGroup.BLOCK, listOf(AidenApprovalRuleDecision.BLOCK))), unreadable = false)
        }
        val controller = loaded(remote)
        val rule = controller.state.value.rows(AidenApprovalRuleGroup.BLOCK).single()
        assertFalse(controller.changeRule(rule, AidenApprovalRuleDecision.ALLOW))
        assertTrue(remote.writes.isEmpty())
        assertTrue(controller.removeRule(rule))
        assertEquals(listOf("remove:\"a\""), remote.writes)
        assertTrue(controller.state.value.rules!!.rows.isEmpty())
    }

    @Test fun anUnreadableRulesFileSendsNothing() = runTest {
        val remote = FakeRemote().apply {
            rules = AidenApprovalRulesView(listOf(row("a", AidenApprovalRuleGroup.ALLOW)), unreadable = true)
        }
        val controller = loaded(remote)
        val rule = controller.state.value.rows(AidenApprovalRuleGroup.ALLOW).single()
        assertFalse(controller.removeRule(rule))
        assertFalse(controller.addRule(remote.picker().single(), AidenApprovalRuleDecision.BLOCK))
        assertTrue(remote.writes.isEmpty())
        assertEquals(AidenApprovalSettingsController.UNREADABLE, controller.state.value.rulesError)
        assertEquals(1, controller.state.value.rules!!.rows.size)
    }

    @Test fun anAddedRuleShowsPendingUntilTheMacsPageArrives() = runTest {
        val remote = FakeRemote().apply { gate = CompletableDeferred() }
        val controller = loaded(remote)
        val pending = async { controller.addRule(remote.picker().single(), AidenApprovalRuleDecision.BLOCK) }
        runCurrent()
        assertEquals(listOf("Run commands"), controller.state.value.pendingRules.filter { it.group == AidenApprovalRuleGroup.BLOCK }.map { it.label })
        remote.gate!!.complete(Unit)
        assertTrue(pending.await())
        assertTrue(controller.state.value.pendingRules.isEmpty())
        assertEquals(listOf("Run commands"), controller.state.value.rows(AidenApprovalRuleGroup.BLOCK).map { it.title })
        assertEquals(listOf("add:block"), remote.writes)
    }

    @Test fun aNewMacStartsFromAnEmptyPage() = runTest {
        val first = FakeRemote().apply { rules = AidenApprovalRulesView(listOf(row("a", AidenApprovalRuleGroup.ALLOW)), unreadable = false) }
        val controller = loaded(first)
        assertEquals(1, controller.state.value.rules!!.rows.size)
        controller.bind(FakeRemote())
        assertNull(controller.state.value.rules)
        assertNull(controller.state.value.mode)
        controller.bind(null)
        controller.refresh()
        advanceUntilIdle()
        assertNull(controller.state.value.rules)
    }
}
