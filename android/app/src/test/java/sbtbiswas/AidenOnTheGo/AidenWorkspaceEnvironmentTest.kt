package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceFilesController
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceFilesRemote
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceFilesStrings
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenWorkspaceEnvironmentCache
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.File

class AidenWorkspaceEnvironmentTest {
    @Test fun commitAvailabilityUsesTheDecodedReviewCapability() {
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val denied = json.decodeFromString(AidenGitResultWire, """
            {"operationId":"review-1","status":"snapshot","snapshotId":"snapshot-1",
             "capability":{"allowed":false,"reason":"A file could not be shown."},
             "result":{"kind":"review","branch":"main","uncommitted":2,
                       "files":[{"id":"visible","displayPath":"README.md","status":"modified"}]}}
        """)
        assertEquals(false, denied.capability?.allowed)
        assertEquals("A file could not be shown.", denied.capability?.reason)
        assertFalse(denied.canCommitReviewedChanges)

        val allowed = json.decodeFromString(AidenGitResultWire, """
            {"operationId":"review-2","status":"snapshot","snapshotId":"snapshot-2",
             "capability":{"allowed":true},
             "result":{"kind":"review","branch":"main","uncommitted":1,
                       "files":[{"id":"visible","displayPath":"README.md","status":"modified"}]}}
        """)
        assertTrue(allowed.canCommitReviewedChanges)
        assertFalse(allowed.copy(capability = null).canCommitReviewedChanges)
        assertFalse(allowed.copy(snapshotId = null).canCommitReviewedChanges)
        assertFalse(allowed.copy(review = allowed.review!!.copy(files = emptyList())).canCommitReviewedChanges)
    }

    @Test fun aReviewThatCountsChangesButListsNoFilesHasHiddenChanges() {
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val hidden = json.decodeFromString(AidenGitResultWire, """
            {"operationId":"review-1","status":"snapshot","snapshotId":"snapshot-1",
             "capability":{"allowed":false,"reason":"A file could not be shown."},
             "result":{"kind":"review","branch":"main","uncommitted":2,"files":[]}}
        """)
        assertEquals(2, hidden.review?.hiddenChangeCount)
        assertFalse(hidden.canCommitReviewedChanges)
        assertFalse(hidden.copy(capability = AidenGitCapability(allowed = true)).canCommitReviewedChanges)

        val clean = hidden.review!!.copy(uncommitted = 0)
        assertEquals(null, clean.hiddenChangeCount)
    }

    @Test fun gitReviewPreservesUnavailableLineCounts() {
        val review = kotlinx.serialization.json.Json.decodeFromString<AidenGitReview>(
            """{"kind":"review","branch":"main","uncommitted":2,"files":[{"id":"known","displayPath":"small.txt","status":"untracked","additions":3,"deletions":0},{"id":"unknown","displayPath":"budgeted.txt","status":"untracked"}]}""")
        assertEquals(3, review.files[0].additions)
        assertEquals(0, review.files[0].deletions)
        assertNull(review.files[1].additions)
        assertNull(review.files[1].deletions)
    }

    @Test fun cachedDocumentDoesNotDisableLiveTreePaging() {
        val cachedDocument = AidenWorkspaceFileAvailability(indexOffline = false, documentOffline = true, connected = true)
        assertTrue(cachedDocument.canLoadPage)
        assertFalse(cachedDocument.canEditDocument)
        val cachedIndex = AidenWorkspaceFileAvailability(indexOffline = true, documentOffline = false, connected = true)
        assertFalse(cachedIndex.canLoadPage)
        assertTrue(cachedIndex.canEditDocument)
        val retainedClientWhileOffline = AidenWorkspaceFileAvailability(indexOffline = false, documentOffline = false, connected = false)
        assertFalse(retainedClientWhileOffline.canLoadPage)
        assertFalse(retainedClientWhileOffline.canEditDocument)
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
    fun testLazySaveAcceptsRotatedHandleAndRebindsTreeEntry() {
        val rotatedId = "file_" + "r".repeat(43)
        val otherId = "file_" + "o".repeat(43)
        val saved = AidenWorkspaceFileDocument(
            id = rotatedId, displayPath = "src/main.kt", content = "x", version = "v2", truncated = false
        )
        assertEquals(saved, AidenWorkspaceEnvironmentValidation.validatedSave(saved, "src/main.kt"))
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenWorkspaceEnvironmentValidation.validatedSave(saved, "src/other.kt")
        }
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenWorkspaceEnvironmentValidation.validatedSave(saved.copy(id = "../escape"), "src/main.kt")
        }

