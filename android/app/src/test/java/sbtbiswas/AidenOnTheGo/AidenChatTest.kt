package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import java.io.File
import java.time.Instant
import java.util.Base64
import java.util.UUID

class AidenChatTest {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Test
    fun testPolymorphicAttachmentUploads() {
        val imageUpload: AidenAttachmentUpload = AidenAttachmentUpload.Image(
            name = "photo.png",
            mimeType = "image/png",
            data = "AQID"
        )
        val imageJson = json.encodeToString(imageUpload)
        assertTrue(imageJson.contains("\"kind\":\"image\""))
        assertTrue(imageJson.contains("\"name\":\"photo.png\""))
        assertTrue(imageJson.contains("\"data\":\"AQID\""))

        val textUpload: AidenAttachmentUpload = AidenAttachmentUpload.Text(
            name = "notes.txt",
            mimeType = "text/plain",
            text = "Hello world"
        )
        val textJson = json.encodeToString(textUpload)
        assertTrue(textJson.contains("\"kind\":\"text\""))
        assertTrue(textJson.contains("\"name\":\"notes.txt\""))
        assertTrue(textJson.contains("\"text\":\"Hello world\""))

        val decodedImage = json.decodeFromString<AidenAttachmentUpload>(imageJson)
        assertTrue(decodedImage is AidenAttachmentUpload.Image)
        assertEquals("photo.png", decodedImage.name)

        val decodedText = json.decodeFromString<AidenAttachmentUpload>(textJson)
        assertTrue(decodedText is AidenAttachmentUpload.Text)
        assertEquals("Hello world", (decodedText as AidenAttachmentUpload.Text).text)
    }

    @Test
    fun testAttachmentWireValidation() {
        val validAttachment = AidenMessageAttachment(
            id = "att_valid_123",
            name = "diagram.png",
            mimeType = "image/png",
            kind = AidenAttachmentKind.IMAGE,
            size = 1024
        )
        assertTrue(validAttachment.isWireSafe)

        val invalidPathName = AidenMessageAttachment(
            id = "att_valid_123",
            name = "../etc/passwd",
            mimeType = "text/plain",
            kind = AidenAttachmentKind.TEXT,
            size = 1024
        )
        assertFalse(invalidPathName.isWireSafe)

        val emptyName = AidenMessageAttachment(
            id = "att_1",
            name = "",
            mimeType = "text/plain",
            kind = AidenAttachmentKind.TEXT,
            size = 100
        )
        assertFalse(emptyName.isWireSafe)

        val negativeSize = AidenMessageAttachment(
            id = "att_1",
            name = "valid.txt",
            mimeType = "text/plain",
            kind = AidenAttachmentKind.TEXT,
            size = -1
        )
        assertFalse(negativeSize.isWireSafe)
    }

    @Test
    fun testTimelineRendererSafetyWithLineChangesAndClaimCheck() {
        val validTimeline = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_123",
            status = AidenGenerationTimelineStatus.COMPLETED,
            startedAt = 1000.0,
            finishedAt = 2000.0,
            steps = listOf(
                AidenAgentStep(
                    id = "tool-1",
                    order = 0,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-1",
                    toolName = "write_file",
                    label = "Write file",
                    status = AidenAgentStepStatus.COMPLETED,
                    startedAt = 1000.0,
                    updatedAt = 1500.0,
                    finishedAt = 1500.0,
                    contentOffset = 0,
                    target = "README.md",
                    lineChanges = AidenAgentLineChanges(additions = 10, deletions = 2)
                )
            )
        )
        assertTrue(validTimeline.isRendererSafe())

        // Line changes on non-completed status must fail
        val nonCompletedLineChanges = validTimeline.copy(
            steps = listOf(
                validTimeline.steps[0].copy(status = AidenAgentStepStatus.RUNNING)
            )
        )
        assertFalse(nonCompletedLineChanges.isRendererSafe())

        // Line changes out of 0..100M bound must fail
        val negativeLineChanges = validTimeline.copy(
            steps = listOf(
                validTimeline.steps[0].copy(lineChanges = AidenAgentLineChanges(-1, 0))
            )
        )
        assertFalse(negativeLineChanges.isRendererSafe())

