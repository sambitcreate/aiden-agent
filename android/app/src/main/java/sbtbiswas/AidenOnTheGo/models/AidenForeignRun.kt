package sbtbiswas.AidenOnTheGo.models

import sbtbiswas.AidenOnTheGo.networking.AidenRemoteRunApproval
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteRunEndState
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteRunEvent
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteStreamEvent
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteEventType
import java.time.Instant

// Contract revision 21: foreign runs.

/** How a prompt on a foreign run was resolved by another surface (the Mac,
 * Telegram, or another device) before this phone answered it. */
data class AidenForeignRunResolution(
    val prompt: Prompt,
    val resolvedAt: Instant?
) {
    sealed interface Prompt {
        data class Approval(val decision: AidenApprovalDecision?) : Prompt
        data class Question(val outcome: String?) : Prompt
    }

    /** The transient caption the losing phone shows under the composer. */
    val notice: String
        get() = when (prompt) {
            is Prompt.Approval -> when (prompt.decision) {
                AidenApprovalDecision.ALLOW -> "Answered on Mac: allowed"
                AidenApprovalDecision.DENY -> "Answered on Mac: denied"
                null -> "Answered on Mac"
            }
            is Prompt.Question -> if (prompt.outcome == "expired") "Question expired on Mac" else "Answered on Mac"
        }

    companion object {
        /** A first-responder-wins loser envelope (`409 approval_resolved` or
         * `409 question_already_resolved`), or null for any other failure. */
        fun loser(error: Throwable): AidenForeignRunResolution? {
            val server = error as? AidenRemoteClientException.Server ?: return null
            if (server.statusCode != 409) return null
            val details = server.body.details
            val resolvedAt = details?.resolvedAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
            return when (server.body.code.rawValue) {
                "approval_resolved" -> AidenForeignRunResolution(
                    Prompt.Approval(
                        when (details?.decision) {
                            "allow" -> AidenApprovalDecision.ALLOW
                            "deny" -> AidenApprovalDecision.DENY
                            else -> null
                        }
                    ),
                    resolvedAt
                )
                "question_already_resolved" -> AidenForeignRunResolution(Prompt.Question(details?.outcome), resolvedAt)
                else -> null
            }
        }
    }
}

/** Contract revision 21: the phone's live projection of a run it did not start
 * (on the Mac, in Telegram or from the scheduler). It is a pure reducer over
 * [AidenRemoteRunEvent], so attaching mid-run, gap snapshots and
 * first-responder-wins resolutions are testable without a network. */
class AidenForeignRunProjection(val runId: String) {
    sealed interface Effect {
        data class TextAppended(val text: String) : Effect
        data object Reasoning : Effect
        data class ToolStarted(val name: String) : Effect
        data object ToolFinished : Effect
        data class ApprovalRequired(val approvalId: String) : Effect
        data class QuestionRequired(val promptId: String) : Effect
        data class AnsweredElsewhere(val resolution: AidenForeignRunResolution) : Effect
        /** The transcript must be re-read from the chat (gap or reset). */
        data object Reconcile : Effect
        data class Ended(val state: AidenRemoteRunEndState) : Effect
    }

    var lastSequence = 0
        private set
    var liveText = ""
        private set
    var reasoning = ""
        private set
    private val _tools = mutableListOf<AidenLiveTool>()
    val tools: List<AidenLiveTool> get() = _tools.map { it.copy() }
    var state = AidenStreamState.RUNNING
        private set
    private val _approvals = mutableListOf<AidenRemoteRunApproval>()
    val approvals: List<AidenRemoteRunApproval> get() = _approvals.toList()
    private val _questions = mutableListOf<AidenRemoteRunQuestion>()
    val questions: List<AidenRemoteRunQuestion> get() = _questions.toList()
    var endState: AidenRemoteRunEndState? = null
        private set
    private val locallyAnswered = mutableSetOf<String>()

    val isEnded: Boolean get() = endState != null
    val pendingApproval: AidenRemoteRunApproval? get() = _approvals.firstOrNull()
    val pendingQuestion: AidenRemoteRunQuestion? get() = _questions.firstOrNull()

    /** This phone answered [promptId]; its later resolution is not "elsewhere". */
    fun markAnsweredLocally(promptId: String) {
        locallyAnswered.add(promptId)
        dropPrompt(promptId)
    }

    /** This phone's answer to [promptId] was not confirmed. Nothing is resent,
     * but a later authoritative snapshot that still lists the prompt restores it. */
    fun answerUnconfirmed(promptId: String) {
        locallyAnswered.remove(promptId)
    }

    /** Drops a prompt another surface resolved first (a 409 loser). */
    fun dropPrompt(promptId: String) {
        _approvals.removeAll { it.approvalId == promptId }
        _questions.removeAll { it.promptId == promptId }
        refreshWaitingState()
    }

