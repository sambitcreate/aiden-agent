package sbtbiswas.AidenOnTheGo.features.simulators

import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlin.math.cos
import kotlin.math.sin
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorDevice
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorListing
import sbtbiswas.AidenOnTheGo.networking.AidenMobileSimulatorsFixture
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorDisplayRotation
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorInput
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorOrientation
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorScreen
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorStreamSession
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorTouchPhase

class AidenSimulatorViewerTest {
    // --- Controls overlay ---

    @Test
    fun controlsGreetWhileConnectingThenHideOnceInputConnects() {
        var controls = AidenSimulatorControls()
        assertTrue(controls.visible)
        // No backdrop exists before input connects, so a tap there changes nothing.
        assertEquals(controls, controls.backdropTapped())

        controls = controls.withInputConnected(true)
        assertFalse(controls.visible)

        // Losing input keeps the user's choice; reconnecting hides the controls again.
        controls = controls.shown().withInputConnected(false)
        assertTrue(controls.visible)
        controls = controls.withInputConnected(true)
        assertFalse(controls.visible)
        // A repeated "connected" report is not a new connection.
        assertTrue(controls.shown().withInputConnected(true).visible)
    }

    @Test
    fun grabberShakeAndBackdropMoveTheOverlay() {
        val connected = AidenSimulatorControls().withInputConnected(true)
        assertTrue(connected.shown().visible)
        assertTrue(connected.toggled().visible)
        assertFalse(connected.toggled().toggled().visible)
        assertFalse(connected.shown().backdropTapped().visible)
    }

    @Test
    fun backRevealsHiddenControlsBeforeLeaving() {
        val hidden = AidenSimulatorControls().withInputConnected(true)
        val (revealed, exitsFirst) = hidden.back()
        assertFalse(exitsFirst)
        assertTrue(revealed.visible)
        val (_, exitsSecond) = revealed.back()
        assertTrue(exitsSecond)
    }

    // --- Shake detector ---

    private fun AidenShakeDetector.resting(t: Long) = onSample(0.0, 0.0, -1.0, t)
    private fun AidenShakeDetector.jolt(t: Long) = onSample(2.2, 0.4, -1.0, t)

    @Test
    fun gravityAndASingleJoltAreNotAShake() {
        val detector = AidenShakeDetector()
        assertFalse(detector.resting(0))
        assertFalse(detector.jolt(100))
        assertFalse(detector.resting(200))
        // Too far after the first jolt to pair with it.
        assertFalse(detector.jolt(900))
    }

    @Test
    fun twoJoltsWithinTheWindowShakeOnceThenCoolDown() {
        val detector = AidenShakeDetector()
        assertFalse(detector.jolt(0))
        assertTrue(detector.jolt(300))
        assertFalse(detector.jolt(400))
        assertFalse(detector.jolt(600))
        assertFalse(detector.jolt(1_400))
        assertTrue(detector.jolt(1_500))
    }

    @Test
    fun movementBelowTheThresholdIsIgnored() {
        val detector = AidenShakeDetector()
        for (t in 0L..2_000L step 50) assertFalse(detector.onSample(1.2, 0.9, -0.5, t))
    }

    @Test
    fun androidSamplesAreConvertedFromMetersPerSecondSquared() {
        val detector = AidenShakeDetector()
        val g = AidenShakeDetector.STANDARD_GRAVITY.toFloat()
        // Gravity alone (9.81 m/s²) is 1 g, well under the threshold.
        assertFalse(detector.onSensorSample(0f, 0f, g, 0))
        assertFalse(detector.onSensorSample(2.2f * g, 0f, -g, 100_000_000))
        assertTrue(detector.onSensorSample(2.2f * g, 0f, -g, 400_000_000))
    }

    // --- Touch mapping ---

    @Test
    fun touchesMapIntoTheAspectFitFrameAndOutsideTouchesAreIgnored() {
        // A portrait frame letterboxed in a square container.
        val rect = AidenFittedRect.aspectFit(1000f, 1000f, 500f, 1000f)
        assertEquals(AidenFittedRect(250f, 0f, 500f, 1000f), rect)
        assertEquals(0.25 to 0.75, rect.normalized(375f, 750f))
        assertNull(rect.normalized(100f, 500f))
        assertNull(rect.normalized(800f, 500f))
        assertEquals(0.0 to 0.5, rect.normalized(100f, 500f, clamp = true))
        assertNull(AidenFittedRect.aspectFit(0f, 100f, 10f, 10f).normalized(0f, 0f))
    }