        // Claim check with running status must fail
        val runningWithClaimCheck = validTimeline.copy(
            status = AidenGenerationTimelineStatus.RUNNING,
            claimCheck = AidenGenerationClaimCheck(
                kind = AidenGenerationClaimCheck.Kind.UNVERIFIED_SUCCESS,
                stepIds = listOf("tool-1")
            )
        )
        assertFalse(runningWithClaimCheck.isRendererSafe())

        // Claim check pointing to non-issue step must fail
        val completedWithInvalidClaimCheck = validTimeline.copy(
            status = AidenGenerationTimelineStatus.COMPLETED,
            claimCheck = AidenGenerationClaimCheck(
                kind = AidenGenerationClaimCheck.Kind.UNVERIFIED_SUCCESS,
                stepIds = listOf("tool-1")
            )
        )
        assertFalse(completedWithInvalidClaimCheck.isRendererSafe())

        // Claim check pointing to actual failed/issue tool step succeeds
        val failedStepTimeline = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_failed",
            status = AidenGenerationTimelineStatus.FAILED,
            startedAt = 1000.0,
            finishedAt = 2000.0,
            steps = listOf(
                AidenAgentStep(
                    id = "tool-1",
                    order = 0,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-1",
                    toolName = "run_command",
                    label = "Run command",
                    status = AidenAgentStepStatus.FAILED,
                    startedAt = 1000.0,
                    updatedAt = 1500.0,
                    finishedAt = 1500.0,
                    contentOffset = 0
                )
            ),
            claimCheck = AidenGenerationClaimCheck(
                kind = AidenGenerationClaimCheck.Kind.UNVERIFIED_SUCCESS,
                stepIds = listOf("tool-1")
            )
        )
        assertTrue(failedStepTimeline.isRendererSafe())
    }

    @Test
    fun testTimelineRejectsUnsafeTargets() {
        val baseStep = AidenAgentStep(
            id = "tool-1",
            order = 0,
            kind = AidenAgentStep.Kind.TOOL,
            toolCallId = "call-1",
            toolName = "read_file",
            label = "Read file",
            status = AidenAgentStepStatus.RUNNING,
            startedAt = 1000.0,
            updatedAt = 1000.0,
            contentOffset = 0,
            target = "/Users/private/secret"
        )
        val timeline = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_test",
            status = AidenGenerationTimelineStatus.RUNNING,
            startedAt = 1000.0,
            steps = listOf(baseStep)
        )
        assertFalse(timeline.isRendererSafe())

        val windowsPath = timeline.copy(steps = listOf(baseStep.copy(target = """C:\Users\private\secret""")))
        assertFalse(windowsPath.isRendererSafe())

        val traversalPath = timeline.copy(steps = listOf(baseStep.copy(target = """folder\..\secret""")))
        assertFalse(traversalPath.isRendererSafe())
    }

    @Test
    fun testAgentActivityPresentation() {
        val readStep = AidenAgentStep(
            id = "tool-1",
            order = 0,
            kind = AidenAgentStep.Kind.TOOL,
            toolCallId = "call-1",
            toolName = "read_file",
            label = "Read file",
            status = AidenAgentStepStatus.COMPLETED,
            startedAt = 1000.0,
            updatedAt = 1500.0,
            finishedAt = 1500.0,
            contentOffset = 0,
            target = "README.md"
        )
        assertEquals("Read README.md", AidenAgentActivityPresentation.line(readStep))

        val thinkStep = AidenAgentStep(
            id = "think-1",
            order = 1,
            kind = AidenAgentStep.Kind.THINKING,
            status = AidenAgentStepStatus.COMPLETED,
            startedAt = 1500.0,
            updatedAt = 2500.0,
            finishedAt = 2500.0,
            contentOffset = 0,
            durationMs = 1000.0
        )
        assertEquals("Thought briefly", AidenAgentActivityPresentation.line(thinkStep))

        val runStep = AidenAgentStep(
            id = "tool-2",
            order = 2,
            kind = AidenAgentStep.Kind.TOOL,
            toolCallId = "call-2",
            toolName = "run_command",
            label = "Run command",
            status = AidenAgentStepStatus.COMPLETED,
            startedAt = 2500.0,
            updatedAt = 3000.0,
            finishedAt = 3000.0,
            contentOffset = 0,
            detail = "Run tests"
        )
        assertEquals("Ran Run tests", AidenAgentActivityPresentation.line(runStep))

        val timeline = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_summary",
            status = AidenGenerationTimelineStatus.COMPLETED,
            startedAt = 1000.0,
            finishedAt = 3000.0,
            steps = listOf(readStep, thinkStep, runStep)
        )
        assertEquals("Explored 1 file, ran 1 command", AidenAgentActivityPresentation.summary(timeline))

        // Multiple categories summary
        val multiTimeline = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_multi",
            status = AidenGenerationTimelineStatus.COMPLETED,
            startedAt = 1000.0,
            finishedAt = 2000.0,
            steps = listOf("web_search", "computer_use", "compact_context", "custom_tool").mapIndexed { index, name ->
                AidenAgentStep(
                    id = "tool-$index",
                    order = index,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-$index",
                    toolName = name,
                    label = "Tool",
                    status = AidenAgentStepStatus.COMPLETED,
                    startedAt = 1000.0,
                    updatedAt = 2000.0,
                    finishedAt = 2000.0,
                    contentOffset = 0,
                    durationMs = 1000.0
                )
            }
        )
        assertEquals(
            "1 web search, 1 Mac action, compacted context, 1 tool call",
            AidenAgentActivityPresentation.summary(multiTimeline)
        )
    }

    @Test
    fun testProviderArtworkPNGHeaderValidation() {
        val valid1x1PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        val artwork = AidenProviderArtwork(mimeType = "image/png", dataBase64 = valid1x1PNG)
        assertNotNull(artwork.boundedPNGData)

        // Oversized PNG header > 64x64
        val header = ByteArray(24)
        byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10).copyInto(header, 0)
        byteArrayOf(73, 72, 68, 82).copyInto(header, 12)
        header[19] = 65 // width = 65
        header[23] = 1  // height = 1
        val oversizedArtwork = AidenProviderArtwork(
            mimeType = "image/png",
            dataBase64 = Base64.getEncoder().encodeToString(header)
        )
        assertNull(oversizedArtwork.boundedPNGData)
    }

    @Test
    fun testBotReplyProjection() {
        val progress = "Checking the workspace 🍎\n\nI found the destination.\n\n"
        val final = "## Done\n\nThe repository is ready."
        val timeline = AidenGenerationTimeline(
            version = 3,
            generationId = "stream-1",
            status = AidenGenerationTimelineStatus.COMPLETED,
            startedAt = 1000.0,
            finishedAt = 2000.0,
            steps = listOf(
                AidenAgentStep(
                    id = "tool-1",
                    order = 0,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-1",
                    toolName = "list_dir",
                    label = "List directory",
                    status = AidenAgentStepStatus.COMPLETED,
                    startedAt = 1000.0,
                    updatedAt = 1500.0,
                    finishedAt = 1500.0,
                    contentOffset = 0
                ),
                AidenAgentStep(
                    id = "tool-2",
                    order = 1,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-2",
                    toolName = "run_command",
                    label = "Run command",
                    status = AidenAgentStepStatus.COMPLETED,
                    startedAt = 1500.0,
                    updatedAt = 2000.0,
                    finishedAt = 2000.0,
                    contentOffset = progress.length,
                    detail = "Clone repository"
                )
            )
        )

        val projection = AidenBotReplyProjection.resolve(
            text = progress + final,
            timeline = timeline,
            isActive = false
        )
        assertEquals(progress.trim(), projection.progressText)
        assertEquals(final, projection.finalText)

        // Active deduplication
        val repeated = "Locating the workspace.\n\nLocating   the workspace.\n\nRunning the clone."
        val activeProjection = AidenBotReplyProjection.resolve(
            text = repeated,
            timeline = null,
            isActive = true
        )
        assertEquals("", activeProjection.finalText)
        assertEquals("Locating the workspace.\n\nRunning the clone.", activeProjection.progressText)
    }

    @Test
    fun testPendingApprovalResolution() {
        val now = Instant.ofEpochSecond(10_000)
        val valid = AidenStreamPendingApproval(
            approvalId = "approval-1",
            streamId = "stream-1",
            chatId = "chat-1",
            summary = "Review",
            toolCallId = "tool-1",
            toolName = "run",
            expiresAt = now.plusSeconds(60),
            canAllow = false
        )

        val resolved = AidenPendingApprovalResolution.resolve(valid, "stream-1", "chat-1", now)
        assertNotNull(resolved)
        assertEquals("approval-1", resolved?.id)
        assertFalse(resolved!!.canAllow)

        assertNull(AidenPendingApprovalResolution.resolve(null, "stream-1", "chat-1", now))
        assertNull(AidenPendingApprovalResolution.resolve(valid, "stream-2", "chat-1", now))
        assertNull(AidenPendingApprovalResolution.resolve(valid, "stream-1", "chat-2", now))
        assertNull(AidenPendingApprovalResolution.resolve(valid.copy(expiresAt = now), "stream-1", "chat-1", now))
    }

    @Test
    fun testChatCachePartitionAndActiveStream() {
        val tempDir = File(System.getProperty("java.io.tmpdir"), "aiden-cache-test-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val cache = AidenChatCache(root = tempDir)
            val chat = sampleChat()

            cache.saveChats(listOf(chat), "instance-a", "workspace-1")
            cache.saveChat(chat, "instance-a")
            cache.saveActiveStream(
                AidenChatCache.ActiveStream(deviceId = "device-a", streamId = "stream-1", turnId = "turn-1", lastSequence = 14),
                instanceId = "instance-a",
                chatId = chat.id
            )

            val chatsA = cache.loadChats("instance-a", "workspace-1")
            val chatA = cache.loadChat("instance-a", chat.id)
            val streamA = cache.loadActiveStream("instance-a", chat.id)

            assertEquals(listOf(chat), chatsA)
            assertEquals(chat, chatA)
            assertEquals("stream-1", streamA?.streamId)
            assertEquals(14, streamA?.lastSequence)

            // Isolation from instance-b
            val chatB = cache.loadChat("instance-b", chat.id)
            assertNull(chatB)

            // Purge instance-a
            cache.purge("instance-a")
            assertNull(cache.loadChat("instance-a", chat.id))
            assertNull(cache.loadActiveStream("instance-a", chat.id))
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun testDraftStoreOptimisticGenerationTracking() {
        val tempDir = File(System.getProperty("java.io.tmpdir"), "aiden-drafts-test-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val store = AidenChatDraftStore(root = tempDir)
            val session1 = store.beginSession("inst-1", "chat-1")
            assertEquals(1L, session1.generation)

            assertTrue(store.save("Hello draft", session1))
            assertEquals("Hello draft", store.load(session1))

            // Beginning a new session invalidates older session saves
            val session2 = store.beginSession("inst-1", "chat-1")
            assertEquals(2L, session2.generation)

            assertFalse(store.save("Stale overwrite", session1))
            assertEquals("Hello draft", store.load(session2))

            assertTrue(store.save("Fresh text", session2))
            assertEquals("Fresh text", store.load(session2))
        } finally {
            tempDir.deleteRecursively()
        }
    }

    private fun sampleChat(): AidenChat {
        return AidenChat(
            id = "chat-1",
            workspaceId = "workspace-1",
            title = "Aiden chat",
            providerId = "openai",
            modelId = "gpt-5.6",
            messages = listOf(
                AidenChatMessage(
                    id = "msg-1",
                    role = AidenChatRole.USER,
                    text = "Hello",
                    createdAt = Instant.ofEpochSecond(1_787_100_000)
                )
            ),
            createdAt = Instant.ofEpochSecond(1_787_100_000),
            updatedAt = Instant.ofEpochSecond(1_787_100_001),
            revision = "revision-1"
        )
    }
}
