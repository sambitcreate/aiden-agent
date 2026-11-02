package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.chat.AidenUploadProgress
import sbtbiswas.AidenOnTheGo.features.remote.aidenProgressCapabilitiesToRequest
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestRawUploads
import sbtbiswas.AidenOnTheGo.features.remote.aidenShouldRequestRawUploads
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentUpload
import sbtbiswas.AidenOnTheGo.models.AidenInstallation
import sbtbiswas.AidenOnTheGo.models.AidenServer
import sbtbiswas.AidenOnTheGo.networking.AidenRawAttachmentUpload
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import java.time.Instant
import java.util.Base64
import java.util.concurrent.TimeUnit

/** Contract revision 50 (`attachments:raw`), read from the fixture every client shares. */
class AidenRawUploadsTest {
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject.getValue("rawUploads").jsonObject
    }
    private val request get() = fixture.getValue("request").jsonObject
    private fun text(key: String) = request.getValue(key).jsonPrimitive.content

    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        client = AidenRemoteClient(
            endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
            credential = "test_credential_123",
            customOkHttpClient = OkHttpClient()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
    }

    private fun staged() = MockResponse().setResponseCode(201).setHeader("Content-Type", "application/json")
        .setBody(fixture.getValue("response").toString())

    private val picture get() = AidenAttachmentUpload.Image(
        name = text("name"),
        mimeType = text("contentType"),
        data = text("bodyBase64")
    )

    @Test
    fun aPictureGoesAsItsOwnBytesWithTheNameEveryClientSpellsAlike() = runBlocking<Unit> {
        server.enqueue(staged())
        val heard = mutableListOf<Float>()
        val reference = client.uploadAttachment("chat_fixture_01", picture, rawImages = true) { heard += it }

        assertEquals(fixture.getValue("response").jsonObject.getValue("id").jsonPrimitive.content, reference.id)
        val sent = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", sent.method)
        assertEquals("/api/aiden/v1" + text("path"), sent.requestUrl!!.encodedPath)
        assertEquals(text("contentType"), sent.getHeader("Content-Type"))
        assertEquals(request.getValue("contentLength").jsonPrimitive.int.toString(), sent.getHeader("Content-Length"))
        assertEquals(text("encodedName"), sent.getHeader(text("nameHeader")))
        assertArrayEquals(Base64.getDecoder().decode(text("bodyBase64")), sent.body.readByteArray())
        assertEquals("the bar reaches the end", 1f, heard.last())
        assertEquals("it only moves forward", heard.sorted(), heard)
    }

    @Test
    fun withoutTheGrantOrForTextTheJsonEnvelopeStays() = runBlocking<Unit> {
        server.enqueue(staged())
        client.uploadAttachment("chat_fixture_01", picture, rawImages = false)
        val json = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertTrue(json.getHeader("Content-Type")!!.startsWith("application/json"))
        assertNull(json.getHeader("Aiden-Attachment-Name"))
        val envelope = Json.parseToJsonElement(json.body.readUtf8()).jsonObject
        assertEquals(text("bodyBase64"), envelope.getValue("data").jsonPrimitive.content)
        assertEquals("image", envelope.getValue("kind").jsonPrimitive.content)

        server.enqueue(staged())
        client.uploadAttachment(
            "chat_fixture_01",
            AidenAttachmentUpload.Text(name = "notes.md", mimeType = "text/markdown", text = "# Notes"),
            rawImages = true
        )
        val textUpload = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertTrue(textUpload.getHeader("Content-Type")!!.startsWith("application/json"))
        assertNull(textUpload.getHeader("Aiden-Attachment-Name"))
    }

    @Test
    fun whatTheRawRouteRefusesKeepsTheEnvelope() {
        val png = Base64.getEncoder().encodeToString(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))
        assertNotNull(AidenRawAttachmentUpload.from(AidenAttachmentUpload.Image("a.png", "image/png", png)))
        assertNotNull(AidenRawAttachmentUpload.from(AidenAttachmentUpload.Image("a.jpg", "image/jpeg", png)))
        assertNull(AidenRawAttachmentUpload.from(AidenAttachmentUpload.Image("a.gif", "image/gif", png)))
        assertNull(AidenRawAttachmentUpload.from(AidenAttachmentUpload.Image("a.png", "image/png", "")))
        assertNull(AidenRawAttachmentUpload.from(AidenAttachmentUpload.Image("a.png", "image/png", "not base64!")))
        val big = Base64.getEncoder().encodeToString(ByteArray(AidenRawAttachmentUpload.MAX_BYTES + 1))
        assertNull(AidenRawAttachmentUpload.from(AidenAttachmentUpload.Image("big.png", "image/png", big)))
        assertNull(
            "a name longer than 2,048 encoded characters",
            AidenRawAttachmentUpload.from(AidenAttachmentUpload.Image("é".repeat(400), "image/png", png))
        )
        assertEquals(text("encodedName"), AidenRawAttachmentUpload.encodeName(text("name")))
        // Only RFC 3986 unreserved characters stay as they are, as on the Mac.
        assertEquals("it%27s%20%281%29%2A%21.png", AidenRawAttachmentUpload.encodeName("it's (1)*!.png"))
        assertEquals("a-b_c.d~e.jpg", AidenRawAttachmentUpload.encodeName("a-b_c.d~e.jpg"))
    }

    @Test
    fun theBarCoversTheBatchAndOnlyMovesForward() {
        val start = AidenUploadProgress(index = 1, count = 4, fraction = 0f)
        assertEquals(25, start.percent)
        assertNull("half a percent of the batch does not redraw", start.advancedTo(0.02f))
        val half = requireNotNull(start.advancedTo(0.5f))
        assertEquals(37, half.percent)
        assertNull("a late report never moves the bar back", half.advancedTo(0.4f))
        assertEquals(50, requireNotNull(half.advancedTo(1f)).percent)
        assertEquals(1f, AidenUploadProgress(0, 1, 3f).overall)
    }

    private fun mac(capabilities: List<AidenRemoteCapability>, offers: List<AidenRemoteCapability>) = AidenServer(
        instanceId = "test_instance",
        name = "Mac",
        capabilities = capabilities,
        serverCapabilities = (capabilities + offers).distinct()
    )

    private fun installationHolding(held: List<AidenRemoteCapability>) = AidenInstallation(
        instanceId = "test_instance",
        deviceId = "test_device",
        name = "Mac",
        endpoint = "https://aiden.test/api/aiden/v1",
        serverSpkiSha256 = "sha256/test",
        deviceCapabilities = held,
        serverCapabilities = held,
        createdAt = Instant.parse("2026-11-01T09:00:00Z")
    )

    private val base = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE)

    private fun serverBody(capabilities: List<String>) = """
        {"protocolVersion":1,"instanceId":"test_instance","name":"Mac","appVersion":"1.0.0","connectionMode":"lan",
         "serverTime":"2026-11-01T09:00:00.000Z",
         "capabilities":${JsonArray(capabilities.map(::JsonPrimitive))},
         "serverCapabilities":${JsonArray(capabilities.map(::JsonPrimitive))}}
    """.trimIndent()

    @Test
    fun theRawGrantIsAskedForAloneOnlyFromAMacThatOffersIt() = runBlocking {
        val offering = mac(base, offers = listOf(AidenRemoteCapability.ATTACHMENTS_RAW))
        assertFalse("offered is not held", offering.supportsRawUploads)
        assertTrue(aidenShouldRequestRawUploads(offering, installationHolding(base)))
        assertFalse(
            "it never rides along with the progress grants",
            aidenProgressCapabilitiesToRequest(offering, installationHolding(base)).contains(AidenRemoteCapability.ATTACHMENTS_RAW)
        )
        assertFalse("not offered", aidenShouldRequestRawUploads(mac(base, emptyList()), installationHolding(base)))
        assertFalse(
            "already held",
            aidenShouldRequestRawUploads(offering, installationHolding(base + AidenRemoteCapability.ATTACHMENTS_RAW))
        )

        val names = base.map { it.rawValue }
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"capabilities":${JsonArray((names + "attachments:raw").map(::JsonPrimitive))}}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody(serverBody(names + "attachments:raw")))
        val granted = requireNotNull(aidenRequestRawUploads(client, offering, installationHolding(base)))
        val ask = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/api/aiden/v1/device/capabilities", ask.path)
        assertEquals(
            listOf("attachments:raw"),
            Json.parseToJsonElement(ask.body.readUtf8()).jsonObject.getValue("accepts").jsonArray.map { it.jsonPrimitive.content }
        )
        assertEquals(base + AidenRemoteCapability.ATTACHMENTS_RAW, granted.granted)
        assertTrue("pictures now go raw", granted.server.supportsRawUploads)
        server.takeRequest(5, TimeUnit.SECONDS)

        // An older Mac that does not know the name refuses it; the pairing keeps what it had.
        for (status in listOf(400, 404)) {
            server.enqueue(MockResponse().setResponseCode(status).setBody(
                """{"error":{"code":"${if (status == 404) "not_found" else "invalid_request"}","message":"Nope.","requestId":"req_1","retryable":false}}"""
            ))
            assertNull("$status leaves the pairing as it was", aidenRequestRawUploads(client, offering, installationHolding(base)))
            server.takeRequest(5, TimeUnit.SECONDS)
        }
    }
}