    // --- Display orientation ---

    private fun encodedPoint(x: Double, y: Double, screen: AidenSimulatorScreen): Pair<Double, Double> {
        val message = AidenSimulatorInput.touch(AidenSimulatorTouchPhase.BEGIN, x, y, screen)
        val payload = Json.parseToJsonElement(String(message, 1, message.size - 1, Charsets.UTF_8)).jsonObject
        return payload.getValue("x").jsonPrimitive.double to payload.getValue("y").jsonPrimitive.double
    }

    @Test
    fun rawPortraitFramesAreShownTurnedToTheDeviceOrientation() {
        // serve-sim's raw portrait framebuffer, 1:2, in a square 400 px viewer.
        val upright = AidenFittedRect(100f, 0f, 200f, 400f)
        val sideways = AidenFittedRect(0f, 100f, 400f, 200f)
        val cases = listOf(
            Triple(AidenSimulatorOrientation.PORTRAIT, AidenSimulatorDisplayRotation.NONE, upright),
            Triple(AidenSimulatorOrientation.LANDSCAPE_LEFT, AidenSimulatorDisplayRotation.CLOCKWISE, sideways),
            Triple(AidenSimulatorOrientation.PORTRAIT_UPSIDE_DOWN, AidenSimulatorDisplayRotation.HALF_TURN, upright),
            Triple(AidenSimulatorOrientation.LANDSCAPE_RIGHT, AidenSimulatorDisplayRotation.COUNTER_CLOCKWISE, sideways)
        )
        for ((orientation, rotation, rect) in cases) {
            assertEquals("$orientation", rotation, AidenSimulatorDisplayRotation.of(AidenSimulatorScreen(1206, 2622, orientation)))
            assertEquals("$orientation", rect, AidenFittedRect.displayed(400f, 400f, 100f, 200f, rotation))
        }
        // A landscape-sized config already streams landscape frames: nothing turns.
        val rotated = AidenSimulatorScreen(2622, 1206, AidenSimulatorOrientation.LANDSCAPE_LEFT)
        assertEquals(AidenSimulatorDisplayRotation.NONE, AidenSimulatorDisplayRotation.of(rotated))
        assertEquals(sideways, AidenFittedRect.displayed(400f, 400f, 200f, 100f, AidenSimulatorDisplayRotation.NONE))
        assertEquals(AidenSimulatorDisplayRotation.NONE, AidenSimulatorDisplayRotation.of(null))
    }

    @Test
    fun aTapLandsOnTheRawPixelShownUnderIt() {
        // Draw raw pixels the way the viewer does (unturned size, turned clockwise
        // by `degrees` about the shown rect's center), then tap there: the encoded
        // touch must name the same raw pixel.
        val frameWidth = 1206f
        val frameHeight = 2622f
        val rawPoints = listOf(0.25 to 0.75, 0.1 to 0.2, 0.9 to 0.6)
        for (orientation in AidenSimulatorOrientation.entries) {
            val screen = AidenSimulatorScreen(frameWidth.toInt(), frameHeight.toInt(), orientation)
            val rotation = AidenSimulatorDisplayRotation.of(screen)
            val shown = AidenFittedRect.displayed(1080f, 1920f, frameWidth, frameHeight, rotation)
            val drawnWidth = if (rotation.isSideways) shown.height else shown.width
            val drawnHeight = if (rotation.isSideways) shown.width else shown.height
            val radians = Math.toRadians(rotation.degrees.toDouble())
            for ((u, v) in rawPoints) {
                val dx = (u - 0.5) * drawnWidth
                val dy = (v - 0.5) * drawnHeight
                val x = shown.left + shown.width / 2 + dx * cos(radians) - dy * sin(radians)
                val y = shown.top + shown.height / 2 + dx * sin(radians) + dy * cos(radians)
                val tap = shown.normalized(x.toFloat(), y.toFloat())
                assertNotNull("$orientation ($u, $v)", tap)
                val (rawX, rawY) = encodedPoint(tap!!.first, tap.second, screen)
                assertEquals("$orientation x", u, rawX, 1e-4)
                assertEquals("$orientation y", v, rawY, 1e-4)
            }
        }
    }

