package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.GzipSink
import okio.buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID
import sbtbiswas.AidenOnTheGo.models.AidenInstallation
import sbtbiswas.AidenOnTheGo.models.AidenServer
import sbtbiswas.AidenOnTheGo.models.AidenVisualDocumentRequest
import sbtbiswas.AidenOnTheGo.models.AidenVisualDocumentScheme
import sbtbiswas.AidenOnTheGo.models.AidenVisualViewerGate
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import java.time.Instant
import java.util.concurrent.TimeUnit

/** `GET /chats/{chatId}/visuals/{visualId}/document` and its feature gate (contract revision 35). */
class AidenVisualDocumentClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
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
    }

    @Test
    fun requestsTheDocumentForTheSchemeAndThemeWithChatReadAuthentication() = runBlocking {
        val html = "<!doctype html><html><body><p>Résumé chart ✓</p></body></html>"
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/html; charset=utf-8")
                .setHeader("ETag", "\"doc-1\"")
                .setBody(html)
        )

        val document = client.visualDocument("chat-1", "visual_1", AidenVisualDocumentScheme.DARK, "dusk")
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!

        assertEquals(html, document)
        assertEquals("GET", request.method)
        assertEquals("/api/aiden/v1/chats/chat-1/visuals/visual_1/document", request.requestUrl!!.encodedPath)
        assertEquals("dark", request.requestUrl!!.queryParameter("scheme"))
        assertEquals("dusk", request.requestUrl!!.queryParameter("theme"))
        assertEquals(setOf("scheme", "theme"), request.requestUrl!!.queryParameterNames)
        assertEquals("Bearer test_credential_123", request.getHeader("Authorization"))
        assertEquals("1", request.getHeader("Aiden-Protocol-Version"))
        assertTrue(request.getHeader("Accept")!!.contains("text/html"))
    }

    @Test
    fun acceptsAndDecodesAGzippedDocument() = runBlocking {
        val html = "<!doctype html><html><body>" + "<div>row</div>".repeat(2_000) + "</body></html>"
        val gzipped = Buffer()
        GzipSink(gzipped).buffer().use { it.writeUtf8(html) }
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/html; charset=utf-8")
                .setHeader("Content-Encoding", "gzip")
                .setBody(gzipped)
        )

        val document = client.visualDocument("chat-1", "visual-1", AidenVisualDocumentScheme.LIGHT, "aiden")
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!

        assertEquals(html, document)
        assertEquals("gzip", request.getHeader("Accept-Encoding"))
        assertEquals("light", request.requestUrl!!.queryParameter("scheme"))
    }

    @Test
    fun mapsNotFoundAndInvalidRequestToTheMacsErrorEnvelope() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(404)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":{"code":"not_found","message":"Visual not found.","requestId":"req_1","retryable":false}}""")
        )
        try {
            client.visualDocument("chat-1", "gone", AidenVisualDocumentScheme.LIGHT, "aiden")
            fail("A 404 must not decode as a document")
        } catch (error: AidenRemoteClientException.Server) {
            assertEquals(404, error.statusCode)
            assertEquals(AidenRemoteErrorCode.NOT_FOUND, error.body.code)
            assertFalse(error.isCredentialRevoked)
        }

        server.enqueue(
            MockResponse()
                .setResponseCode(400)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":{"code":"invalid_request","message":"Bad theme.","requestId":"req_2","retryable":false}}""")
        )
        try {
            client.visualDocument("chat-1", "visual-1", AidenVisualDocumentScheme.LIGHT, "aiden")
            fail("A 400 must not decode as a document")
        } catch (error: AidenRemoteClientException.Server) {
            assertEquals(400, error.statusCode)
            assertEquals(AidenRemoteErrorCode.INVALID_REQUEST, error.body.code)
        }
    }

    @Test
    fun rejectsANonHtmlBodyAndOneOverTheBound() {
        server.enqueue(
            MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody("{}")
        )
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.visualDocument("chat-1", "visual-1", AidenVisualDocumentScheme.LIGHT, "aiden") }
        }

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/html; charset=utf-8")
                .setBody("x".repeat(AidenVisualDocumentRequest.MAXIMUM_BYTES + 1))
        )
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.visualDocument("chat-1", "visual-1", AidenVisualDocumentScheme.LIGHT, "aiden") }
        }
    }

    @Test
    fun refusesIdsAndThemesThatWouldLeaveTheRouteWithoutSendingAnything() {
        val refused = listOf(
            Triple("chat/1", "visual-1", "aiden"),
            Triple("..", "visual-1", "aiden"),
            Triple("chat-1", ".", "aiden"),
            Triple("chat-1", "visual?x=1", "aiden"),
            Triple("chat-1", "", "aiden"),
            Triple("chat-1", "visual-1", "Dusk"),
            Triple("chat-1", "visual-1", "aiden&scheme=dark")
        )
        for ((chatId, visualId, theme) in refused) {
            assertThrows("$chatId $visualId $theme", AidenRemoteClientException.InvalidResponse::class.java) {
                runBlocking { client.visualDocument(chatId, visualId, AidenVisualDocumentScheme.LIGHT, theme) }
            }
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun theThemeIsTheSharedPresetIdAndTheDynamicPresetAsksForAiden() {
        assertEquals("aiden", AidenVisualDocumentRequest.themeId(AidenThemePresetID.AIDEN))
        assertEquals("monochrome", AidenVisualDocumentRequest.themeId(AidenThemePresetID.MONOCHROME))
        assertEquals("aiden", AidenVisualDocumentRequest.themeId(AidenThemePresetID.DYNAMIC))
        for (preset in AidenThemePresetID.entries) {
            assertTrue(AidenVisualDocumentRequest.isValidTheme(AidenVisualDocumentRequest.themeId(preset)))
        }
    }

    @Test
    fun theViewerOpensOnlyWhenTheMacAnnouncedTheToken() {
        val token = "chat-visual-viewer-v1"
        assertFalse(AidenVisualViewerGate.isAvailable(listOf("chat-visuals-v1"), null))
        assertTrue(AidenVisualViewerGate.isAvailable(listOf("chat-visuals-v1", token), null))
        // Before /server answers, the features this pairing last saw stand in.
        assertTrue(AidenVisualViewerGate.isAvailable(null, listOf(token)))
        assertFalse(AidenVisualViewerGate.isAvailable(null, null))
        // A live answer without the token wins over an older cached one.
        assertFalse(AidenVisualViewerGate.isAvailable(listOf("chat-visuals-v1"), listOf(token)))

        val withToken = AidenServer(instanceId = "mac", name = "Mac", capabilities = emptyList(), features = listOf(token))
        val without = AidenServer(instanceId = "mac", name = "Mac", capabilities = emptyList(), features = listOf("chat-visuals-v1"))
        assertTrue(withToken.supportsChatVisualViewer)
        assertFalse(without.supportsChatVisualViewer)
    }
}