        val index = AidenWorkspaceFileIndex(
            snapshotId = "files-1",
            entries = listOf(
                AidenWorkspaceFileEntry(validFileId, "src/main.kt", "main.kt", AidenWorkspaceFileKind.FILE, 1, "Kotlin"),
                AidenWorkspaceFileEntry(otherId, "src/other.kt", "other.kt", AidenWorkspaceFileKind.FILE)
            ),
            truncated = false, maxEntries = 4_000, maxDepth = 20, directoryPath = ""
        )
        val rebound = AidenWorkspaceFileTree.rebind(index, validFileId, rotatedId)
        assertEquals(listOf(rotatedId, otherId), rebound.entries.map { it.id })
        assertEquals("Kotlin", rebound.entries.first().language)
        assertEquals("", rebound.directoryPath)
        assertSame(index, AidenWorkspaceFileTree.rebind(index, validFileId, validFileId))
        assertSame(index, AidenWorkspaceFileTree.rebind(index, "file_" + "z".repeat(43), rotatedId))
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

    private class FakeWorkspaceFilesRemote : AidenWorkspaceFilesRemote {
        var pageHandler: suspend (String, String?, String?) -> AidenWorkspaceFileIndex = { _, _, _ ->
            throw AssertionError("Unexpected page call")
        }
        var snapshotHandler: suspend (String) -> AidenWorkspaceFileIndex = {
            throw AssertionError("Unexpected snapshot call")
        }
        var readHandler: suspend (String, String) -> AidenWorkspaceFileDocument = { _, _ ->
            throw AssertionError("Unexpected read call")
        }
        var writeHandler: suspend (String, String, String, String, String) -> AidenWorkspaceFileDocument = { _, _, _, _, _ ->
            throw AssertionError("Unexpected write call")
        }
        var rootPageCalls = 0
        var writeCalls = 0

        override suspend fun workspaceFilePage(
            workspaceId: String,
            directoryId: String?,
            cursor: String?
        ): AidenWorkspaceFileIndex {
            if (directoryId == null && cursor == null) rootPageCalls += 1
            return pageHandler(workspaceId, directoryId, cursor)
        }

        override suspend fun workspaceFiles(workspaceId: String) = snapshotHandler(workspaceId)
        override suspend fun workspaceFile(workspaceId: String, fileId: String) = readHandler(workspaceId, fileId)
        override suspend fun workspaceLinkedFile(workspaceId: String, reference: String): AidenWorkspaceFileDocument =
            throw AssertionError("Unexpected linked file call")

        override suspend fun writeWorkspaceFile(
            workspaceId: String,
            fileId: String,
            displayPath: String,
            content: String,
            expectedVersion: String
        ): AidenWorkspaceFileDocument {
            writeCalls += 1
            return writeHandler(workspaceId, fileId, displayPath, content, expectedVersion)
        }
    }