    @Test
    fun fixtureTouchVectorsTappedOnTheShownFrameEncodeTheirPayloads() {
        val vectors = AidenMobileSimulatorsFixture.section.getValue("inputMessages").jsonArray.map { it.jsonObject }
        var checked = 0
        for (vector in vectors) {
            val command = vector.getValue("command").jsonObject
            val screenJson = vector["screen"] as? JsonObject
            if (command.getValue("kind").jsonPrimitive.content != "touch" || screenJson == null) continue
            val screen = AidenSimulatorScreen(
                screenJson.getValue("width").jsonPrimitive.int,
                screenJson.getValue("height").jsonPrimitive.int,
                AidenSimulatorOrientation.fromWire(screenJson.getValue("orientation").jsonPrimitive.content)!!
            )
            // The fixture's command point is in the displayed frame.
            val shown = AidenFittedRect.displayed(
                1080f, 1920f, screen.width.toFloat(), screen.height.toFloat(), AidenSimulatorDisplayRotation.of(screen)
            )
            val tap = shown.normalized(
                shown.left + command.getValue("x").jsonPrimitive.double.toFloat() * shown.width,
                shown.top + command.getValue("y").jsonPrimitive.double.toFloat() * shown.height
            )!!
            val (rawX, rawY) = encodedPoint(tap.first, tap.second, screen)
            val payload = vector.getValue("payload").jsonObject
            assertEquals(payload.getValue("x").jsonPrimitive.double, rawX, 1e-4)
            assertEquals(payload.getValue("y").jsonPrimitive.double, rawY, 1e-4)
            checked++
        }
        assertTrue("every orientation vector is exercised", checked >= 5)
    }

    // --- Frame decoding ---

    @Test
    fun aTurnedFrameSubsamplesAgainstTheWayItIsDrawn() {
        // A raw portrait frame shown landscape in a 1080x540 viewer is drawn 1080 wide
        // along its own height, so it may shrink by 2 but not by 4.
        val turned = AidenSimulatorFrameSampling.inSampleSize(1206, 2622, 1080, 540, AidenSimulatorDisplayRotation.CLOCKWISE)
        assertEquals(2, turned)
        assertTrue(2622 / turned >= 1080)
        // Unturned, the same viewer would have sampled it below its drawn size.
        assertEquals(4, AidenSimulatorFrameSampling.inSampleSize(1206, 2622, 1080, 540))
    }

    @Test
    fun framesSubsampleOnlyWhileTheyStayAtLeastAsLargeAsTheyAreDrawn() {
        // An unknown or empty viewer decodes at full size.
        assertEquals(1, AidenSimulatorFrameSampling.inSampleSize(1206, 2622, 0, 0))
        // A full-screen viewer on a phone shows the frame near its own size.
        assertEquals(1, AidenSimulatorFrameSampling.inSampleSize(1206, 2622, 1080, 2340))
        // A small viewer: 1206x2622 fit into 300x600 shrinks by 4.37, so a quarter still covers it.
        assertEquals(4, AidenSimulatorFrameSampling.inSampleSize(1206, 2622, 300, 600))
        for ((view, frame) in listOf((300 to 600) to (1206 to 2622), (540 to 540) to (2048 to 2732), (100 to 1000) to (1179 to 2556))) {
            val sample = AidenSimulatorFrameSampling.inSampleSize(frame.first, frame.second, view.first, view.second)
            assertEquals("power of two", 0, sample and (sample - 1))
            val fit = minOf(view.first.toDouble() / frame.first, view.second.toDouble() / frame.second)
            // Never smaller than drawn, and the next power of two would be.
            assertTrue(frame.first / sample >= frame.first * fit - 1)
            assertTrue(frame.first / (sample * 2.0) < frame.first * fit)
        }
    }

