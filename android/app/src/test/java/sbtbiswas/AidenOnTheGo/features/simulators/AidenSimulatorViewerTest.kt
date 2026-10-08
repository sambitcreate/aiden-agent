package sbtbiswas.AidenOnTheGo.features.simulators

import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorDevice
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorListing
import sbtbiswas.AidenOnTheGo.networking.AidenMobileSimulatorsFixture
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorStreamSession

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
        override fun session(deviceId: String, scope: CoroutineScope): AidenSimulatorStreamSession<ImageBitmap>? {
            sessions += deviceId
            if (!liveSessions) return null
            val unreachable = Request.Builder().url("http://127.0.0.1:9/").build()
            return AidenSimulatorStreamSession<ImageBitmap>(
                httpClient = OkHttpClient(),
                mjpegRequest = unreachable,
                inputRequest = unreachable,
                scope = scope,
                decodeFrame = { null },
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
