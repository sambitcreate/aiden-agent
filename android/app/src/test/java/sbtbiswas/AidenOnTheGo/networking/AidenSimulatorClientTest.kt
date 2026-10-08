package sbtbiswas.AidenOnTheGo.networking

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenInstallation
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorHostStatus
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorListing
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorPlatform
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

class AidenSimulatorClientTest {
    private val fixture = AidenMobileSimulatorsFixture.section
    private val json = Json { ignoreUnknownKeys = true }
    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val iphoneId = "5A0C1F3E-0000-4000-8000-000000000001"

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
        client = AidenRemoteClient(installation, "test_credential_123", OkHttpClient.Builder().build())
    }

    @After
    fun teardown() {
        scope.cancel()
        server.shutdown()
    }

    private fun listingJson(edit: (JsonObject) -> JsonObject = { it }) = edit(fixture.getValue("listing").jsonObject).toString()

    // --- Listing decoding ---

    @Test
    fun fixtureListingNamesTheChatDevicesInAttachOrderWithToolVersions() {
        val listing = json.decodeFromString<AidenSimulatorListing>(listingJson())
        assertTrue(listing.sharing)
        assertEquals(AidenSimulatorHostStatus.READY, listing.status.effective)
        assertEquals(listOf(iphoneId, "emulator-5554"), listing.chatDevices.map { it.id })
        assertEquals(listOf(true, false), listing.chatDevices.map { it.isViewableOnPhone })
        assertEquals(AidenSimulatorPlatform.ANDROID, listing.chatDevices[1].platform)
        assertEquals("0.12.0", listing.toolVersions?.hub)
        assertEquals("0.21.12", listing.toolVersions?.agent)
    }

    @Test
    fun sharingOffShowsNoDevices() {
        val listing = json.decodeFromString<AidenSimulatorListing>(fixture.getValue("sharingOff").toString())
        assertFalse(listing.sharing)
        assertTrue(listing.chatDevices.isEmpty())
        // Even a stale chat attachment stays hidden while sharing is off.
        val stale = listing.copy(devices = json.decodeFromString<AidenSimulatorListing>(listingJson()).devices, chatDeviceIds = listOf(iphoneId))
        assertTrue(stale.chatDevices.isEmpty())
    }

    @Test
    fun unknownPlatformStatusAndKindDoNotFailTheListing() {
        val text = listingJson()
            .replace("\"status\":\"ready\"", "\"status\":\"warming-up\"")
            .replace("\"platform\":\"android\"", "\"platform\":\"visionos\"")
            .replace("\"kind\":\"ipad\"", "\"kind\":\"watch\"")
        val listing = json.decodeFromString<AidenSimulatorListing>(text)
        assertEquals(AidenSimulatorHostStatus.UNAVAILABLE, listing.status.effective)
        assertFalse(listing.status.offersRetry)
        assertEquals(3, listing.devices.size)
        assertFalse(listing.devices.single { it.id == "emulator-5554" }.isViewableOnPhone)
        assertTrue(AidenSimulatorHostStatus("error").offersRetry)
        assertTrue(AidenSimulatorHostStatus("stopped").offersRetry)
    }

    @Test
    fun badDeviceIdsAndMissingFieldsAreRejected() {
        assertThrows(Exception::class.java) {
            json.decodeFromString<AidenSimulatorListing>(listingJson().replace("emulator-5554", "../hub/admin"))
        }
        assertThrows(Exception::class.java) {
            json.decodeFromString<AidenSimulatorListing>(listingJson().replace("\"booted\":false,", ""))
        }
        assertThrows(Exception::class.java) {
            json.decodeFromString<AidenSimulatorListing>(listingJson().replace("\"emulator-5554\"]", "\"bad id\"]"))
        }
    }

    // --- Routes ---

    @Test
    fun chatListingSendsCredentialProtocolAndEncodedChatId() = runBlocking<Unit> {
        server.enqueue(MockResponse().setBody(listingJson()))
        val listing = client.simulators("chat&fixture")
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("GET", request.method)
        assertEquals("/api/aiden/v1/simulators?chatId=chat%26fixture", request.path)
        assertEquals("Bearer test_credential_123", request.getHeader("Authorization"))
        assertEquals("1", request.getHeader("Aiden-Protocol-Version"))
        assertEquals(2, listing.chatDevices.size)

        server.enqueue(MockResponse().setBody(fixture.getValue("sharingOff").toString()))
        assertFalse(client.simulators().sharing)
        assertEquals("/api/aiden/v1/simulators", server.takeRequest(5, TimeUnit.SECONDS)!!.path)
    }

    @Test
    fun openAndShutdownPostOnlyTheDeviceId() = runBlocking<Unit> {
        val ipadId = "5A0C1F3E-0000-4000-8000-000000000002"
        server.enqueue(MockResponse().setBody(fixture.getValue("openResponse").toString()))
        val opened = client.openSimulator(ipadId)
        assertTrue(opened.booted)
        val openRequest = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", openRequest.method)
        assertEquals("/api/aiden/v1/simulators/open", openRequest.path)
        assertEquals(buildJsonObject { put("deviceId", ipadId) }, Json.parseToJsonElement(openRequest.body.readUtf8()))

        server.enqueue(MockResponse().setBody(fixture.getValue("shutdownResponse").toString()))
        client.shutdownSimulator(iphoneId)
        val shutdownRequest = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", shutdownRequest.method)
        assertEquals("/api/aiden/v1/simulators/shutdown", shutdownRequest.path)
        assertEquals(buildJsonObject { put("deviceId", iphoneId) }, Json.parseToJsonElement(shutdownRequest.body.readUtf8()))

        // An answer for another device, or a refusal, is not a success.
        server.enqueue(MockResponse().setBody(fixture.getValue("openResponse").toString()))
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) { runBlocking { client.openSimulator(iphoneId) } }
        server.enqueue(MockResponse().setBody("""{"ok":false}"""))
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) { runBlocking { client.shutdownSimulator(iphoneId) } }
    }

    @Test
    fun aRefusedGrantSurfacesAsCapabilityDenied() = runBlocking<Unit> {
        server.enqueue(MockResponse().setResponseCode(403).setBody(fixture.getValue("refusal").toString()))
        val error = runCatching { client.simulators("chat_fixture") }.exceptionOrNull() as AidenRemoteClientException.Server
        assertEquals(403, error.statusCode)
        assertEquals(AidenRemoteErrorCode.CAPABILITY_DENIED, error.body.code)
    }

    @Test
    fun malformedDeviceIdsNeverReachTheNetwork() {
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) { runBlocking { client.openSimulator("../hub") } }
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) { runBlocking { client.shutdownSimulator("") } }
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) { client.simulatorMjpegRequest("a/b") }
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) { client.simulatorInputRequest("a?b") }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun theSimulatorGrantIsNegotiable() = runBlocking<Unit> {
        server.enqueue(MockResponse().setBody("""{"capabilities":["chat:read","simulators:mobile"]}"""))
        val granted = client.updateDeviceCapabilities(listOf(AidenRemoteCapability.SIMULATORS_MOBILE))
        assertTrue(granted.contains(AidenRemoteCapability.SIMULATORS_MOBILE))
        assertEquals(fixture.getValue("capability").toString().trim('"'), AidenRemoteCapability.SIMULATORS_MOBILE.rawValue)
    }

    // --- Stream session ---

    private class RecordingSocket(private val onOpen: (WebSocket) -> Unit = {}) : WebSocketListener() {
        val messages = CopyOnWriteArrayList<ByteArray>()
        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) = onOpen(webSocket)
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            messages += bytes.toByteArray()
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }
    }

    private fun mjpegResponse(body: ByteArray, throttle: Boolean = false) = MockResponse()
        .setHeader("Content-Type", fixture.getValue("mjpeg").jsonObject.getValue("contentType").toString().trim('"'))
        .setBody(Buffer().write(body))
        .apply { if (throttle) throttleBody(16, 1, TimeUnit.SECONDS) }

    private fun session(retryDelayMillis: Long = 60_000) = AidenSimulatorStreamSession(
        httpClient = client.simulatorStreamingClient,
        mjpegRequest = client.simulatorMjpegRequest(iphoneId),
        inputRequest = client.simulatorInputRequest(iphoneId),
        scope = scope,
        decodeFrame = { jpeg: ByteArray -> jpeg },
        retryDelayMillis = retryDelayMillis
    )

    private fun waitUntil(message: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (!condition()) {
            if (System.nanoTime() > deadline) throw AssertionError("Timed out waiting: $message")
            Thread.sleep(10)
        }
    }

    @Test
    fun sessionStreamsFramesThenOpensTheInputSocketWithoutAnOrigin() {
        val frames = AidenMobileSimulatorsFixture.mjpegFrames("framesBase64")
        val socket = RecordingSocket { ws ->
            val config = """{"width":1206,"height":2622,"orientation":"landscape_left"}""".toByteArray()
            ws.send((byteArrayOf(0x82.toByte()) + config).toByteString())
        }
        server.enqueue(mjpegResponse(AidenMobileSimulatorsFixture.mjpeg("streamBase64")))
        server.enqueue(MockResponse().withWebSocketUpgrade(socket))

        val session = session()
        session.start()
        waitUntil("latest frame") { session.frame.value?.contentEquals(frames.last()) == true }
        waitUntil("input connected") { session.state.value.inputConnected }
        waitUntil("keyboard-off message") { socket.messages.isNotEmpty() }
        waitUntil("screen config") { session.state.value.screen != null }

        val keyboard = socket.messages.first()
        assertEquals(0x0D, keyboard[0].toInt() and 0xFF)
        assertEquals(buildJsonObject { put("enabled", false) }, Json.parseToJsonElement(String(keyboard, 1, keyboard.size - 1)))
        assertEquals(AidenSimulatorOrientation.LANDSCAPE_LEFT, session.state.value.screen?.orientation)

        // Input is mapped through the last screen config before it is sent.
        assertTrue(session.send(AidenSimulatorInput.touch(AidenSimulatorTouchPhase.BEGIN, 0.25, 0.75, session.state.value.screen)))
        waitUntil("touch message") { socket.messages.size >= 2 }
        assertArrayEquals(
            AidenSimulatorInput.touch(AidenSimulatorTouchPhase.BEGIN, 0.25, 0.75, AidenSimulatorScreen(1206, 2622, AidenSimulatorOrientation.LANDSCAPE_LEFT)),
            socket.messages[1]
        )

        val stream = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/api/aiden/v1/simulators/hub/vendor/serve-sim/helper/$iphoneId/stream.mjpeg", stream.path)
        assertEquals("Bearer test_credential_123", stream.getHeader("Authorization"))
        val upgrade = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/api/aiden/v1/simulators/hub/vendor/serve-sim/helper/ws?device=$iphoneId", upgrade.path)
        assertEquals("Bearer test_credential_123", upgrade.getHeader("Authorization"))
        assertEquals("1", upgrade.getHeader("Aiden-Protocol-Version"))
        assertNull(upgrade.getHeader("Origin"))

        session.stop()
        assertFalse(session.state.value.inputConnected)
        assertFalse(session.send(AidenSimulatorInput.button(AidenSimulatorButton.HOME)))
    }

    @Test
    fun aRefusedUpgradeStopsWithoutRetrying() {
        server.enqueue(mjpegResponse(AidenMobileSimulatorsFixture.mjpeg("streamBase64"), throttle = true))
        server.enqueue(MockResponse().setResponseCode(403).setBody(fixture.getValue("refusal").toString()))

        val session = session(retryDelayMillis = 50)
        session.start()
        waitUntil("refusal") { session.state.value.phase == AidenSimulatorStreamPhase.FAILED }
        assertEquals(AidenSimulatorStreamFailure.REFUSED, session.state.value.failure)
        Thread.sleep(300)
        assertEquals("no retry after a refusal", 2, server.requestCount)
    }

    @Test
    fun anUnauthorizedCloseStopsWithoutRetrying() {
        server.enqueue(mjpegResponse(AidenMobileSimulatorsFixture.mjpeg("streamBase64"), throttle = true))
        server.enqueue(MockResponse().withWebSocketUpgrade(RecordingSocket { it.close(4401, "unauthorized") }))

        val session = session(retryDelayMillis = 50)
        session.start()
        waitUntil("refusal") { session.state.value.phase == AidenSimulatorStreamPhase.FAILED }
        assertEquals(AidenSimulatorStreamFailure.REFUSED, session.state.value.failure)
        Thread.sleep(300)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun anOrdinaryCloseRetriesTheSocketOnce() {
        server.enqueue(mjpegResponse(AidenMobileSimulatorsFixture.mjpeg("streamBase64"), throttle = true))
        server.enqueue(MockResponse().withWebSocketUpgrade(RecordingSocket { it.close(1011, "restarting") }))
        server.enqueue(MockResponse().withWebSocketUpgrade(RecordingSocket { it.close(1011, "restarting") }))

        val session = session(retryDelayMillis = 50)
        session.start()
        waitUntil("one retry") { server.requestCount == 3 }
        Thread.sleep(300)
        assertEquals("a single retry", 3, server.requestCount)
        assertFalse(session.state.value.inputConnected)
        assertTrue(session.state.value.phase != AidenSimulatorStreamPhase.FAILED)
        session.stop()
    }
}