    @Test
    fun aBitmapIsReusedOnlyOnceTheScreenHasMovedTwoFramesPastIt() {
        val policy = AidenFrameReusePolicy<String>()
        listOf("a", "b", "c").forEach(policy::published)
        // Nothing is free until the UI reports what it shows.
        assertNull(policy.acquire { true })
        policy.shown("b")
        // "b" is on screen and "a" may still be drawing: neither is reused.
        assertNull(policy.acquire { true })
        policy.shown("c")
        assertEquals("a", policy.acquire { true })
        assertNull(policy.acquire { true })

        // Frames the UI skipped ("d") are released with everything older than the shown one's
        // predecessor. Only the newest four stay tracked, so "b" was already forgotten, never freed.
        listOf("d", "e", "f").forEach(policy::published)
        policy.shown("f")
        val freed = generateSequence { policy.acquire { true } }.toList()
        assertEquals(listOf("c", "d"), freed)
        // A reused frame is never handed out twice, and a frame that does not fit stays free.
        listOf("g", "h").forEach(policy::published)
        policy.shown("h")
        assertNull(policy.acquire { it == "zzz" })
        assertEquals("e", policy.acquire { it == "e" })
        assertNull(policy.acquire { it == "e" })
        assertEquals("f", policy.acquire { true })
    }

    @Test
    fun framesTheUiNeverReportsAreForgottenNotReused() {
        val policy = AidenFrameReusePolicy<String>(trackedLimit = 4)
        (1..10).map { "frame-$it" }.forEach(policy::published)
        // Old untracked frames are left to the garbage collector.
        policy.shown("frame-1")
        assertNull(policy.acquire { true })
        policy.shown("frame-10")
        assertEquals(listOf("frame-7", "frame-8"), generateSequence { policy.acquire { true } }.toList())
        policy.clear()
        assertNull(policy.acquire { true })
    }

    // --- Viewer model ---

    private class FakeRemote(
        var listing: AidenSimulatorListing,
        var access: Boolean = true,
        /** Hand out real sessions aimed at a closed local port instead of none. */
        private val liveSessions: Boolean = false
    ) : AidenSimulatorRemote {
        val listingRequests = mutableListOf<String?>()
        val opened = mutableListOf<String>()
        val shutdowns = mutableListOf<String>()
        val sessions = mutableListOf<String>()
        val created = mutableListOf<AidenSimulatorStreamSession<ImageBitmap>>()

        override val hasAccess: Boolean get() = access
        override suspend fun simulators(chatId: String?): AidenSimulatorListing {
            listingRequests += chatId
            return listing
        }
        override suspend fun open(deviceId: String): AidenSimulatorDevice {
            opened += deviceId
            return listing.devices.single { it.id == deviceId }.copy(booted = true)
        }
        override suspend fun shutdown(deviceId: String) {
            shutdowns += deviceId
        }
        // No network in unit tests: the model reports the stream as unreachable.
        override fun session(
            deviceId: String,
            scope: CoroutineScope,
            decodeFrame: (ByteArray) -> ImageBitmap?
        ): AidenSimulatorStreamSession<ImageBitmap>? {
            sessions += deviceId
            if (!liveSessions) return null
            val unreachable = Request.Builder().url("http://127.0.0.1:9/").build()
            return AidenSimulatorStreamSession<ImageBitmap>(
                httpClient = OkHttpClient(),
                mjpegRequest = unreachable,
                inputRequest = unreachable,
                scope = scope,
                decodeFrame = decodeFrame,
                retryDelayMillis = 60_000
            ).also { created += it }
        }
    }

    private val json = Json { ignoreUnknownKeys = true }
    private val fixtureListing: AidenSimulatorListing
        get() = json.decodeFromString(AidenMobileSimulatorsFixture.section.getValue("listing").toString())

    private val iphone = "5A0C1F3E-0000-4000-8000-000000000001"
    private val ipad = "5A0C1F3E-0000-4000-8000-000000000002"

    @OptIn(ExperimentalCoroutinesApi::class)
    @Before
    fun setMain() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @OptIn(ExperimentalCoroutinesApi::class)
    @After
    fun resetMain() = Dispatchers.resetMain()

    @Test
    fun withoutTheGrantTheChatNeverAsksForDevices() {
        val remote = FakeRemote(fixtureListing, access = false)
        val model = AidenSimulatorsViewModel("chat_1", remote)
        model.refreshChatDevices()
        assertTrue(remote.listingRequests.isEmpty())
        assertTrue(model.chatDevices.value.isEmpty())
    }