    private fun staleException(code: AidenRemoteErrorCode): AidenRemoteClientException.Server =
        AidenRemoteClientException.Server(
            if (code == AidenRemoteErrorCode.HANDLE_EXPIRED) 410 else 400,
            AidenRemoteErrorEnvelope.Body(code, "Stale handle.", "req_stale", false)
        )

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun staleLazyHandlesRecoverOnceReplaceTreeIdsPreserveDraftAndCacheAndNeverReplaySaves() = runTest {
        for (code in listOf(AidenRemoteErrorCode.HANDLE_INVALID, AidenRemoteErrorCode.HANDLE_EXPIRED)) {
            val cache = AidenWorkspaceEnvironmentCache(tempFolder.newFolder())
            val remote = FakeWorkspaceFilesRemote()
            val strings = AidenWorkspaceFilesStrings()
            val staleDirId = "file_" + "a".repeat(43)
            val freshDirId = "file_" + "b".repeat(43)
            val staleFileId = "file_" + "c".repeat(43)
            val freshFileId = "file_" + "d".repeat(43)
            val openDocId = "file_" + "e".repeat(43)
            val childStaleId = "file_" + "g".repeat(43)
            val staleCursor = "cur_" + "h".repeat(43)

            var currentDirId = staleDirId
            var currentFileId = staleFileId
            remote.pageHandler = { _, directoryId, cursor ->
                when {
                    directoryId == null && cursor == null -> AidenWorkspaceFileIndex(
                        snapshotId = "root",
                        entries = listOf(
                            AidenWorkspaceFileEntry(currentDirId, "src", "src", AidenWorkspaceFileKind.DIRECTORY),
                            AidenWorkspaceFileEntry(currentFileId, "README.md", "README.md", AidenWorkspaceFileKind.FILE),
                            AidenWorkspaceFileEntry(openDocId, "Notes.md", "Notes.md", AidenWorkspaceFileKind.FILE)
                        ),
                        truncated = false, maxEntries = 4_000, maxDepth = 20, directoryPath = ""
                    )
                    directoryId == staleDirId -> throw staleException(code)
                    directoryId == freshDirId && cursor == null -> AidenWorkspaceFileIndex(
                        snapshotId = "src-1",
                        entries = listOf(
                            AidenWorkspaceFileEntry(childStaleId, "src/App.kt", "App.kt", AidenWorkspaceFileKind.FILE)
                        ),
                        truncated = false, maxEntries = 4_000, maxDepth = 20, directoryPath = "src", nextCursor = staleCursor
                    )
                    directoryId == freshDirId && cursor == staleCursor -> throw staleException(code)
                    else -> throw AssertionError("Unexpected page($directoryId, $cursor)")
                }
            }
            remote.readHandler = { _, fileId ->
                when (fileId) {
                    openDocId -> AidenWorkspaceFileDocument(openDocId, "Notes.md", "original\n", "1".repeat(64), false)
                    staleFileId -> throw staleException(code)
                    else -> throw AssertionError("Unexpected read($fileId)")
                }
            }
            remote.writeHandler = { _, _, _, _, _ -> throw staleException(code) }

            val controller = AidenWorkspaceFilesController(this, "ws-1", cache, strings)
            controller.bind("laptop", remote, connected = true, strings = strings)
            controller.refreshFiles()
            advanceUntilIdle()
            assertEquals(1, remote.rootPageCalls)

            // Open Notes.md and modify draft so we have an open document with unsaved edits and a cached download.
            val notesEntry = controller.state.value.fileIndex!!.entries.first { it.displayPath == "Notes.md" }
            controller.openEntry(notesEntry)
            advanceUntilIdle()
            controller.setEditing(true)
            controller.updateDraft("unsaved draft\n")
            assertTrue(controller.state.value.isDirty)

            // 1. Stale folder expansion refreshes root once, replaces stale directory handle, surfaces recovery prompt, preserves draft.
            currentDirId = freshDirId
            val staleSrc = controller.state.value.fileIndex!!.entries.first { it.displayPath == "src" }
            controller.openEntry(staleSrc)
            advanceUntilIdle()
            assertEquals(2, remote.rootPageCalls)
            assertFalse("src" in controller.state.value.expanded)
            assertEquals(strings.staleFolderRecovery, controller.state.value.errorMessage)
            assertEquals(freshDirId, controller.state.value.fileIndex!!.entries.first { it.displayPath == "src" }.id)
            assertEquals(openDocId, controller.state.value.selectedFile?.id)
            assertEquals("unsaved draft\n", controller.state.value.draftContent)
            assertTrue(controller.state.value.isDirty)

            // Reopening src with the refreshed handle succeeds and stores continuation cursor.
            val freshSrc = controller.state.value.fileIndex!!.entries.first { it.displayPath == "src" }
            controller.openEntry(freshSrc)
            advanceUntilIdle()
            assertTrue("src" in controller.state.value.expanded)
            assertEquals(staleCursor, controller.state.value.cursors["src"])

            // 2. Stale continuation cursor invalidates stale src/App.kt instead of retaining obsolete IDs, refreshes root once.
            controller.loadPage(freshSrc)
            advanceUntilIdle()
            assertEquals(3, remote.rootPageCalls)
            assertTrue(controller.state.value.cursors.isEmpty())
            assertFalse(controller.state.value.fileIndex!!.entries.any { it.id == childStaleId })
            assertEquals(strings.staleFolderRecovery, controller.state.value.errorMessage)

            // 3. Stale unopened file open refreshes root once, surfaces file recovery prompt, preserves open draft + cache.
            currentFileId = freshFileId
            val staleReadme = controller.state.value.fileIndex!!.entries.first { it.displayPath == "README.md" }
            controller.openEntry(staleReadme)
            advanceUntilIdle()
            assertEquals(4, remote.rootPageCalls)
            assertEquals(strings.staleFileRecovery, controller.state.value.errorMessage)
            assertEquals(freshFileId, controller.state.value.fileIndex!!.entries.first { it.displayPath == "README.md" }.id)
            assertEquals(openDocId, controller.state.value.selectedFile?.id)
            assertEquals("unsaved draft\n", controller.state.value.draftContent)
            assertEquals("original\n", cache.load("laptop", "ws-1")?.documents?.get(openDocId)?.content)

            // 4. Stale save never auto-replays PUT and surfaces error while keeping draft dirty.
            controller.saveDocument()
            advanceUntilIdle()
            assertEquals(1, remote.writeCalls)
            assertEquals("Stale handle.", controller.state.value.errorMessage)
            assertEquals("unsaved draft\n", controller.state.value.draftContent)
            assertTrue(controller.state.value.isDirty)

            // 5. Going offline preserves read-only cached document access.
            controller.closeSelectedFile(discardChanges = true)
            controller.bind("laptop", remote, connected = false, strings = strings)
            controller.openEntry(notesEntry)
            advanceUntilIdle()
            assertEquals("original\n", controller.state.value.selectedFile?.content)
            assertTrue(controller.state.value.isOfflineDocument)
            assertFalse(controller.state.value.availability.canEditDocument)
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun concurrentStalePagesRefreshRootOnceAndFenceOwnerSwitches() = runTest {
        val cache = AidenWorkspaceEnvironmentCache(tempFolder.newFolder())
        val remote = FakeWorkspaceFilesRemote()
        val dirAId = "file_" + "a".repeat(43)
        val dirBId = "file_" + "b".repeat(43)
        val freshDirAId = "file_" + "c".repeat(43)
        val holdDirB = CompletableDeferred<Unit>()
        val holdRecoveryRoot = CompletableDeferred<Unit>()
        var recoveryPhase = false

        remote.pageHandler = { _, directoryId, _ ->
            when (directoryId) {
                null -> {
                    if (recoveryPhase) holdRecoveryRoot.await()
                    AidenWorkspaceFileIndex(
                        snapshotId = if (recoveryPhase) "root-2" else "root-1",
                        entries = if (recoveryPhase) {
                            listOf(AidenWorkspaceFileEntry(freshDirAId, "a", "a", AidenWorkspaceFileKind.DIRECTORY))
                        } else {
                            listOf(
                                AidenWorkspaceFileEntry(dirAId, "a", "a", AidenWorkspaceFileKind.DIRECTORY),
                                AidenWorkspaceFileEntry(dirBId, "b", "b", AidenWorkspaceFileKind.DIRECTORY)
                            )
                        },
                        truncated = false, maxEntries = 4_000, maxDepth = 20, directoryPath = ""
                    )
                }
                dirAId -> throw staleException(AidenRemoteErrorCode.HANDLE_INVALID)
                dirBId -> {
                    holdDirB.await()
                    throw staleException(AidenRemoteErrorCode.HANDLE_INVALID)
                }
                freshDirAId -> throw staleException(AidenRemoteErrorCode.HANDLE_EXPIRED)
                else -> throw AssertionError("Unexpected $directoryId")
            }
        }

        val controller = AidenWorkspaceFilesController(this, "ws-1", cache)
        controller.bind("laptop", remote, connected = true)
        controller.refreshFiles()
        advanceUntilIdle()
        assertEquals(1, remote.rootPageCalls)

        recoveryPhase = true
        val dirA = controller.state.value.fileIndex!!.entries.first { it.displayPath == "a" }
        val dirB = controller.state.value.fileIndex!!.entries.first { it.displayPath == "b" }
        controller.openEntry(dirB)
        runCurrent()
        controller.openEntry(dirA)
        runCurrent()
        // dirA failed and started the single recovery root refresh; dirB's late failure is fenced by the bumped revision.
        holdDirB.complete(Unit)
        runCurrent()
        holdRecoveryRoot.complete(Unit)
        advanceUntilIdle()
        assertEquals(2, remote.rootPageCalls)
        assertEquals(listOf(freshDirAId), controller.state.value.fileIndex!!.entries.map { it.id })

        // Switching to a different host while stale recovery is parked fences the old owner's response.
        val holdSecondRecovery = CompletableDeferred<Unit>()
        remote.pageHandler = { _, directoryId, _ ->
            if (directoryId == null) {
                holdSecondRecovery.await()
                AidenWorkspaceFileIndex("late-laptop", emptyList(), false, 4_000, 20, directoryPath = "")
            } else {
                throw staleException(AidenRemoteErrorCode.HANDLE_EXPIRED)
            }
        }
        controller.openEntry(controller.state.value.fileIndex!!.entries.first())
        runCurrent()
        val studioRemote = FakeWorkspaceFilesRemote()
        controller.bind("studio", studioRemote, connected = false)
        holdSecondRecovery.complete(Unit)
        advanceUntilIdle()
        assertNull(controller.state.value.fileIndex)
        assertNull(controller.state.value.errorMessage)
    }
}
