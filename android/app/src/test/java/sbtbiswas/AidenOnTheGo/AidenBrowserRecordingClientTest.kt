package sbtbiswas.AidenOnTheGo

import java.io.File
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
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

/** `GET /chats/{chatId}/recordings/{recordingId}` and its feature gate (contract revision 42). */
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
    fun streamsTheVideoToAFileNamedByItsIdWithChatReadAuthentication() = runBlocking {
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
        assertEquals(File(directory, "$recordingId.mp4"), saved.file)
        assertArrayEquals(video, saved.file.readBytes())
        // Only the finished file remains; no partial download is left beside it.
        assertEquals(listOf("$recordingId.mp4"), savedFiles())
    }

    @Test
    fun aWebmRecordingKeepsItsTypeAndExtension() = runBlocking {
        server.enqueue(videoResponse(contentType = "video/webm"))

        val saved = client.browserRecording("chat-1", recordingId, directory)

        assertEquals("video/webm", saved.mimeType)
        assertEquals("$recordingId.webm", saved.file.name)
        assertArrayEquals(video, saved.file.readBytes())
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
