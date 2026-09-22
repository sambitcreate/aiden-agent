package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.io.File

class AidenWorkspaceEnvironmentTest {
    @Test fun cachedDocumentDoesNotDisableLiveTreePaging() {
        val cachedDocument = AidenWorkspaceFileAvailability(indexOffline = false, documentOffline = true)
        assertTrue(cachedDocument.canLoadPage)
        assertFalse(cachedDocument.canEditDocument)
        val cachedIndex = AidenWorkspaceFileAvailability(indexOffline = true, documentOffline = false)
        assertFalse(cachedIndex.canLoadPage)
        assertTrue(cachedIndex.canEditDocument)
    }

    @Test fun lazyTreeSearchAndPreviewStayBounded() {
        val entries = listOf(
            AidenWorkspaceFileEntry("dir", "src", "src", AidenWorkspaceFileKind.DIRECTORY),
            AidenWorkspaceFileEntry("file", "src/main.kt", "main.kt", AidenWorkspaceFileKind.FILE))
        assertEquals(listOf("dir"), AidenWorkspaceFileTree.visible(entries, emptySet(), "").map { it.id })
        assertEquals(2, AidenWorkspaceFileTree.visible(entries, setOf("src"), "").size)
        assertEquals(2, AidenWorkspaceFileTree.visible(entries, emptySet(), "main").size)
        assertTrue(AidenWorkspaceFileTree.visible(entries, emptySet(), "missing").isEmpty())
        assertEquals(2_001, AidenWorkspaceSourcePreview.lines("line\n".repeat(10_000)).size)
        assertTrue(AidenWorkspaceSourcePreview.lines("x".repeat(10_000))[0].endsWith("[line clipped]"))
    }

    @Test fun workspaceLinksRejectEscapesAndSchemes() {
        assertEquals("src/hello world.kt", AidenWorkspaceFileLink.path("./src/hello%20world.kt"))
        listOf("../secret", "./../secret", "./%2e%2e/secret", "./%2Fsecret", "file:///secret", "/secret", "~/secret", "https://example.com", "./a%00b", "./a\\b", "./a#L2", "./a?x=y", "./a//b").forEach {
            assertNull(it, AidenWorkspaceFileLink.path(it))
        }
    }

    @Test fun workspaceMarkdownLinksHaveClickableAnnotations() {
        val palette = sbtbiswas.AidenOnTheGo.config.AidenPalette("000000", "000000", "000000", "ffffff", "ffffff", "ffffff", "ffffff", "ffffff", "ffffff")
        val value = sbtbiswas.AidenOnTheGo.features.chat.buildAidenFormattedMessage("Open [source](./src/App.kt) and [blocked](./../secret)", palette, false)
        val links = value.getStringAnnotations("LINK", 0, value.length)
        assertEquals(listOf("./src/App.kt"), links.map { it.item })
        assertTrue(value.text.contains("Open source"))
    }

    @Test fun lazyPageContractRejectsMalformedScope() {
        val page = AidenWorkspaceFileIndex("page", emptyList(), false, 4_000, 20, directoryPath = "")
        assertEquals(page, AidenWorkspaceEnvironmentValidation.validatedPage(page))
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) { AidenWorkspaceEnvironmentValidation.validatedPage(page.copy(nextCursor = "../secret")) }
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) { AidenWorkspaceEnvironmentValidation.validatedPage(page.copy(directoryPath = "../secret")) }
    }

    @Test fun sharedLazyPageFixtureDecodes() {
        val fixture = javaClass.classLoader!!.getResourceAsStream("contract.json")!!.bufferedReader().use { it.readText() }
        val root = kotlinx.serialization.json.Json.parseToJsonElement(fixture) as kotlinx.serialization.json.JsonObject
        val page = kotlinx.serialization.json.Json.decodeFromString<AidenWorkspaceFileIndex>(root.getValue("filePage").toString())
        assertEquals(AidenWorkspaceFileKind.DIRECTORY, AidenWorkspaceEnvironmentValidation.validatedPage(page).entries.first().kind)
    }

    @Test fun relativeLinksCacheWithoutIndexAndSurvivePartialRefresh() {
        val cache = sbtbiswas.AidenOnTheGo.persistence.AidenWorkspaceEnvironmentCache(tempFolder.newFolder())
        val document = AidenWorkspaceFileDocument(validFileId, "src/App.kt", "cached", "v1", false)
        cache.store(document, "mac", "workspace")
        cache.store(AidenWorkspaceFileIndex("fresh", emptyList(), false, 4_000, 20, directoryPath = ""), "mac", "workspace")
        assertEquals(document, cache.document("./src/App.kt", "mac", "workspace"))
        assertNull(cache.document("./src/App.kt", "other", "workspace"))
        assertNull(cache.document("./../src/App.kt", "mac", "workspace"))
    }

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