    fun apply(event: AidenRemoteRunEvent): List<Effect> {
        if (event.runId != runId || isEnded) return emptyList()
        when (event.kind) {
            // A gap snapshot rewinds the cursor to nextSequence - 1.
            is AidenRemoteRunEvent.Kind.Snapshot -> Unit
            is AidenRemoteRunEvent.Kind.Ended -> if (event.sequence < lastSequence) return emptyList()
            else -> if (event.sequence <= lastSequence) return emptyList()
        }
        lastSequence = event.sequence
        return when (val kind = event.kind) {
            is AidenRemoteRunEvent.Kind.Started -> {
                state = AidenStreamState.RUNNING
                emptyList()
            }
            is AidenRemoteRunEvent.Kind.Content -> applyContent(kind.event)
            is AidenRemoteRunEvent.Kind.ApprovalRequired -> {
                if (_approvals.any { it.approvalId == kind.approval.approvalId }) return emptyList()
                _approvals.add(kind.approval)
                state = AidenStreamState.WAITING_FOR_APPROVAL
                listOf(Effect.ApprovalRequired(kind.approval.approvalId))
            }
            is AidenRemoteRunEvent.Kind.ApprovalResolved -> {
                val wasPending = _approvals.removeAll { it.approvalId == kind.approvalId }
                refreshWaitingState()
                if (!wasPending || kind.approvalId in locallyAnswered) emptyList()
                else listOf(
                    Effect.AnsweredElsewhere(
                        AidenForeignRunResolution(AidenForeignRunResolution.Prompt.Approval(kind.decision), event.timestamp)
                    )
                )
            }
            is AidenRemoteRunEvent.Kind.QuestionRequired -> {
                if (_questions.any { it.promptId == kind.question.promptId }) return emptyList()
                _questions.add(kind.question)
                state = AidenStreamState.WAITING_FOR_APPROVAL
                listOf(Effect.QuestionRequired(kind.question.promptId))
            }
            is AidenRemoteRunEvent.Kind.QuestionResolved -> {
                val wasPending = _questions.removeAll { it.promptId == kind.promptId }
                refreshWaitingState()
                if (!wasPending || kind.promptId in locallyAnswered) emptyList()
                else listOf(
                    Effect.AnsweredElsewhere(
                        AidenForeignRunResolution(AidenForeignRunResolution.Prompt.Question(kind.outcome), event.timestamp)
                    )
                )
            }
            is AidenRemoteRunEvent.Kind.Snapshot -> {
                liveText = ""
                reasoning = ""
                _tools.clear()
                _approvals.clear()
                _approvals.addAll(kind.snapshot.approvals.filter { it.approvalId !in locallyAnswered })
                _questions.clear()
                _questions.addAll(kind.snapshot.questions.filter { it.promptId !in locallyAnswered })
                state = AidenStreamState.RECONCILING
                refreshWaitingState()
                listOf(Effect.Reconcile)
            }
            is AidenRemoteRunEvent.Kind.Ended -> {
                endState = kind.state
                _approvals.clear()
                _questions.clear()
                state = when (kind.state) {
                    AidenRemoteRunEndState.DONE -> AidenStreamState.DONE
                    AidenRemoteRunEndState.FAILED -> AidenStreamState.ERROR
                    AidenRemoteRunEndState.CANCELLED -> AidenStreamState.CANCELLED
                }
                listOf(Effect.Ended(kind.state))
            }
        }
    }

    private fun applyContent(event: AidenRemoteStreamEvent): List<Effect> {
        if (!event.shouldApply) return emptyList()
        val payload = event.payload ?: return emptyList()
        return when (event.type) {
            AidenRemoteEventType.STATUS -> {
                val next = streamStateFromWire(payload.state)
                if (next != null && !next.isTerminal) {
                    val prompting = _approvals.isNotEmpty() || _questions.isNotEmpty()
                    state = if (next == AidenStreamState.WAITING_FOR_APPROVAL || !prompting) next
                    else AidenStreamState.WAITING_FOR_APPROVAL
                }
                emptyList()
            }
            AidenRemoteEventType.TEXT_DELTA -> {
                val text = payload.text.orEmpty()
                liveText += text
                if (_approvals.isEmpty() && _questions.isEmpty()) state = AidenStreamState.RUNNING
                listOf(Effect.TextAppended(text))
            }
            AidenRemoteEventType.REASONING_DELTA -> {
                reasoning += payload.text.orEmpty()
                listOf(Effect.Reasoning)
            }
            AidenRemoteEventType.TOOL_STARTED -> {
                val id = payload.toolId ?: return emptyList()
                val name = payload.name ?: return emptyList()
                _tools.add(AidenLiveTool(id, name, null))
                listOf(Effect.ToolStarted(name))
            }
            AidenRemoteEventType.TOOL_FINISHED -> {
                _tools.firstOrNull { it.id == payload.toolId }?.status = payload.status
                listOf(Effect.ToolFinished)
            }
            AidenRemoteEventType.DONE, AidenRemoteEventType.ERROR, AidenRemoteEventType.CANCELLED -> {
                // `run.ended` follows with the same sequence and closes the run;
                // the content terminal only settles the visible state early.
                _approvals.clear()
                _questions.clear()
                state = when (event.type) {
                    AidenRemoteEventType.DONE -> AidenStreamState.DONE
                    AidenRemoteEventType.CANCELLED -> AidenStreamState.CANCELLED
                    else -> AidenStreamState.ERROR
                }
                emptyList()
            }
            else -> emptyList()
        }
    }

    private fun refreshWaitingState() {
        if (_approvals.isNotEmpty() || _questions.isNotEmpty()) {
            state = AidenStreamState.WAITING_FOR_APPROVAL
        } else if (state == AidenStreamState.WAITING_FOR_APPROVAL) {
            state = AidenStreamState.RUNNING
        }
    }

    private fun streamStateFromWire(raw: String?): AidenStreamState? = when (raw) {
        "queued" -> AidenStreamState.QUEUED
        "running" -> AidenStreamState.RUNNING
        "waiting_for_approval" -> AidenStreamState.WAITING_FOR_APPROVAL
        "reconciling" -> AidenStreamState.RECONCILING
        "done" -> AidenStreamState.DONE
        "error" -> AidenStreamState.ERROR
        "cancelled" -> AidenStreamState.CANCELLED
        "interrupted" -> AidenStreamState.INTERRUPTED
        else -> null
    }
}