    @Test
    fun theChatListingDrivesTheButtonAndTheViewerOpensOnTheFirstViewableDevice() {
        val remote = FakeRemote(fixtureListing)
        val model = AidenSimulatorsViewModel("chat_1", remote)
        model.refreshChatDevices()
        assertEquals(listOf<String?>("chat_1"), remote.listingRequests)
        assertEquals(listOf(iphone, "emulator-5554"), model.chatDevices.value.map { it.id })

        model.openViewer()
        val viewer = model.viewer.value
        assertTrue(viewer.open)
        assertEquals(iphone, viewer.selectedDeviceId)
        assertEquals("0.12.0", viewer.toolVersions?.hub)
        assertEquals(listOf(iphone), remote.sessions)

        // An Android emulator is listed but cannot be streamed on the phone.
        model.selectDevice("emulator-5554")
        assertEquals(iphone, model.viewer.value.selectedDeviceId)

        model.closeViewer()
        assertFalse(model.viewer.value.open)
        assertEquals("closing refreshes the chat's devices", listOf<String?>("chat_1", "chat_1"), remote.listingRequests)
    }

    @Test
    fun selectingAStoppedSimulatorBootsItBeforeStreaming() {
        val base = fixtureListing
        val remote = FakeRemote(base.copy(chatDeviceIds = listOf(iphone, ipad)))
        val model = AidenSimulatorsViewModel("chat_1", remote)
        model.refreshChatDevices()
        model.openViewer()

        model.selectDevice(ipad)
        assertEquals(listOf(ipad), remote.opened)
        val viewer = model.viewer.value
        assertEquals(ipad, viewer.selectedDeviceId)
        assertNull(viewer.startingDeviceName)
        assertTrue(viewer.selectedDevice!!.booted)
        assertEquals(listOf(iphone, ipad), remote.sessions)
    }

    @Test
    fun turningSharingOffWhileViewingExplainsWhereToTurnItBackOn() {
        val remote = FakeRemote(fixtureListing)
        val model = AidenSimulatorsViewModel("chat_1", remote)
        model.refreshChatDevices()
        model.openViewer()

        remote.listing = json.decodeFromString(AidenMobileSimulatorsFixture.section.getValue("sharingOff").toString())
        model.refreshChatDevices()
        assertTrue(model.chatDevices.value.isEmpty())
        assertEquals(AidenSimulatorViewerError.SHARING_OFF, model.viewer.value.error)
    }

    @Test
    fun shuttingDownClosesTheViewerAndRefreshesTheChat() {
        val remote = FakeRemote(fixtureListing)
        val model = AidenSimulatorsViewModel("chat_1", remote)
        model.refreshChatDevices()
        model.openViewer()
        model.shutdownSelected()
        assertEquals(listOf(iphone), remote.shutdowns)
        assertFalse(model.viewer.value.open)
        assertEquals(2, remote.listingRequests.size)
    }

    @Test
    fun leavingTheViewerReleasesTheStreamAndReturningReconnects() {
        val remote = FakeRemote(fixtureListing, liveSessions = true)
        val model = AidenSimulatorsViewModel("chat_1", remote)
        model.refreshChatDevices()
        model.openViewer()
        assertEquals(1, remote.created.size)
        assertTrue(model.session.value === remote.created.single())

        // The viewer left the screen (or the app went to the background) while still open.
        model.pauseStreaming()
        assertNull(model.session.value)
        assertTrue(model.viewer.value.open)
        // A stopped session cannot send, so it holds no socket on the Mac.
        assertFalse(remote.created.single().send(byteArrayOf(0)))

        // Coming back (ON_START replays when the observer is re-added) opens a new stream.
        model.resumeStreaming()
        assertEquals(2, remote.created.size)
        assertTrue(model.session.value === remote.created.last())
        model.closeViewer()
        assertNull(model.session.value)
    }

    @Test
    fun aFailedStreamWaitsForReloadRatherThanRetryingOnForeground() {
        val remote = FakeRemote(fixtureListing)
        val model = AidenSimulatorsViewModel("chat_1", remote)
        model.refreshChatDevices()
        model.openViewer()
        assertEquals(AidenSimulatorViewerError.UNREACHABLE, model.viewer.value.error)
        model.pauseStreaming()
        model.resumeStreaming()
        assertEquals(1, remote.sessions.size)
        model.reloadStream()
        assertEquals(2, remote.sessions.size)
    }
}
