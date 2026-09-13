package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.protocol.AidenRawJsonDuplicateKeyScanner
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException

@Serializable
data class AidenWorkspaceSubagents(
    val version: Int,
    val workspaceId: String,
    val chatId: String,
    val runs: List<AidenWorkspaceSubagent>,
    val truncated: Boolean
) {
    companion object {
        const val FEATURE = "workspace-subagents-v1"
        private val runId = Regex("run_[A-Za-z0-9_-]{43}")
        private val roles = setOf("scout", "planner", "reviewer")
        private val states = setOf("queued", "starting", "running", "completed", "failed", "timed_out", "interrupted", "needs_attention", "stopped", "unknown")
        fun decode(bytes: ByteArray, workspaceId: String, chatId: String): AidenWorkspaceSubagents {
            AidenRawJsonDuplicateKeyScanner.validate(bytes)
            val result = Json.decodeFromString<AidenWorkspaceSubagents>(bytes.toString(Charsets.UTF_8))
            if (result.version != 1 || result.workspaceId != workspaceId || result.chatId != chatId ||
                result.runs.size > 100 || result.runs.map { it.id }.toSet().size != result.runs.size ||
                result.runs.any {
                    !runId.matches(it.id) || it.role !in roles || it.state !in states ||
                    it.label.isBlank() || it.label.codePointCount(0, it.label.length) > 80 || it.label.any(Character::isISOControl) ||
                    it.revision !in 1..9_007_199_254_740_991L ||
                    it.startedAt !in 0..9_007_199_254_740_991L || it.updatedAt !in it.startedAt..9_007_199_254_740_991L
                }) throw AidenRemoteContractException.InvalidJson("Invalid workspace subagent projection")
            return result
        }
    }
}

@Serializable
data class AidenWorkspaceSubagent(
    val id: String,
    val label: String,
    val role: String,
    val state: String,
    val revision: Long,
    val startedAt: Long,
    val updatedAt: Long
)
