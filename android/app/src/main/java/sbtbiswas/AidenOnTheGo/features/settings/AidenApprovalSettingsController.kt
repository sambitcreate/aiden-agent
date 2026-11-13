package sbtbiswas.AidenOnTheGo.features.settings

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import sbtbiswas.AidenOnTheGo.models.AidenApprovalMode
import sbtbiswas.AidenOnTheGo.models.AidenApprovalModeView
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleGroup
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRulePickerOption
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleRow
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRulesView
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException

/** The Mac's approval mode and rules page (revision 61, `approvals:settings`). */
interface AidenApprovalSettingsRemote {
    suspend fun mode(): AidenApprovalModeView
    suspend fun setMode(mode: AidenApprovalMode): AidenApprovalModeView
    suspend fun rules(): AidenApprovalRulesView
    suspend fun picker(): List<AidenApprovalRulePickerOption>
    suspend fun add(target: JsonObject, decision: AidenApprovalRuleDecision): AidenApprovalRulesView
    suspend fun change(ref: JsonObject, decision: AidenApprovalRuleDecision): AidenApprovalRulesView
    suspend fun remove(ref: JsonObject): AidenApprovalRulesView
}

class AidenRemoteClientApprovalSettings(private val client: AidenRemoteClient) : AidenApprovalSettingsRemote {
    override suspend fun mode() = client.approvalMode()
    override suspend fun setMode(mode: AidenApprovalMode) = client.setApprovalMode(mode)
    override suspend fun rules() = client.approvalRules()
    override suspend fun picker() = client.approvalRulePicker()
    override suspend fun add(target: JsonObject, decision: AidenApprovalRuleDecision) = client.addApprovalRule(target, decision)
    override suspend fun change(ref: JsonObject, decision: AidenApprovalRuleDecision) = client.changeApprovalRule(ref, decision)
    override suspend fun remove(ref: JsonObject) = client.removeApprovalRule(ref)
}

/** A rule this phone is adding, shown at once in its group until the Mac's page replaces it. */
data class AidenApprovalPendingRule(val label: String, val group: AidenApprovalRuleGroup, val token: Long)

data class AidenApprovalSettingsState(
    val mode: AidenApprovalModeView? = null,
    val modeFailed: Boolean = false,
    val modeError: String? = null,
    val rules: AidenApprovalRulesView? = null,
    val rulesFailed: Boolean = false,
    val rulesError: String? = null,
    val picker: List<AidenApprovalRulePickerOption>? = null,
    val pickerFailed: Boolean = false,
    /** Rows whose change or removal is on its way, by ref. */
    val savingRefs: Set<JsonObject> = emptySet(),
    val pendingRules: List<AidenApprovalPendingRule> = emptyList()
) {
    /** Auto can be chosen only while the Mac has a model to judge with. */
    fun canChoose(mode: AidenApprovalMode): Boolean =
        this.mode != null && (mode != AidenApprovalMode.AUTO || this.mode.autoAvailable)

    fun rows(group: AidenApprovalRuleGroup): List<AidenApprovalRuleRow> = rules?.rows.orEmpty().filter { it.group == group }
}

/**
 * Drives Settings → Approvals. Every choice applies at once and settles with the Mac's answer;
 * a refusal puts the page back as it was and says why. The routes fail closed: while the Mac
 * can't read its rules file, nothing is sent and the page says so.
 */
