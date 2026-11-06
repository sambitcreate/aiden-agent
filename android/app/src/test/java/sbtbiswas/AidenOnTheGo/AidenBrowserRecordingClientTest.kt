package sbtbiswas.AidenOnTheGo

import java.io.File
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.CoroutineContext
import okhttp3.ResponseBody
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.ForwardingSource
import okio.buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenBrowserRecordingGate
import sbtbiswas.AidenOnTheGo.models.AidenBrowserRecordingRecap
import sbtbiswas.AidenOnTheGo.models.AidenInstallation
import sbtbiswas.AidenOnTheGo.models.AidenServer
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode

/** `GET /chats/{chatId}/recordings/{recordingId}` and its feature gate (contract revision 46). */
class AidenBrowserRecordingClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient
    private lateinit var directory: File
    private val recordingId = "recording-0f1e2d3c-4b5a-4678-9abc-def012345678"
    private val video = ByteArray(70_000) { (it % 253).toByte() }

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        directory = kotlin.io.path.createTempDirectory("aiden-recordings-").toFile()
        val installation = AidenInstallation(
            instanceId = "test_instance",
            deviceId = "test_device",
            name = "Test Mac",
            endpoint = server.url("/api/aiden/v1").toString(),
            serverSpkiSha256 = "sha256/test",
            deviceCapabilities = listOf(AidenRemoteCapability.CHAT_READ),
            serverCapabilities = listOf(AidenRemoteCapability.CHAT_READ),
            createdAt = Instant.now()
        )
        client = AidenRemoteClient(
            installation = installation,
            credential = "test_credential_123",
            customOkHttpClient = OkHttpClient.Builder().build()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
        directory.deleteRecursively()
    }

    private fun videoResponse(
        contentType: String? = "video/mp4",
        cacheControl: String? = "no-store",
        noSniff: String? = "nosniff",
        body: ByteArray = video
    ): MockResponse {
        val response = MockResponse().setResponseCode(200).setBody(Buffer().write(body))
        contentType?.let { response.setHeader("Content-Type", it) }
        cacheControl?.let { response.setHeader("Cache-Control", it) }
        noSniff?.let { response.setHeader("X-Content-Type-Options", it) }
        return response
    }

    private fun savedFiles(): List<String> = directory.list().orEmpty().sorted()

    @Test
    fun streamsTheVideoToAPerPlayFileWithChatReadAuthentication() = runBlocking {
        server.enqueue(videoResponse())

        val saved = client.browserRecording("chat_fixture_01", recordingId, directory)
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!

        assertEquals("GET", request.method)
        assertEquals("/api/aiden/v1/chats/chat_fixture_01/recordings/$recordingId", request.requestUrl!!.encodedPath)
        assertEquals("Bearer test_credential_123", request.getHeader("Authorization"))
        assertEquals("1", request.getHeader("Aiden-Protocol-Version"))
        assertTrue(request.getHeader("Accept")!!.contains("video/mp4"))
        assertTrue(request.getHeader("Accept")!!.contains("video/webm"))

        assertEquals("video/mp4", saved.mimeType)
        assertEquals(directory, saved.file.parentFile)
        assertEquals("mp4", saved.file.extension)
        assertArrayEquals(video, saved.file.readBytes())
        // Only the finished file remains; no partial download is left beside it.
        assertEquals(listOf(saved.file.name), savedFiles())
    }

    @Test
    fun aWebmRecordingKeepsItsTypeAndExtension() = runBlocking {
        server.enqueue(videoResponse(contentType = "video/webm"))

        val saved = client.browserRecording("chat-1", recordingId, directory)

        assertEquals("video/webm", saved.mimeType)
        assertEquals(directory, saved.file.parentFile)
        assertEquals("webm", saved.file.extension)
        assertArrayEquals(video, saved.file.readBytes())
    }

    @Test
    fun overlappingPlaysOfTheSameRecordingHaveIndependentFileLifetimes() = runBlocking {
        val paused = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val firstResponse = AtomicBoolean(true)
        val transport = OkHttpClient.Builder().addNetworkInterceptor { chain ->
            val response = chain.proceed(chain.request())
            if (!firstResponse.compareAndSet(true, false)) return@addNetworkInterceptor response
            val original = response.body!!
            var reads = 0
            val heldSource = object : ForwardingSource(original.source()) {
                override fun read(sink: Buffer, byteCount: Long): Long {
                    if (reads++ == 1) {
                        // The first body chunk was written; hold the next read
                        // while the other Play downloads and publishes its file.
                        paused.countDown()
                        check(resume.await(5, TimeUnit.SECONDS))
                    }
                    return super.read(sink, byteCount)
                }
            }.buffer()
            response.newBuilder().body(object : ResponseBody() {
                override fun contentType() = original.contentType()
                override fun contentLength() = original.contentLength()
                override fun source() = heldSource
            }).build()
        }.build()
        val concurrentClient = AidenRemoteClient(client.endpoint, client.credential, transport)
        server.enqueue(videoResponse())
        val firstRequest = async { concurrentClient.browserRecording("chat-1", recordingId, directory) }
        val otherVideo = video.reversedArray()
        try {
            assertTrue(withContext(Dispatchers.IO) { paused.await(5, TimeUnit.SECONDS) })
            val partial = directory.listFiles()!!.single { it.extension == "part" }
            assertTrue(partial.length() > 0)
            server.enqueue(videoResponse(body = otherVideo))
            val second = concurrentClient.browserRecording("chat-1", recordingId, directory)
            assertFalse(firstRequest.isCompleted)
            resume.countDown()
            val first = withTimeout(5_000) { firstRequest.await() }
            assertTrue("each Play owns a different file", first.file != second.file)
            assertArrayEquals(video, first.file.readBytes())
            assertArrayEquals(otherVideo, second.file.readBytes())
            assertTrue(first.file.delete())
            assertArrayEquals(otherVideo, second.file.readBytes())
            assertEquals(listOf(second.file.name), savedFiles())
        } finally {
            resume.countDown()
            firstRequest.cancel()
        }
    }

    @Test
    fun cancellationBeforeTheSavedFileReachesItsCallerRemovesOnlyThatFile() {
        val continuations = LinkedBlockingQueue<Runnable>()
        val dispatcher = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) { continuations.add(block) }
        }
        val scopeJob = Job()
        val retained = File(directory, "another-player.mp4").apply { writeBytes(byteArrayOf(7, 8, 9)) }
        server.enqueue(videoResponse())
        val request = CoroutineScope(dispatcher + scopeJob).async { client.browserRecording("chat-1", recordingId, directory) }
        try {
            continuations.poll(5, TimeUnit.SECONDS)!!.run()
            // The IO worker saved the video, but its dispatcher has not delivered the result.
            val delivery = continuations.poll(5, TimeUnit.SECONDS)!!
            assertEquals(2, directory.listFiles()!!.size)
            request.cancel()
            delivery.run()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!request.isCompleted && System.nanoTime() < deadline) {
                continuations.poll(100, TimeUnit.MILLISECONDS)?.run()
            }
            assertTrue(request.isCompleted)
            assertEquals(listOf(retained.name), savedFiles())
            assertArrayEquals(byteArrayOf(7, 8, 9), retained.readBytes())
        } finally {
            scopeJob.cancel()
        }
    }

    @Test
    fun aRecordingTheMacNoLongerHasIsA404AndLeavesNoFile() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(404)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":{"code":"not_found","message":"Recording not found.","requestId":"req_1","retryable":false}}""")
        )
        try {
            client.browserRecording("chat-1", recordingId, directory)
            fail("A 404 must not save a recording")
        } catch (error: AidenRemoteClientException.Server) {
            assertEquals(404, error.statusCode)
            assertEquals(AidenRemoteErrorCode.NOT_FOUND, error.body.code)
            assertFalse(error.isCredentialRevoked)
        }
        assertEquals(emptyList<String>(), savedFiles())
    }

    @Test
    fun refusesAResponseThatBreaksTheRoutesRulesAndLeavesNoFile() {
        val refused = listOf(
            "an image" to videoResponse(contentType = "image/png"),
            "a quicktime movie" to videoResponse(contentType = "video/quicktime"),
            "no content type" to videoResponse(contentType = null),
            "a cacheable response" to videoResponse(cacheControl = "private, max-age=60"),
            "no cache control" to videoResponse(cacheControl = null),
            "a sniffable response" to videoResponse(noSniff = null),
            "an empty body" to videoResponse(body = ByteArray(0)),
            // The declared length alone is over the bound, so nothing is read.
            "a body over 128 MiB" to videoResponse(body = byteArrayOf(1))
                .setHeader("Content-Length", (AidenBrowserRecordingRecap.MAX_BYTES + 1).toString())
        )
        for ((case, response) in refused) {
            server.enqueue(response)
            assertThrows(case, AidenRemoteClientException.InvalidResponse::class.java) {
                runBlocking { client.browserRecording("chat-1", recordingId, directory) }
            }
            assertEquals(case, emptyList<String>(), savedFiles())
        }
    }

    @Test
    fun refusesIdsThatWouldLeaveTheRouteWithoutSendingAnything() {
        val refused = listOf(
            "chat/1" to recordingId,
            ".." to recordingId,
            "" to recordingId,
            "chat-1" to "recording-0f1e2d3c",
            "chat-1" to "$recordingId/../x",
            "chat-1" to "../$recordingId",
            "chat-1" to recordingId.uppercase()
        )
        for ((chatId, id) in refused) {
            assertThrows("$chatId $id", AidenRemoteClientException.InvalidResponse::class.java) {
                runBlocking { client.browserRecording(chatId, id, directory) }
            }
        }
        assertEquals(0, server.requestCount)
        assertEquals(emptyList<String>(), savedFiles())
    }

    @Test
    fun playReadsFromTheMacOnlyWhenItAnnouncedTheToken() {
        val token = "chat-browser-recordings-v1"
        assertFalse(AidenBrowserRecordingGate.isAvailable(listOf("chat-visuals-v1"), null))
        assertTrue(AidenBrowserRecordingGate.isAvailable(listOf("chat-visuals-v1", token), null))
        // Before /server answers, the features this pairing last saw stand in.
        assertTrue(AidenBrowserRecordingGate.isAvailable(null, listOf(token)))
        assertFalse(AidenBrowserRecordingGate.isAvailable(null, null))
        // A live answer without the token wins over an older cached one.
        assertFalse(AidenBrowserRecordingGate.isAvailable(listOf("chat-visuals-v1"), listOf(token)))

        val withToken = AidenServer(instanceId = "mac", name = "Mac", capabilities = emptyList(), features = listOf(token))
        val without = AidenServer(instanceId = "mac", name = "Mac", capabilities = emptyList(), features = listOf("chat-visuals-v1"))
        assertTrue(withToken.supportsBrowserRecordings)
        assertFalse(without.supportsBrowserRecordings)
    }
}
