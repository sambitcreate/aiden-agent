package sbtbiswas.AidenOnTheGo.models

import androidx.compose.ui.graphics.Color
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.time.Instant

@Serializable
enum class AidenWorkspacePermission {
    @SerialName("full") FULL,
    @SerialName("ask") ASK,
    @SerialName("none") NONE;

    val title: String get() = when (this) {
        FULL -> "Full"
        ASK -> "Ask"
        NONE -> "None"
    }

    val detail: String get() = when (this) {
        FULL -> "Aiden can use this workspace's approved tools without asking for each ordinary action. Consequential Git actions still require confirmation."
        ASK -> "Aiden asks before actions that need approval in this workspace."
        NONE -> "Aiden can show existing chats but cannot use workspace tools."
    }
}

@Serializable
data class AidenWorkspaceGitSummary(
    val isRepo: Boolean = false,
    val branch: String? = null,
    val uncommitted: Int? = null
)

@Serializable
data class AidenWorkspace(
    val id: String,
    var name: String,
    var permission: AidenWorkspacePermission,
    var memoryEnabled: Boolean = true,
    val hasFolder: Boolean = false,
    val isManagedWorktree: Boolean = false,
    val branchName: String? = null,
    val repositoryName: String? = null,
    val git: AidenWorkspaceGitSummary? = null,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant? = null,
    @Serializable(with = InstantIso8601Serializer::class) var updatedAt: Instant? = null,
    val revision: String
)

@Serializable
data class AidenWorkspacePatch(
    val name: String? = null,
    val permission: AidenWorkspacePermission? = null,
    val memoryEnabled: Boolean? = null,
    val confirmedForeground: Boolean = true
)

@Serializable
data class AidenMemorySettings(
    val enabled: Boolean,
    val revision: String
)

@Serializable
data class AidenMemorySettingsMutation(
    val enabled: Boolean,
    val confirmedForeground: Boolean = true
)

@Serializable
data class AidenWorkspaceSelection(
    val selection: String,
    val displayName: String = "",
    @Serializable(with = InstantIso8601Serializer::class) val expiresAt: Instant
)

@Serializable
sealed class AidenWorkspaceCreate {
    @Serializable
    data class Folderless(
        val mode: String = "folderless",
        val name: String
    ) : AidenWorkspaceCreate()

    @Serializable
    data class Scratch(
        val mode: String = "scratch"
    ) : AidenWorkspaceCreate()

    @Serializable
    data class SelectedFolder(
        val mode: String = "selected-folder",
        val selection: String,
        val name: String? = null
    ) : AidenWorkspaceCreate()
}

@Serializable
data class AidenBrowserRoot(
    val id: String,
    val label: String,
    val location: String,
    val policyRevision: String = ""
)

@Serializable
data class AidenBrowserBreadcrumb(
    val label: String,
    val location: String
)

@Serializable
data class AidenBrowserEntry(
    val id: String,
    val name: String,
    val location: String
)

@Serializable
data class AidenBrowserPage(
    val rootId: String = "",
    val label: String = "",
    val breadcrumbs: List<AidenBrowserBreadcrumb> = emptyList(),
    val entries: List<AidenBrowserEntry> = emptyList(),
    val nextCursor: String? = null
)

@Serializable
enum class AidenWorkspaceFileKind {
    @SerialName("file") FILE,
    @SerialName("directory") DIRECTORY,
    @SerialName("symlink") SYMLINK
}

@Serializable
data class AidenWorkspaceFileEntry(
    val id: String,
    val displayPath: String,
    val name: String,
    val kind: AidenWorkspaceFileKind,
    val size: Int? = null,
    val language: String? = null
)

@Serializable
data class AidenWorkspaceFileIndex(
    val snapshotId: String,
    val entries: List<AidenWorkspaceFileEntry>,
    val truncated: Boolean,
    val maxEntries: Int,
    val maxDepth: Int
)

@Serializable
data class AidenWorkspaceFileDocument(
    val id: String,
    val displayPath: String,
    val content: String,
    val version: String,
    val truncated: Boolean,
    val warning: String? = null
)

@Serializable
data class AidenWorkspaceFileWriteRequest(
    val content: String,
    val expectedVersion: String
)

@Serializable
enum class AidenGitFileStatus {
    @SerialName("added") ADDED,
    @SerialName("modified") MODIFIED,
    @SerialName("deleted") DELETED,
    @SerialName("renamed") RENAMED,
    @SerialName("untracked") UNTRACKED,
    @SerialName("conflicted") CONFLICTED;

    val symbol: String get() = when (this) {
        ADDED -> "A"
        MODIFIED -> "M"
        DELETED -> "D"
        RENAMED -> "R"
        UNTRACKED -> "?"
        CONFLICTED -> "U"
    }

    val tint: Color get() = when (this) {
        ADDED, UNTRACKED -> Color(0xFF4CAF50)
        DELETED, CONFLICTED -> Color(0xFFE53935)
        MODIFIED, RENAMED -> Color(0xFFFF9800)
    }
}

@Serializable
data class AidenGitFile(
    val id: String,
    val displayPath: String,
    val status: AidenGitFileStatus,
    val staged: Boolean? = null,
    val additions: Int? = null,
    val deletions: Int? = null
)

