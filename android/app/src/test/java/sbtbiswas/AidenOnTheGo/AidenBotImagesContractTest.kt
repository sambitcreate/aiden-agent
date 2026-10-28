package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotSessionFeedGrants
import sbtbiswas.AidenOnTheGo.features.remote.aidenProgressCapabilitiesToRequest
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestBotImages
import sbtbiswas.AidenOnTheGo.features.remote.aidenShouldRequestBotImages
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.time.Instant

/**
 * Contract revision 43, `bot:images`: an image a Bot shared reaches a phone that holds the grant
 * as a `shared_image` entry without its bytes, which the phone reads from the Bot's session
 * route. Every other device reads the same entry as an assistant line.
 */
class AidenBotImagesContractTest {
    private val json = AidenBotWireJson.json
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }
    private val botImages get() = fixture.getValue("botImages").jsonObject
    private val entry get() = botImages.getValue("entry").jsonObject

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

    private fun decodeEntry(element: JsonElement): AidenBotSessionEntry =
        json.decodeFromJsonElement(AidenBotSessionEntry.serializer(), element)

    private fun decodes(element: JsonElement): Boolean = try {
        decodeEntry(element)
        true
    } catch (_: Exception) {
        false
    }

    @Test
    fun theFixtureIsAtRevision41AndNamesTheGrant() {
        assertTrue(fixture.getValue("contractRevision").jsonPrimitive.content.toInt() >= 43)
        assertEquals(AidenRemoteCapability.BOT_IMAGES, AidenRemoteCapability(botImages.getValue("capability").jsonPrimitive.content))
        assertTrue(AidenRemoteCapability.NEGOTIABLE.contains(AidenRemoteCapability.BOT_IMAGES))
    }

    @Test
    fun aSharedImageDecodesAsTheMacSendsItAndOtherDevicesReadALine() {
        val image = decodeEntry(entry) as AidenBotSessionEntry.SharedImage
        assertEquals(entry.getValue("id").jsonPrimitive.content, image.id)
        assertEquals(entry.getValue("name").jsonPrimitive.content, image.name)
        assertEquals(entry.getValue("mimeType").jsonPrimitive.content, image.mimeType)
        assertEquals(entry.getValue("size").jsonPrimitive.content.toInt(), image.size)
        assertEquals(AidenAttachmentKind.IMAGE, image.attachment.kind)
        // The phone's cache writes the entry back in the shape the Mac sent.
        assertEquals(entry, json.encodeToJsonElement(AidenBotSessionEntry.serializer(), image))

        val line = decodeEntry(botImages.getValue("legacyEntry")) as AidenBotSessionEntry.Message
        assertEquals(AidenBotMessageRole.ASSISTANT, line.role)
        assertEquals(image.id, line.id)

        assertTrue(
            "the fixture's image path is the route this phone reads",
            botImages.getValue("imagePath").jsonPrimitive.content.endsWith("/session/images/${image.id}")
        )
    }

    @Test
    fun aSharedImageWithBytesOrOutsideTheLimitsIsRefused() {
        val refused = mapOf(
            "inline bytes" to JsonObject(entry + ("data" to JsonPrimitive("iVBORw0KGgo="))),
            "a GIF" to JsonObject(entry + ("mimeType" to JsonPrimitive("image/gif"))),
            "an empty image" to JsonObject(entry + ("size" to JsonPrimitive(0))),
            "an image over the limit" to JsonObject(entry + ("size" to JsonPrimitive(8 * 1_048_576 + 1))),
            "a blank name" to JsonObject(entry + ("name" to JsonPrimitive(""))),
            "a long name" to JsonObject(entry + ("name" to JsonPrimitive("a".repeat(256)))),
            "no size" to JsonObject(entry - "size")
        )
        for ((label, sample) in refused) assertFalse(label, decodes(sample))
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
        createdAt = Instant.parse("2026-10-27T09:00:00Z")
    )

    private val base = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ)

    private fun serverBody(capabilities: List<String>) = """
        {"protocolVersion":1,"instanceId":"test_instance","name":"Mac","appVersion":"1.0.0","connectionMode":"lan",
         "serverTime":"2026-10-27T09:00:00.000Z",
         "capabilities":${JsonArray(capabilities.map(::JsonPrimitive))},
         "serverCapabilities":${JsonArray(capabilities.map(::JsonPrimitive))}}
    """.trimIndent()

    @Test
    fun theGrantIsAskedForAloneOnlyFromAMacThatOffersIt() = runBlocking {
        val offering = mac(base, offers = listOf(AidenRemoteCapability.BOT_IMAGES))
        assertTrue(offering.offersBotImages)
        assertFalse("offered is not held", offering.supportsBotImages)
        assertTrue(aidenShouldRequestBotImages(offering, installationHolding(base)))
        assertFalse(aidenProgressCapabilitiesToRequest(offering, installationHolding(base)).contains(AidenRemoteCapability.BOT_IMAGES))
        assertFalse("not offered", aidenShouldRequestBotImages(mac(base, emptyList()), installationHolding(base)))

        val names = base.map { it.rawValue }
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"capabilities":${JsonArray((names + "bot:images").map(::JsonPrimitive))}}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody(serverBody(names + "bot:images")))
        val granted = requireNotNull(aidenRequestBotImages(client, offering, installationHolding(base)))
        val ask = server.takeRequest()
        assertEquals("/api/aiden/v1/device/capabilities", ask.path)
        assertEquals(
            listOf("bot:images"),
            Json.parseToJsonElement(ask.body.readUtf8()).jsonObject.getValue("accepts").jsonArray.map { it.jsonPrimitive.content }
        )
        assertEquals(base + AidenRemoteCapability.BOT_IMAGES, granted.granted)
        assertTrue(granted.server.supportsBotImages)

        server.enqueue(MockResponse().setResponseCode(404).setBody(
            """{"error":{"code":"not_found","message":"Nope.","requestId":"req_1","retryable":false}}"""
        ))
        assertNull("a Mac that refuses the name leaves the pairing as it was", aidenRequestBotImages(client, offering, installationHolding(base)))

        // A Bot chat's feed is shaped by the grant, so a chat that opened without it reopens.
        assertFalse(aidenBotSessionFeedGrants(installationHolding(base)).contains(AidenRemoteCapability.BOT_IMAGES))
        assertTrue(aidenBotSessionFeedGrants(installationHolding(base + AidenRemoteCapability.BOT_IMAGES)).contains(AidenRemoteCapability.BOT_IMAGES))
    }

    private fun image(contentType: String, bytes: ByteArray, noStore: Boolean = true, nosniff: Boolean = true): MockResponse {
        val response = MockResponse().setResponseCode(200).setHeader("Content-Type", contentType).setBody(Buffer().write(bytes))
        if (noStore) response.setHeader("Cache-Control", "no-store")
        if (nosniff) response.setHeader("X-Content-Type-Options", "nosniff")
        return response
    }

    @Test
    fun theClientReadsAnImageFromItsRouteAndAcceptsOnlyPngOrJpeg() = runBlocking {
        val path = "/api/aiden/v1" + botImages.getValue("imagePath").jsonPrimitive.content
        val bytes = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        val entryId = entry.getValue("id").jsonPrimitive.content
        for (type in listOf("image/png", "image/jpeg")) {
            server.enqueue(image(type, bytes))
            assertArrayEquals(bytes, client.botSessionImage("bot_fixture_01", entryId))
            val read = server.takeRequest()
            assertEquals("GET", read.method)
            assertEquals(path, read.path)
            assertEquals("Bearer test_credential_123", read.getHeader("Authorization"))
        }
        for (wrong in listOf(
            image("text/html", bytes),
            image("image/png", bytes, noStore = false),
            image("image/png", bytes, nosniff = false),
            image("image/png", ByteArray(0))
        )) {
            server.enqueue(wrong)
            assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
                runBlocking { client.botSessionImage("bot_fixture_01", entryId) }
            }
        }
        val before = server.requestCount
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.botSessionImage("bot_fixture_01", "../avatar") }
        }
        assertEquals("an unsafe entry id never leaves the phone", before, server.requestCount)
    }
}
