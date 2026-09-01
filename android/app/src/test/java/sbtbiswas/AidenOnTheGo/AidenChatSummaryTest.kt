package sbtbiswas.AidenOnTheGo

import com.sun.management.ThreadMXBean
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseScope
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseValidator
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import java.io.File
import java.lang.management.ManagementFactory
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import kotlin.system.measureNanoTime

class AidenChatSummaryTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        client = AidenRemoteClient(
            endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
            credential = "summary-test-credential",
            customOkHttpClient = OkHttpClient()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
    }

    @Test
    fun summaryEndpointDecodesRequiredFieldsAndToleratesHarmlessAdditions() = runBlocking {
        val nextCursor = canonicalCursor("next-page")
        server.enqueue(MockResponse().setResponseCode(200).setBody(summaryPageJson(
            extraSummaryField = "\"futureDisplayHint\":\"compact\",",
            nextCursor = nextCursor
        )))

        val page = client.chatSummaryPage(limit = 100)

        val request = server.takeRequest()
        assertEquals("/api/aiden/v1/chat-summaries?limit=100", request.path)
        assertEquals("Bearer summary-test-credential", request.getHeader("Authorization"))
        assertEquals("chat-1", page.summaries.single().id)
        assertEquals(AidenChatSummaryActivity.ACTIVE, page.summaries.single().activity)
        assertEquals(nextCursor, page.nextCursor)
    }

    @Test
    fun serverFeatureAdvertisementIsBoundedAndForwardCompatible() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """
            {
              "protocolVersion":1,
              "instanceId":"test-instance",
              "name":"Test Mac",
              "capabilities":["server:read","chat:read"],
              "serverCapabilities":["server:read","chat:read"],
              "features":["chat-summaries-v1","future-feature-v2"],
              "futureServerMetadata":{"display":"harmless"},
              "serverTime":"2026-09-01T12:00:00Z"
            }
            """.trimIndent()
        ))

        val info = client.server()
        assertTrue(info.supportsChatSummaries)
        assertEquals(listOf("chat-summaries-v1", "future-feature-v2"), info.features)
        assertTrue(info.capabilities.contains(AidenRemoteCapability.CHAT_READ))

        assertThrows(AidenRemoteContractException.InvalidJson::class.java) {
            AidenServer(
                instanceId = "test-instance",
                name = "Test",
                capabilities = emptyList(),
                features = listOf("duplicate", "duplicate")
            )
        }
        Unit
    }

    @Test
    fun summaryEndpointEncodesCursorAndEnforcesPageAndRequestBounds() = runBlocking {
        val cursor = canonicalCursor("request-page")
        server.enqueue(MockResponse().setResponseCode(200).setBody(summaryPageJson(nextCursor = null)))
        client.chatSummaryPage(limit = 17, cursor = cursor)
        assertEquals(
            "/api/aiden/v1/chat-summaries?limit=17&cursor=$cursor",
            server.takeRequest().path
        )

        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.chatSummaryPage(limit = 0) }
        }
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.chatSummaryPage(limit = 201) }
        }
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.chatSummaryPage(cursor = "x".repeat(513)) }
        }

        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"summaries":[${summaryJson("chat-1")},${summaryJson("chat-2")}]}"""
        ))
        assertThrows(AidenRemoteContractException.InvalidJson::class.java) {
            runBlocking { client.chatSummaryPage(limit = 1) }
        }

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("{}")
                .setHeader("Content-Length", AidenRemoteProtocol.MAX_JSON_BODY_BYTES + 1)
        )
        assertThrows(AidenRemoteContractException.PayloadTooLarge::class.java) {
            runBlocking { client.chatSummaryPage() }
        }
        Unit
    }

    @Test
    fun summaryEndpointFailsClosedForMissingRequiredOrPrivateFields() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"summaries":[{"id":"chat-1","workspaceId":"workspace-1","title":"Missing title pending","createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:01:00Z","revision":"rev-1","activity":"idle"}]}"""
        ))
        assertThrows(Exception::class.java) {
            runBlocking { client.chatSummaryPage() }
        }

        server.enqueue(MockResponse().setResponseCode(200).setBody(summaryPageJson(
            extraSummaryField = "\"providerCredential\":\"must-not-cross-wire\",",
            nextCursor = null
        )))
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            runBlocking { client.chatSummaryPage() }
        }

        server.enqueue(MockResponse().setResponseCode(200).setBody(summaryPageJson(
            extraSummaryField = "\"messages\":[{\"text\":\"must not cross the summary wire\"}],",
            nextCursor = null
        )))
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            runBlocking { client.chatSummaryPage() }
        }

        server.enqueue(MockResponse().setResponseCode(200).setBody(summaryPageJson(
            extraSummaryField = "\"subagentProjectionNotices\":[\"private\"],",
            nextCursor = null
        )))
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            runBlocking { client.chatSummaryPage() }
        }

        for (privateField in listOf("preview", "children", "childMessages", "subagentRunSnapshot")) {
            server.enqueue(MockResponse().setResponseCode(200).setBody(summaryPageJson(
                extraSummaryField = "\"futureEnvelope\":{\"$privateField\":\"private\"},",
                nextCursor = null
            )))
            assertThrows(
                "Expected recursive rejection for $privateField",
                AidenRemoteContractException.UnsafePayloadField::class.java
            ) {
                runBlocking { client.chatSummaryPage() }
            }
        }

        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenBotPrivateResponseValidator.validate(
                """{"chatSummaries":${summaryPageJson(
                    extraSummaryField = "\"preview\":\"private\",",
                    nextCursor = null
                )}}""",
                AidenBotPrivateResponseScope.SharedFixture
            )
        }

        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"summaries":[${summaryJson("chat-1")}],"nextCursor":null}"""
        ))
        assertThrows(AidenRemoteContractException.InvalidJson::class.java) {
            runBlocking { client.chatSummaryPage() }
        }
    }

    @Test
    fun summaryModelEnforcesCanonicalRevisionCursorAndOrdering() {
        val older = summary("chat-z", "workspace-1", "Older", AidenChatSummaryActivity.IDLE)
        val newer = summary("chat-a", "workspace-1", "Newer", AidenChatSummaryActivity.IDLE)
            .copy(updatedAt = Instant.parse("2026-09-01T12:02:00Z"))

        val localLegacy = older.copy(revision = "legacy-revision")
        assertEquals("legacy-revision", localLegacy.revision)
        assertThrows(AidenRemoteContractException.InvalidJson::class.java) {
            AidenChatSummaryPage(listOf(localLegacy)).validatedWire()
        }
        assertThrows(AidenRemoteContractException.InvalidJson::class.java) {
            AidenChatSummaryPage(listOf(older), nextCursor = "not-a-cursor")
        }
        assertThrows(AidenRemoteContractException.InvalidJson::class.java) {
            AidenChatSummaryPage(listOf(older, newer))
        }
        assertEquals(listOf("chat-a", "chat-z"), AidenChatSummaryPage(listOf(newer, older)).summaries.map { it.id })
    }

    @Test
    fun preferredLoaderUsesLegacyChatsOnlyWithoutFeatureAndSurfacesAdvertisedFailure() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(legacyChatListJson()))
        val unadvertised = client.preferredChatSummaryPage(supportsChatSummaries = false)
        assertTrue(unadvertised.usedLegacyEndpoint)
        assertNull(unadvertised.nextCursor)
        assertEquals(listOf("regular-chat"), unadvertised.summaries.map { it.id })
        assertEquals("rev-1", unadvertised.summaries.single().revision)
        assertEquals("/api/aiden/v1/chats", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"id":"regular-chat","workspaceId":"workspace-1","title":"Renamed","messages":[],"createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:02:00Z","revision":"rev-2"}"""
        ))
        client.updateChat("regular-chat", unadvertised.summaries.single().revision, "Renamed")
        assertEquals("rev-1", server.takeRequest().getHeader("If-Match"))

        server.enqueue(MockResponse().setResponseCode(404).setBody("{}"))
        assertThrows(AidenRemoteClientException.Server::class.java) {
            runBlocking { client.preferredChatSummaryPage(supportsChatSummaries = true) }
        }
        assertEquals("/api/aiden/v1/chat-summaries?limit=100", server.takeRequest().path)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun installationScopedSummaryCacheHydratesAndReconcilesChatLifecycle() {
        val cache = AidenChatCache(root = tempFolder.newFolder("summary-cache"))
        val first = summary("chat-1", "workspace-1", "Initial", AidenChatSummaryActivity.IDLE)
        val other = summary("chat-2", "workspace-2", "Other Mac", AidenChatSummaryActivity.IDLE)
        cache.saveSummaries(listOf(first), "mac-1")
        cache.saveSummaries(listOf(other), "mac-2")

        val restored = AidenChatCache(root = cache.root)
        assertEquals(listOf("chat-1"), restored.loadSummaries("mac-1")?.map { it.id })
        assertEquals(listOf("chat-2"), restored.loadSummaries("mac-2")?.map { it.id })
        assertNull(restored.loadChat("mac-1", "chat-1"))

        restored.saveChat(fullChat("chat-1", "workspace-1", "Renamed", "rev-2"), "mac-1")
        assertEquals("Renamed", restored.loadSummaries("mac-1")?.single()?.title)
        restored.saveActiveStream(
            AidenChatCache.ActiveStream("device-1", "stream-1", "turn-1", 0),
            "mac-1",
            "chat-1"
        )
        assertEquals(AidenChatSummaryActivity.ACTIVE, restored.loadSummaries("mac-1")?.single()?.activity)
        restored.removeActiveStream("mac-1", "chat-1")
        assertEquals(AidenChatSummaryActivity.IDLE, restored.loadSummaries("mac-1")?.single()?.activity)
        restored.removeChat("mac-1", "chat-1")
        assertTrue(restored.loadSummaries("mac-1").orEmpty().isEmpty())
        assertEquals(listOf("chat-2"), restored.loadSummaries("mac-2")?.map { it.id })
    }

    @Test
    fun summaryCacheSupportsWorstCaseAggregateAndFailedWriteCanRetryTransactionally() {
        val maximumTitle = "\uD83D\uDE80".repeat(1_024)
        val summaries = (0 until 10_000).map { index ->
            summary(
                id = "chat-${index.toString().padStart(5, '0')}",
                workspaceId = "workspace-1",
                title = maximumTitle,
                activity = AidenChatSummaryActivity.IDLE
            )
        }
        val aggregateRoot = tempFolder.newFolder("maximum-summary-cache")
        AidenChatCache(root = aggregateRoot).saveSummaries(summaries, "maximum-mac")
        val aggregateBytes = aggregateRoot.walkTopDown().filter(File::isFile).sumOf(File::length)
        val aggregateChunks = File(aggregateRoot, "summary-chunks")
            .walkTopDown().filter(File::isFile).toList()
        assertTrue("Regression fixture must exceed the old 10 MiB ceiling", aggregateBytes > 10L * 1024 * 1024)
        assertTrue(aggregateBytes <= 64L * 1024 * 1024)
        assertEquals(50, aggregateChunks.size)
        assertTrue(aggregateChunks.all { it.length() <= 2L * 1024 * 1024 })
        val restored = requireNotNull(AidenChatCache(root = aggregateRoot).loadSummaries("maximum-mac"))
        assertEquals(10_000, restored.size)
        assertEquals(1_024, restored.first().title.codePointCount(0, restored.first().title.length))
        assertThrows(IllegalArgumentException::class.java) {
            AidenChatCache(root = aggregateRoot).saveSummaries(
                summaries + summary("chat-over-limit", "workspace-1", "Extra", AidenChatSummaryActivity.IDLE),
                "maximum-mac"
            )
        }

        val boundedRoot = tempFolder.newFolder("bounded-summary-cache")
        val bounded = AidenChatCache(root = boundedRoot, maximumSummaryCacheBytes = 1_024)
        val original = summary("chat-original", "workspace-1", "Original", AidenChatSummaryActivity.IDLE)
        bounded.saveSummaries(listOf(original), "bounded-mac")
        val oversized = summary(
            "chat-oversized",
            "workspace-1",
            maximumTitle,
            AidenChatSummaryActivity.IDLE
        )
        assertThrows(IllegalStateException::class.java) {
            bounded.saveSummaries(listOf(original, oversized), "bounded-mac")
        }
        assertEquals(listOf(original), bounded.loadSummaries("bounded-mac"))

        val retry = original.copy(title = "Retry accepted")
        bounded.saveSummaries(listOf(retry), "bounded-mac")
        assertEquals(listOf(retry), bounded.loadSummaries("bounded-mac"))

        val incrementalRoot = tempFolder.newFolder("incremental-summary-cache")
        val incremental = AidenChatCache(root = incrementalRoot)
        incremental.saveSummaries(summaries.take(200), "incremental-mac")
        val originalChunk = File(incrementalRoot, "summary-chunks")
            .walkTopDown().single { it.isFile }.name
        incremental.saveSummaries(
            summaries.take(400),
            "incremental-mac",
            unchangedPrefixCount = 200
        )
        val appendedChunks = File(incrementalRoot, "summary-chunks")
            .walkTopDown().filter(File::isFile).map { it.name }.toSet()
        assertEquals(2, appendedChunks.size)
        assertTrue(originalChunk in appendedChunks)
        assertEquals(summaries.take(400), incremental.loadSummaries("incremental-mac"))

        val calibrationRoot = tempFolder.newFolder("late-failure-calibration")
        AidenChatCache(root = calibrationRoot).saveSummaries(summaries.take(200), "failure-mac")
        val calibrationFiles = calibrationRoot.walkTopDown().filter(File::isFile).toList()
        val calibrationChunkBytes = calibrationFiles.single {
            it.parentFile?.parentFile?.name == "summary-chunks"
        }.length()
        val calibrationTotalBytes = calibrationFiles.sumOf(File::length)
        val lateFailureLimit = maxOf(
            calibrationTotalBytes + 1_024,
            calibrationChunkBytes * 3 / 2
        ).toInt()
        val failureRoot = tempFolder.newFolder("late-failure-summary-cache")
        val failureCache = AidenChatCache(
            root = failureRoot,
            maximumSummaryCacheBytes = lateFailureLimit
        )
        val committed = summaries.take(200)
        failureCache.saveSummaries(committed, "failure-mac")
        val committedFiles = failureRoot.walkTopDown()
            .filter(File::isFile).associate { it.relativeTo(failureRoot).path to it.length() }
        val replacementTitles = listOf("\uD83D\uDE00", "\uD83D\uDE03", "\uD83D\uDE0E")
        for (replacement in replacementTitles) {
            val failedCandidate = committed.map { it.copy(title = replacement.repeat(1_024)) } +
                summaries.subList(200, 400)
            assertThrows(IllegalStateException::class.java) {
                failureCache.saveSummaries(failedCandidate, "failure-mac")
            }
            assertEquals(committed, failureCache.loadSummaries("failure-mac"))
            val afterFailure = failureRoot.walkTopDown()
                .filter(File::isFile).associate { it.relativeTo(failureRoot).path to it.length() }
            assertEquals("Failed retries must not retain orphan chunks", committedFiles, afterFailure)
            assertTrue(afterFailure.values.sum() <= lateFailureLimit.toLong() * 2)
        }
    }

    @Test
    fun deterministicPerformanceProfilesCoverNormalHeavyStressAndPathologicalHistories() {
        for (profile in PERFORMANCE_PROFILES) {
            val fullChats = performanceChats(profile)
            val summaries = fullChats.map { AidenChatSummary.fromChat(it) }
                .sortedWith(compareByDescending<AidenChatSummary> { it.updatedAt }.thenBy { it.id })
            val fullWire = json.encodeToString(FullChatFixture(fullChats))
            val summaryWires = summaries.chunked(AidenRemoteProtocol.DEFAULT_CHAT_SUMMARY_PAGE_SIZE)
                .mapIndexed { pageIndex, page ->
                    json.encodeToString(
                        AidenChatSummaryPage(
                            summaries = page,
                            nextCursor = if ((pageIndex + 1) * AidenRemoteProtocol.DEFAULT_CHAT_SUMMARY_PAGE_SIZE < summaries.size) {
                                canonicalCursor("synthetic-${profile.name}-page-${pageIndex + 1}")
                            } else null
                        )
                    )
                }
            val summaryBytes = summaryWires.sumOf { it.toByteArray().size }

            assertEquals(profile.chatCount, fullChats.size)
            if (!profile.pathological) {
                assertTrue(fullChats.all { it.messages.size == profile.messagesPerChat })
            } else {
                assertTrue(fullChats.flatMap { it.messages }.any {
                    it.text.codePointCount(0, it.text.length) == AidenRemoteProtocol.MAX_TEXT_LENGTH
                })
            }
            assertEquals((profile.chatCount + 99) / 100, summaryWires.size)
            assertTrue(
                "${profile.name}: summary=$summaryBytes full=${fullWire.toByteArray().size}",
                summaryBytes * 2 < fullWire.toByteArray().size
            )
        }
    }

    @Test
    fun kotlinSerializationBenchmarkComparesFullFirstAllPagesAndCacheHydration() {
        val profile = PERFORMANCE_PROFILES.first { it.name == "medium" }
        val fullChats = performanceChats(profile)
        val summaries = fullChats.map { AidenChatSummary.fromChat(it) }
            .sortedWith(compareByDescending<AidenChatSummary> { it.updatedAt }.thenBy { it.id })
        val fullWire = json.encodeToString(FullChatFixture(fullChats))
        val pageWires = summaries.chunked(100).mapIndexed { index, page ->
            json.encodeToString(
                AidenChatSummaryPage(
                    summaries = page,
                    nextCursor = if (index < (summaries.size - 1) / 100) canonicalCursor("benchmark-page-${index + 1}") else null
                )
            )
        }
        val cacheRoot = tempFolder.newFolder("benchmark-summary-cache")
        AidenChatCache(root = cacheRoot).saveSummaries(summaries, "benchmark-mac")

        repeat(2) {
            json.decodeFromString<FullChatFixture>(fullWire)
            json.decodeFromString<AidenChatSummaryPage>(pageWires.first())
            pageWires.forEach { json.decodeFromString<AidenChatSummaryPage>(it) }
            AidenChatCache(root = cacheRoot).loadSummaries("benchmark-mac")
        }
        val fullStats = minimumDecodeStats(3) { json.decodeFromString<FullChatFixture>(fullWire) }
        val firstPageStats = minimumDecodeStats(3) {
            json.decodeFromString<AidenChatSummaryPage>(pageWires.first())
        }
        val allPagesStats = minimumDecodeStats(3) {
            pageWires.forEach { json.decodeFromString<AidenChatSummaryPage>(it) }
        }
        val cacheStats = minimumDecodeStats(3) {
            AidenChatCache(root = cacheRoot).loadSummaries("benchmark-mac")
        }

        assertTrue(firstPageStats.elapsedNanos < fullStats.elapsedNanos)
        assertTrue(allPagesStats.elapsedNanos < fullStats.elapsedNanos)
        if (fullStats.allocatedBytes >= 0) {
            assertTrue(firstPageStats.allocatedBytes in 0 until fullStats.allocatedBytes)
            assertTrue(allPagesStats.allocatedBytes in 0 until fullStats.allocatedBytes)
            assertTrue(cacheStats.allocatedBytes in 0 until fullStats.allocatedBytes)
        }
        println(
            "AidenChatSummaryBenchmark full=$fullStats firstPage=$firstPageStats " +
                "allPages=$allPagesStats cacheHydration=$cacheStats"
        )
    }

    private fun minimumDecodeStats(iterations: Int, block: () -> Unit): DecodeStats {
        val bean = ManagementFactory.getThreadMXBean() as? ThreadMXBean
        if (bean != null && bean.isThreadAllocatedMemorySupported && !bean.isThreadAllocatedMemoryEnabled) {
            bean.isThreadAllocatedMemoryEnabled = true
        }
        val threadId = Thread.currentThread().id
        return (0 until iterations).map {
            val before = bean?.takeIf { it.isThreadAllocatedMemoryEnabled }?.getThreadAllocatedBytes(threadId) ?: -1
            val elapsed = measureNanoTime(block)
            val after = bean?.takeIf { it.isThreadAllocatedMemoryEnabled }?.getThreadAllocatedBytes(threadId) ?: -1
            DecodeStats(elapsed, if (before >= 0 && after >= before) after - before else -1)
        }.minBy { it.elapsedNanos }
    }

    private fun summaryPageJson(extraSummaryField: String = "", nextCursor: String?): String =
        """{"summaries":[${summaryJson("chat-1", extraSummaryField, "active")} ]${nextCursor?.let { ",\"nextCursor\":${Json.encodeToString(it)}" }.orEmpty()}}"""

    private fun summaryJson(id: String, extra: String = "", activity: String = "idle"): String =
        """{"id":"$id","workspaceId":"workspace-1","title":"Summary $id","titlePending":false,$extra"createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:01:00Z","revision":"${canonicalRevision(id)}","activity":"$activity"}"""

    private fun legacyChatListJson(): String = """
        {"chats":[
          {"id":"regular-chat","workspaceId":"workspace-1","title":"Regular","messages":[],"createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:01:00Z","revision":"rev-1"},
          {"id":"bot-chat","workspaceId":"workspace-1","botId":"bot-1","title":"Reserved","messages":[],"createdAt":"2026-09-01T12:00:00Z","updatedAt":"2026-09-01T12:01:00Z","revision":"rev-2"}
        ]}
    """.trimIndent()

    private fun summary(
        id: String,
        workspaceId: String,
        title: String,
        activity: AidenChatSummaryActivity
    ) = AidenChatSummary(
        id = id,
        workspaceId = workspaceId,
        title = title,
        titlePending = false,
        createdAt = Instant.parse("2026-09-01T12:00:00Z"),
        updatedAt = Instant.parse("2026-09-01T12:01:00Z"),
        revision = canonicalRevision(id),
        activity = activity
    )

    private fun fullChat(
        id: String,
        workspaceId: String,
        title: String,
        revision: String,
        messageCount: Int = 0,
        messageTextLength: Int = 1_024
    ) = AidenChat(
        id = id,
        workspaceId = workspaceId,
        title = title,
        messages = (0 until messageCount).map { messageIndex ->
            AidenChatMessage(
                id = "$id-message-$messageIndex",
                role = if (messageIndex % 2 == 0) AidenChatRole.USER else AidenChatRole.ASSISTANT,
                text = syntheticText(messageIndex, messageTextLength),
                createdAt = Instant.parse("2026-09-01T12:00:00Z").plusSeconds(messageIndex.toLong())
            )
        },
        createdAt = Instant.parse("2026-09-01T12:00:00Z"),
        updatedAt = Instant.parse("2026-09-01T12:01:00Z"),
        revision = revision
    )

    @Serializable
    private data class FullChatFixture(val chats: List<AidenChat>)

    private data class DecodeStats(val elapsedNanos: Long, val allocatedBytes: Long)

    private data class PerformanceProfile(
        val name: String,
        val chatCount: Int,
        val messagesPerChat: Int,
        val messageTextLength: Int,
        val pathological: Boolean = false
    )

    private fun performanceChats(profile: PerformanceProfile): List<AidenChat> =
        (0 until profile.chatCount).map { chatIndex ->
            if (!profile.pathological) {
                fullChat(
                    id = "${profile.name}-chat-$chatIndex",
                    workspaceId = "workspace-${chatIndex % 10}",
                    title = "${profile.name} synthetic chat $chatIndex",
                    revision = canonicalRevision("${profile.name}-revision-$chatIndex"),
                    messageCount = profile.messagesPerChat,
                    messageTextLength = profile.messageTextLength
                )
            } else {
                val messageCount = 1 + (chatIndex % 5)
                val chat = fullChat(
                    id = "pathological-chat-$chatIndex",
                    workspaceId = "workspace-${chatIndex % 10}",
                    title = "Pathological synthetic chat $chatIndex",
                    revision = canonicalRevision("pathological-revision-$chatIndex"),
                    messageCount = messageCount,
                    messageTextLength = 32
                )
                if (chatIndex % 200 == 0) {
                    chat.copy(
                        messages = chat.messages.mapIndexed { messageIndex, message ->
                            if (messageIndex == 0) message.copy(
                                text = syntheticText(messageIndex, AidenRemoteProtocol.MAX_TEXT_LENGTH)
                            ) else message
                        }
                    )
                } else chat
            }
        }

    private fun syntheticText(messageIndex: Int, length: Int): String {
        val prefix = "Synthetic deterministic message $messageIndex "
        return if (prefix.length >= length) prefix.take(length) else prefix + "x".repeat(length - prefix.length)
    }

    private fun canonicalRevision(seed: String): String = "rev_" + Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(MessageDigest.getInstance("SHA-256").digest(seed.toByteArray()))

    private fun canonicalCursor(seed: String): String {
        val payload = Base64.getUrlEncoder().withoutPadding().encodeToString(seed.toByteArray())
        return "cur_$payload.${"S".repeat(43)}"
    }

    companion object {
        private val PERFORMANCE_PROFILES = listOf(
            PerformanceProfile("small", chatCount = 50, messagesPerChat = 10, messageTextLength = 256),
            PerformanceProfile("medium", chatCount = 250, messagesPerChat = 50, messageTextLength = 64),
            PerformanceProfile("large", chatCount = 1_000, messagesPerChat = 100, messageTextLength = 16),
            PerformanceProfile(
                "pathological",
                chatCount = 2_000,
                messagesPerChat = -1,
                messageTextLength = AidenRemoteProtocol.MAX_TEXT_LENGTH,
                pathological = true
            )
        )
    }
}
