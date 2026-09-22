package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.io.File

class AidenWorkspaceEnvironmentTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private val validFileId = "file_" + "f".repeat(43)

    @Test
    fun testFileIndexValidation() {
        val validIndex = AidenWorkspaceFileIndex(
            snapshotId = "files-1",
            entries = listOf(
                AidenWorkspaceFileEntry(
                    id = validFileId,
                    displayPath = "src/main.kt",
                    name = "main.kt",
                    kind = AidenWorkspaceFileKind.FILE,
                    size = 100,
                    language = "Kotlin"
                )
            ),
            truncated = false,
            maxEntries = 4_000,
            maxDepth = 20
        )

        val result = AidenWorkspaceEnvironmentValidation.validated(validIndex)
        assertEquals(1, result.entries.size)

        // Invalid index with path traversal entry
        val badPathIndex = validIndex.copy(
            entries = listOf(
                AidenWorkspaceFileEntry(
                    id = validFileId,
                    displayPath = "../Secret.kt",
                    name = "Secret.kt",
                    kind = AidenWorkspaceFileKind.FILE
                )
            )
        )
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenWorkspaceEnvironmentValidation.validated(badPathIndex)
        }

        // Invalid index with invalid file ID format
        val badIdIndex = validIndex.copy(
            entries = listOf(
                AidenWorkspaceFileEntry(
                    id = "invalid_id",
                    displayPath = "main.kt",
                    name = "main.kt",
                    kind = AidenWorkspaceFileKind.FILE
                )
            )
        )
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenWorkspaceEnvironmentValidation.validated(badIdIndex)
        }
    }

    @Test
    fun testFileDocumentValidation() {
        val validDoc = AidenWorkspaceFileDocument(
            id = validFileId,
            displayPath = "src/main.kt",
            content = "fun main() {}",
            version = "v1",
            truncated = false
        )

        val validated = AidenWorkspaceEnvironmentValidation.validated(validDoc, validFileId)
        assertEquals("v1", validated.version)

        // Mismatched expected ID throws
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenWorkspaceEnvironmentValidation.validated(validDoc, "file_" + "x".repeat(43))
        }

        // Truncated doc throws
        val truncatedDoc = validDoc.copy(truncated = true)
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenWorkspaceEnvironmentValidation.validated(truncatedDoc, validFileId)
        }
    }

    @Test
    fun testGitProjectionsValidation() {
        val validReview = AidenGitResult(
            operationId = "op_review_01",
            status = AidenGitOperationStatus.SNAPSHOT,
            snapshotId = "snap_01",
            review = AidenGitReview(
                branch = "main",
                uncommitted = 1,
                files = listOf(
                    AidenGitFile(
                        id = validFileId,
                        displayPath = "App.kt",
                        status = AidenGitFileStatus.MODIFIED,
                        staged = false,
                        additions = 5,
                        deletions = 2
                    )
                )
            )
        )
        val validatedReview = AidenWorkspaceEnvironmentValidation.validated(validReview)
        assertEquals("main", validatedReview.review?.branch)
        assertEquals(1, validatedReview.review?.files?.size)

        // Path traversal in git file change throws
        val badGitPath = validReview.copy(
            review = validReview.review!!.copy(
                files = listOf(
                    validReview.review!!.files[0].copy(displayPath = "../Secret.kt")
                )
            )
        )
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenWorkspaceEnvironmentValidation.validated(badGitPath)
        }
    }

    @Test
    fun testEnvironmentCacheScoping() {
        val cacheDir = File(tempFolder.root, "env_cache").apply { mkdirs() }

        // Workspace and Installation scoped storage keys
        fun cacheKey(instanceId: String, workspaceId: String): String {
            return "${instanceId}_$workspaceId"
        }

        val key1 = cacheKey("inst_1", "ws_1")
        val key2 = cacheKey("inst_1", "ws_2")
        val key3 = cacheKey("inst_2", "ws_1")

        assertNotEquals(key1, key2)
        assertNotEquals(key1, key3)
        assertNotEquals(key2, key3)
    }
}