class AidenApprovalSettingsController(private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(AidenApprovalSettingsState())
    val state: StateFlow<AidenApprovalSettingsState> = _state.asStateFlow()

    private var remote: AidenApprovalSettingsRemote? = null
    private var generation = 0L
    private var modeWrites = 0L
    private var rulesWrites = 0L
    private var nextToken = 0L
    private var loadJob: Job? = null

    /** Points the page at a client. A new one starts from nothing, so no other Mac's rules show. */
    fun bind(remote: AidenApprovalSettingsRemote?) {
        if (remote === this.remote) return
        this.remote = remote
        generation += 1
        loadJob?.cancel()
        _state.value = AidenApprovalSettingsState()
    }

    fun refresh() {
        val remote = remote ?: return
        val current = generation
        loadJob?.cancel()
        loadJob = scope.launch {
            val modeAt = modeWrites
            val rulesAt = rulesWrites
            launch {
                try {
                    val mode = remote.mode()
                    if (current == generation && modeAt == modeWrites) _state.update { it.copy(mode = mode, modeFailed = false) }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    if (current == generation) _state.update { it.copy(modeFailed = it.mode == null) }
                }
            }
            launch {
                try {
                    val rules = remote.rules()
                    if (current == generation && rulesAt == rulesWrites) _state.update { it.copy(rules = rules, rulesFailed = false) }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    if (current == generation) _state.update { it.copy(rulesFailed = it.rules == null) }
                }
            }
        }
    }

    fun loadPicker() {
        val remote = remote ?: return
        val current = generation
        scope.launch {
            try {
                val options = remote.picker()
                if (current == generation) _state.update { it.copy(picker = options, pickerFailed = false) }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                if (current == generation) _state.update { it.copy(pickerFailed = true) }
            }
        }
    }

    /** Chooses a mode. Auto is refused here while the Mac has no model for it, without a request. */
    suspend fun setMode(mode: AidenApprovalMode): Boolean {
        val remote = remote ?: return false
        val before = _state.value.mode ?: return false
        if (!_state.value.canChoose(mode) || before.mode == mode) return false
        val current = generation
        modeWrites += 1
        val writes = modeWrites
        _state.update { it.copy(mode = before.copy(mode = mode), modeError = null) }
        return try {
            val view = remote.setMode(mode)
            if (current == generation && writes == modeWrites) _state.update { it.copy(mode = view) }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (current == generation && writes == modeWrites) {
                _state.update { it.copy(mode = before, modeError = refusal(error, CHANGE_FAILED)) }
            }
            false
        }
    }

    /** Moves a row to Allow, Ask or Block, among the decisions the row offers. */
    suspend fun changeRule(row: AidenApprovalRuleRow, decision: AidenApprovalRuleDecision): Boolean {
        if (decision !in row.decisions || row.decision == decision) return false
        return writeRule(row.ref, optimistic = { rows ->
            rows.map { if (it.ref == row.ref) it.copy(group = decision.group) else it }
        }) { remote -> remote.change(row.ref, decision) }
    }

    suspend fun removeRule(row: AidenApprovalRuleRow): Boolean =
        writeRule(row.ref, optimistic = { rows -> rows.filterNot { it.ref == row.ref } }) { remote -> remote.remove(row.ref) }

    /** Adds a rule from the picker. It shows in its group at once; the Mac's page replaces it. */
    suspend fun addRule(option: AidenApprovalRulePickerOption, decision: AidenApprovalRuleDecision): Boolean {
        val remote = remote ?: return false
        val rules = _state.value.rules ?: return false
        if (rules.unreadable) {
            _state.update { it.copy(rulesError = UNREADABLE) }
            return false
        }
        val current = generation
        val pending = AidenApprovalPendingRule(option.label, decision.group, nextToken++)
        rulesWrites += 1
        val writes = rulesWrites
        _state.update { it.copy(pendingRules = it.pendingRules + pending, rulesError = null) }
        return try {
            val page = remote.add(option.target, decision)
            if (current == generation) {
                _state.update { state ->
                    state.copy(
                        rules = if (writes == rulesWrites) page else state.rules,
                        pendingRules = state.pendingRules - pending
                    )
                }
            }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (current == generation) {
                _state.update { it.copy(pendingRules = it.pendingRules - pending, rulesError = refusal(error, ADD_FAILED)) }
            }
            false
        }
    }

    private suspend fun writeRule(
        ref: JsonObject,
        optimistic: (List<AidenApprovalRuleRow>) -> List<AidenApprovalRuleRow>,
        send: suspend (AidenApprovalSettingsRemote) -> AidenApprovalRulesView
    ): Boolean {
        val remote = remote ?: return false
        val before = _state.value.rules ?: return false
        if (ref in _state.value.savingRefs) return false
        if (before.unreadable) {
            _state.update { it.copy(rulesError = UNREADABLE) }
            return false
        }
        val current = generation
        rulesWrites += 1
        val writes = rulesWrites
        _state.update {
            it.copy(rules = before.copy(rows = optimistic(before.rows)), savingRefs = it.savingRefs + ref, rulesError = null)
        }
        return try {
            val page = send(remote)
            if (current == generation && writes == rulesWrites) _state.update { it.copy(rules = page) }
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (current == generation) {
                val server = error as? AidenRemoteClientException.Server
                _state.update { state ->
                    val rollback = writes == rulesWrites
                    when {
                        // The row is gone on the Mac: it leaves here too.
                        server?.statusCode == 404 -> state.copy(
                            rules = state.rules?.let { it.copy(rows = it.rows.filterNot { row -> row.ref == ref }) },
                            rulesError = GONE
                        )
                        else -> state.copy(rules = if (rollback) before else state.rules, rulesError = refusal(error, REFUSED))
                    }
                }
            }
            false
        } finally {
            if (current == generation) _state.update { it.copy(savingRefs = it.savingRefs - ref) }
        }
    }

    /** The Mac's own words for a refusal it explains (400, 409), else [fallback]. */
    private fun refusal(error: Exception, fallback: String): String {
        val server = error as? AidenRemoteClientException.Server ?: return UNREACHABLE
        return server.body.message.takeIf { (server.statusCode == 400 || server.statusCode == 409) && it.isNotBlank() } ?: fallback
    }

    companion object {
        const val UNREADABLE = "Your approval rules couldn’t be read. Fix them on your Mac first."
        const val REFUSED = "That rule couldn’t be changed. Refresh and try again."
        const val GONE = "That rule is no longer there."
        const val ADD_FAILED = "Couldn’t add that rule."
        const val CHANGE_FAILED = "Couldn’t change approvals."
        const val UNREACHABLE = "Aiden couldn’t reach your Mac. Try again."
    }
}

private val AidenApprovalRuleDecision.group: AidenApprovalRuleGroup
    get() = when (this) {
        AidenApprovalRuleDecision.ALLOW -> AidenApprovalRuleGroup.ALLOW
        AidenApprovalRuleDecision.ASK -> AidenApprovalRuleGroup.ASK
        AidenApprovalRuleDecision.BLOCK -> AidenApprovalRuleGroup.BLOCK
    }
