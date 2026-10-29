package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException

/**
 * Contract revision 48 (`chat:new-worktree`): the first message of an empty Workspace chat can
 * start it in a new worktree on the Mac. The Mac picks the base the way a desktop draft does and
 * names the branch from the message. The words match the Mac and iPhone.
 */
object AidenNewWorktreeCopy {
    const val TOGGLE = "New worktree"
    const val SETTING_UP = "Setting up worktree…"
    const val HINT = "Your first message starts this chat in its own worktree on your Mac."
}

/** The empty chat, now in its new worktree's workspace, and the worktree's branch. */
data class AidenChatNewWorktree(val chat: AidenChat, val branch: String) {
    companion object {
        /** The server's `AIDEN_REMOTE_MAX_NEW_WORKTREE_TEXT`. */
        const val MAX_TEXT_LENGTH = 4_000
        const val MAX_BRANCH_LENGTH = 200

        private val json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }

        /** Exactly `{chat, branch}`, for the chat that was asked about, still empty. */
        fun decode(body: String, chatId: String): AidenChatNewWorktree {
            val root = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()
                ?: throw AidenRemoteClientException.InvalidResponse()
            val branch = (root["branch"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val chatJson = root["chat"] as? JsonObject
            if (root.keys != setOf("chat", "branch") || branch == null || chatJson == null ||
                branch.isBlank() || branch.length > MAX_BRANCH_LENGTH
            ) {
                throw AidenRemoteClientException.InvalidResponse()
            }
            val chat = runCatching { json.decodeFromJsonElement(AidenChat.serializer(), chatJson) }.getOrNull()
                ?: throw AidenRemoteClientException.InvalidResponse()
            if (chat.id != chatId || chat.messages.isNotEmpty() || chat.isBotChat) {
                throw AidenRemoteClientException.InvalidResponse()
            }
            return AidenChatNewWorktree(chat, branch)
        }
    }
}

/** Whether the phone offers New worktree for a chat. */
object AidenNewWorktreeAvailability {
    /**
     * Offered for an empty Workspace chat whose workspace has a folder Aiden may use and is not
     * already a worktree, while [server] offers and this phone holds `chat:new-worktree`,
     * `git:write` and `chat:write`. [hasCommits] is what a `git:read` branch list showed: false
     * (not a repository, or no commits yet) hides it, and null (not read) leaves the Mac to
     * refuse with its own reason.
     */
    fun isOffered(chat: AidenChat?, workspace: AidenWorkspace?, server: AidenServer?, hasCommits: Boolean?): Boolean {
        if (chat == null || chat.isBotChat || chat.messages.isNotEmpty()) return false
        if (workspace == null || workspace.id != chat.workspaceId) return false
        if (!workspace.hasFolder || workspace.isManagedWorktree || workspace.permission == AidenWorkspacePermission.NONE) return false
        if (server?.supportsNewWorktrees != true) return false
        return hasCommits != false
    }

    /**
     * A branch list from `GET /workspaces/{id}/git/branches`: a folder that is not a repository,
     * or a repository with no commits, lists none.
     */
    fun hasCommits(result: AidenGitResult): Boolean? = result.branches?.let { it.branches.isNotEmpty() }
}
