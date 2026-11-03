@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException

/** Exact scalar/UTF-8 bounds from the host's Open-work contract; IDs remain opaque strings. */
object AidenOpenWorkWire {
    fun check(value: Boolean) { if (!value) throw AidenBotContractException.InvalidField("open work") }
    fun id(value: String) = check(Regex("^[A-Za-z0-9._:-]{1,160}$").matches(value))
    fun decimal(value: String) = check(Regex("^[1-9][0-9]{0,31}$").matches(value))
    fun uuid(value: String) = check(Regex("^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$").matches(value))
    fun text(value: String, scalars: Int, bytes: Int, empty: Boolean = false) {
        check((empty || value.isNotBlank()) && !value.contains('\u0000'))
        var offset = 0; var count = 0
        while (offset < value.length) {
            val char = value[offset]
            check(!Character.isLowSurrogate(char))
            if (Character.isHighSurrogate(char)) { check(offset + 1 < value.length && Character.isLowSurrogate(value[offset + 1])); offset++ }
            offset++; count++
        }
        check(count <= scalars && value.toByteArray(Charsets.UTF_8).size <= bytes)
    }
    fun clamp(value: String, scalars: Int, bytes: Int): String {
        var end = 0; var count = 0; var used = 0
        while (end < value.length && count < scalars) {
            val c = value[end]
            if (c == '\u0000' || Character.isLowSurrogate(c) || Character.isHighSurrogate(c) && (end + 1 >= value.length || !Character.isLowSurrogate(value[end + 1]))) break
            val width = if (Character.isHighSurrogate(c)) 2 else 1
            val cost = value.substring(end, end + width).toByteArray(Charsets.UTF_8).size
            if (used + cost > bytes) break
            used += cost; count++; end += width
        }
        return value.substring(0, end)
    }
}
@Serializable enum class AidenOpenWorkState { @SerialName("open") OPEN, @SerialName("waiting") WAITING, @SerialName("done") DONE, @SerialName("dismissed") DISMISSED }
@Serializable enum class AidenOpenWorkSourceKind { @SerialName("person") PERSON, @SerialName("routine") ROUTINE }
@Serializable data class AidenOpenWorkSource(val kind: AidenOpenWorkSourceKind, val submissionId: String? = null, val entryId: String? = null, val routineId: String? = null, val runId: String? = null) {
    init {
        AidenOpenWorkWire.check((submissionId == null) == (entryId == null)); submissionId?.let(AidenOpenWorkWire::decimal); entryId?.let(AidenOpenWorkWire::decimal)
        if (kind == AidenOpenWorkSourceKind.ROUTINE) { AidenOpenWorkWire.check(submissionId != null && routineId != null && runId != null); AidenOpenWorkWire.id(routineId!!); AidenOpenWorkWire.id(runId!!) }
        else AidenOpenWorkWire.check(routineId == null && runId == null)
    }
}
@Serializable enum class AidenOpenWorkLinkKind { @SerialName("source") SOURCE, @SerialName("result") RESULT, @SerialName("routine") ROUTINE, @SerialName("issue") ISSUE }
@Serializable data class AidenOpenWorkLink(val kind: AidenOpenWorkLinkKind, val submissionId: String? = null, val entryId: String? = null, val routineId: String? = null, val runId: String? = null, val issueId: String? = null) {
    init {
        when (kind) {
            AidenOpenWorkLinkKind.SOURCE, AidenOpenWorkLinkKind.RESULT -> { AidenOpenWorkWire.check(submissionId != null && entryId != null && routineId == null && runId == null && issueId == null); AidenOpenWorkWire.decimal(submissionId!!); AidenOpenWorkWire.decimal(entryId!!) }
            AidenOpenWorkLinkKind.ROUTINE -> { AidenOpenWorkWire.check(routineId != null && runId != null && submissionId == null && entryId == null && issueId == null); AidenOpenWorkWire.id(routineId!!); AidenOpenWorkWire.id(runId!!) }
            AidenOpenWorkLinkKind.ISSUE -> { AidenOpenWorkWire.check(issueId != null && submissionId == null && entryId == null && routineId == null && runId == null); AidenOpenWorkWire.id(issueId!!) }
        }
    }
}
@Serializable enum class AidenOpenWorkExecutionState { @SerialName("idle") IDLE, @SerialName("queued") QUEUED, @SerialName("running") RUNNING, @SerialName("interrupted") INTERRUPTED, @SerialName("stopping") STOPPING }
@Serializable enum class AidenOpenWorkBlockedReason { @SerialName("mixed_inputs") MIXED_INPUTS, @SerialName("not_linked") NOT_LINKED, @SerialName("host_unavailable") HOST_UNAVAILABLE }
@Serializable data class AidenOpenWorkExecution(val state: AidenOpenWorkExecutionState, @Serializable(with = AidenStrictBooleanSerializer::class) val canStop: Boolean, val blockedReason: AidenOpenWorkBlockedReason? = null) {
    init { AidenOpenWorkWire.check(!canStop || blockedReason == null && state !in listOf(AidenOpenWorkExecutionState.IDLE, AidenOpenWorkExecutionState.STOPPING)) }
}
@Serializable enum class AidenOpenWorkStopState { @SerialName("requested") REQUESTED, @SerialName("stopped") STOPPED, @SerialName("already_finished") ALREADY_FINISHED, @SerialName("not_running") NOT_RUNNING, @SerialName("uncertain") UNCERTAIN, @SerialName("blocked") BLOCKED;
    val terminal: Boolean get() = this !in listOf(REQUESTED, UNCERTAIN)
}
@Serializable enum class AidenOpenWorkStopReason { @SerialName("mixed_inputs") MIXED_INPUTS, @SerialName("host_unavailable") HOST_UNAVAILABLE, @SerialName("deadline") DEADLINE, @SerialName("source_missing") SOURCE_MISSING }
@Serializable data class AidenOpenWorkStopReceipt(val mutationId: String, val state: AidenOpenWorkStopState, @Serializable(with = AidenBotWatchTimestampSerializer::class) val requestedAt: Long,
    @Serializable(with = AidenBotWatchTimestampSerializer::class) val finishedAt: Long? = null, val reason: AidenOpenWorkStopReason? = null) { init { AidenOpenWorkWire.uuid(mutationId) } }