@Serializable
data class AidenGitCapability(
    val allowed: Boolean,
    val reason: String? = null
)

@Serializable
data class AidenGitReview(
    val kind: String = "review",
    val branch: String,
    val uncommitted: Int,
    val files: List<AidenGitFile>
)

@Serializable
data class AidenGitDiff(
    val kind: String = "diff",
    val displayPath: String,
    val diff: String,
    val truncated: Boolean
) {
    val id: String get() = displayPath
}

@Serializable
data class AidenGitBranches(
    val kind: String = "branches",
    val current: String,
    val branches: List<String>
)

@Serializable
data class AidenGitComparison(
    val kind: String = "comparison",
    val comparisonId: String,
    val base: String,
    val head: String,
    val files: List<AidenGitFile>
)

@Serializable
data class AidenGitPushCapability(
    val kind: String = "push-capability",
    val allowed: Boolean,
    val reason: String? = null,
    val remote: String? = null,
    val branch: String? = null
)

@Serializable
data class AidenGitWorktree(
    val id: String,
    val name: String,
    val branch: String,
    val managed: Boolean
)

@Serializable
data class AidenGitWorktrees(
    val kind: String = "worktrees",
    val worktrees: List<AidenGitWorktree>
)

@Serializable
data class AidenGitMutation(
    val kind: String = "mutation",
    val message: String,
    val branch: String? = null,
    val commitId: String? = null,
    val workspaceId: String? = null,
    val warning: String? = null
)

@Serializable
enum class AidenGitOperationStatus {
    @SerialName("snapshot") SNAPSHOT,
    @SerialName("accepted") ACCEPTED,
    @SerialName("running") RUNNING,
    @SerialName("succeeded") SUCCEEDED,
    @SerialName("failed") FAILED,
    @SerialName("conflict") CONFLICT
}

@Serializable
data class AidenGitResult(
    val operationId: String,
    val status: AidenGitOperationStatus,
    val snapshotId: String? = null,
    val capability: AidenGitCapability? = null,
    val review: AidenGitReview? = null,
    val diff: AidenGitDiff? = null,
    val branches: AidenGitBranches? = null,
    val comparison: AidenGitComparison? = null,
    val pushCapability: AidenGitPushCapability? = null,
    val worktrees: AidenGitWorktrees? = null,
    val mutation: AidenGitMutation? = null,
    val result: AidenGitMutation? = null
)

object AidenWorkspaceEnvironmentValidation {
    fun opaqueFileID(value: String): Boolean = value.matches(Regex("^file_[A-Za-z0-9_-]{43}$"))
    fun safeDisplayPath(value: String): Boolean = value.isNotEmpty() && !value.startsWith("/") && !value.split("/").contains("..")

    fun validated(index: AidenWorkspaceFileIndex): AidenWorkspaceFileIndex {
        if (index.maxEntries != 4_000 || index.maxDepth != 20 || index.entries.size > index.maxEntries ||
            !index.entries.all { opaqueFileID(it.id) && safeDisplayPath(it.displayPath) && it.name.isNotEmpty() }
        ) {
            throw AidenRemoteClientException.InvalidResponse()
        }
        return index
    }

    fun validated(document: AidenWorkspaceFileDocument, expectedId: String): AidenWorkspaceFileDocument {
        if (document.id != expectedId || !opaqueFileID(document.id) || !safeDisplayPath(document.displayPath) ||
            document.version.isEmpty() || document.truncated
        ) {
            throw AidenRemoteClientException.InvalidResponse()
        }
        return document
    }

    fun validated(git: AidenGitResult): AidenGitResult {
        if (!git.operationId.startsWith("op_") || git.operationId.length > 128) {
            throw AidenRemoteClientException.InvalidResponse()
        }
        val validFiles: (List<AidenGitFile>) -> Boolean = { files ->
            files.size <= 4_000 && files.all {
                opaqueFileID(it.id) && safeDisplayPath(it.displayPath)
            }
        }
        git.review?.let { review ->
            if (git.snapshotId == null || !validFiles(review.files) || review.uncommitted < 0) {
                throw AidenRemoteClientException.InvalidResponse()
            }
        }
        git.diff?.let { diff ->
            if (git.snapshotId == null || !safeDisplayPath(diff.displayPath) || diff.diff.length > 2_000_000) {
                throw AidenRemoteClientException.InvalidResponse()
            }
        }
        if (git.branches != null && git.snapshotId == null) {
            throw AidenRemoteClientException.InvalidResponse()
        }
        git.comparison?.let { comparison ->
            if (git.snapshotId != comparison.comparisonId || !validFiles(comparison.files)) {
                throw AidenRemoteClientException.InvalidResponse()
            }
        }
        if (git.pushCapability != null && git.snapshotId == null) {
            throw AidenRemoteClientException.InvalidResponse()
        }
        git.worktrees?.let { worktrees ->
            if (!worktrees.worktrees.all { it.id.isNotEmpty() && it.name.isNotEmpty() && it.branch.isNotEmpty() }) {
                throw AidenRemoteClientException.InvalidResponse()
            }
        }
        return git
    }
}