@Serializable data class AidenOpenWorkSubmission(val submissionId: String, val entryId: String) { init { AidenOpenWorkWire.decimal(submissionId); AidenOpenWorkWire.decimal(entryId) } }
@Serializable enum class AidenOpenWorkCompletedBy { @SerialName("person") PERSON, @SerialName("bot") BOT }
@Serializable data class AidenOpenWorkCompletion(val by: AidenOpenWorkCompletedBy, @Serializable(with = AidenBotWatchTimestampSerializer::class) val at: Long, val result: AidenOpenWorkSubmission? = null)
@Serializable data class AidenOpenWorkItem(val id: String, val revision: String, val title: String, val note: String, val state: AidenOpenWorkState, val waitingReason: String? = null,
    @Serializable(with = AidenBotWatchTimestampSerializer::class) val createdAt: Long, @Serializable(with = AidenBotWatchTimestampSerializer::class) val updatedAt: Long,
    val source: AidenOpenWorkSource, val links: List<AidenOpenWorkLink>, val completion: AidenOpenWorkCompletion? = null, val execution: AidenOpenWorkExecution, val lastStop: AidenOpenWorkStopReceipt? = null) {
    init {
        AidenOpenWorkWire.id(id); AidenOpenWorkWire.id(revision); AidenOpenWorkWire.text(title,160,640); AidenOpenWorkWire.text(note,1000,2048,true)
        AidenOpenWorkWire.check((state == AidenOpenWorkState.WAITING) == (waitingReason != null)); waitingReason?.let { AidenOpenWorkWire.text(it,160,640) }
        AidenOpenWorkWire.check(links.size <= 4 && links.distinct().size == links.size && (completion == null || state == AidenOpenWorkState.DONE))
    }
}
@Serializable data class AidenOpenWorkUndo(val mutationId: String, val itemId: String, val expectedRevision: String, @Serializable(with = AidenBotWatchTimestampSerializer::class) val expiresAt: Long) {
    init { AidenOpenWorkWire.uuid(mutationId); AidenOpenWorkWire.id(itemId); AidenOpenWorkWire.id(expectedRevision) }
}
@Serializable data class AidenOpenWorkSnapshot(val botId: String, val revision: String, val items: List<AidenOpenWorkItem>, val undo: List<AidenOpenWorkUndo>) {
    init {
        AidenOpenWorkWire.id(botId); AidenOpenWorkWire.id(revision)
        AidenOpenWorkWire.check(items.size <= 192 && items.distinctBy { it.id }.size == items.size && items.count { it.state in listOf(AidenOpenWorkState.OPEN,AidenOpenWorkState.WAITING) } <= 64 && items.count { it.state in listOf(AidenOpenWorkState.DONE,AidenOpenWorkState.DISMISSED) } <= 128)
        AidenOpenWorkWire.check(undo.size <= 192 && undo.distinctBy { it.itemId }.size == undo.size && undo.all { u -> items.any { it.id == u.itemId && it.revision == u.expectedRevision } })
    }
}
@Serializable data class AidenOpenWorkPatch(val title: String? = null, val note: String? = null, val state: AidenOpenWorkState? = null, val waitingReason: String? = null) {
    init {
        AidenOpenWorkWire.check(title != null || note != null || state != null || waitingReason != null)
        title?.let { AidenOpenWorkWire.text(it,160,640) }; note?.let { AidenOpenWorkWire.text(it,1000,2048,true) }; waitingReason?.let { AidenOpenWorkWire.text(it,160,640) }
        AidenOpenWorkWire.check((state != AidenOpenWorkState.WAITING || waitingReason != null) && (state == null || state == AidenOpenWorkState.WAITING || waitingReason == null))
    }
}
@Serializable enum class AidenOpenWorkAction { @SerialName("add") ADD, @SerialName("edit") EDIT, @SerialName("dismiss") DISMISS, @SerialName("stop") STOP, @SerialName("stop_and_dismiss") STOP_AND_DISMISS, @SerialName("undo") UNDO;
    val isStop: Boolean get() = this == STOP || this == STOP_AND_DISMISS
}
@Serializable data class AidenOpenWorkMutation(val mutationId: String, val action: AidenOpenWorkAction, val expectedRevision: String, val id: String? = null, val title: String? = null, val note: String? = null, val patch: AidenOpenWorkPatch? = null, val undoOf: String? = null) {
    init {
        AidenOpenWorkWire.uuid(mutationId); AidenOpenWorkWire.id(expectedRevision); id?.let(AidenOpenWorkWire::id)
        when (action) {
            AidenOpenWorkAction.ADD -> { AidenOpenWorkWire.check(title != null && id == null && patch == null && undoOf == null); AidenOpenWorkWire.text(title!!,160,640); note?.let { AidenOpenWorkWire.text(it,1000,2048,true) } }
            AidenOpenWorkAction.EDIT -> AidenOpenWorkWire.check(id != null && patch != null && title == null && note == null && undoOf == null)
            AidenOpenWorkAction.UNDO -> { AidenOpenWorkWire.check(undoOf != null && id == null && patch == null && title == null && note == null); AidenOpenWorkWire.uuid(undoOf!!) }
            else -> AidenOpenWorkWire.check(id != null && patch == null && title == null && note == null && undoOf == null)
        }
    }
}
@Serializable enum class AidenOpenWorkErrorCode { @SerialName("invalid") INVALID, @SerialName("not_found") NOT_FOUND, @SerialName("stale") STALE, @SerialName("active_full") ACTIVE_FULL, @SerialName("history_full") HISTORY_FULL, @SerialName("receipts_full") RECEIPTS_FULL, @SerialName("mutation_conflict") MUTATION_CONFLICT, @SerialName("undo_conflict") UNDO_CONFLICT, @SerialName("undo_expired") UNDO_EXPIRED, @SerialName("mixed_inputs") MIXED_INPUTS, @SerialName("unavailable") UNAVAILABLE, @SerialName("deleted") DELETED }
@Serializable data class AidenOpenWorkResult(@Serializable(with = AidenStrictBooleanSerializer::class) val ok: Boolean, val mutationId: String? = null, @Serializable(with = AidenStrictBooleanSerializer::class) val replayed: Boolean? = null,
    val itemId: String? = null, val snapshot: AidenOpenWorkSnapshot? = null, val undo: AidenOpenWorkUndo? = null, val stop: AidenOpenWorkStopReceipt? = null, val code: AidenOpenWorkErrorCode? = null, val error: String? = null) {
    init {
        if (ok) { AidenOpenWorkWire.check(mutationId != null && replayed != null && snapshot != null && code == null && error == null); AidenOpenWorkWire.uuid(mutationId!!); itemId?.let(AidenOpenWorkWire::id) }
        else { AidenOpenWorkWire.check(code != null && error != null && mutationId == null && replayed == null && itemId == null && undo == null && stop == null); AidenOpenWorkWire.text(error!!,280,1120) }
    }
}
@Serializable enum class AidenOpenWorkEvidenceKind { @SerialName("source") SOURCE, @SerialName("result") RESULT }
@Serializable data class AidenOpenWorkEvidence(val itemId: String, val kind: AidenOpenWorkEvidenceKind, val submissionId: String, val entryId: String, val title: String, val text: String,
    @Serializable(with = AidenStrictBooleanSerializer::class) val truncated: Boolean, @Serializable(with = AidenBotWatchTimestampSerializer::class) val createdAt: Long? = null) {
    init { AidenOpenWorkWire.id(itemId); AidenOpenWorkWire.decimal(submissionId); AidenOpenWorkWire.decimal(entryId); AidenOpenWorkWire.text(title,160,640); AidenOpenWorkWire.text(text,32768,32768,true) }
}

/** Host-owned Stop admission must finish before any new change to this item's metadata. */
val AidenOpenWorkItem.hasPendingStop: Boolean
    get() = execution.state == AidenOpenWorkExecutionState.STOPPING ||
        lastStop?.state in listOf(AidenOpenWorkStopState.REQUESTED, AidenOpenWorkStopState.UNCERTAIN)
