package sbtbiswas.AidenOnTheGo.features.chat

import android.content.Context
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.ServerSocket
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Base64
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/** Real card -> model -> coordinator -> pinned HTTPS client, with composition frames held at delivery. */
@RunWith(AndroidJUnit4::class)
class AidenBrowserRecordingOwnershipUiTest {
    @get:Rule
    val compose = createComposeRule()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val visible = mutableStateOf(true)
    private val releaseFiles = CopyOnWriteArrayList<File>()
    private val requested = CountDownLatch(1)
    private val sendTail = CountDownLatch(1)
    private val delivered = LinkedBlockingQueue<AidenBrowserRecordingLoad>()
    private var finishDespiteCancellation = false
    @Volatile
    private var resultFile: AidenBrowserRecordingFile? = null
    private lateinit var root: File
    private lateinit var recordings: File
    private lateinit var server: ServerSocket
    private val workers = Executors.newCachedThreadPool()
    private val coordinatorJob = Job()
    private lateinit var coordinator: AidenRemoteCoordinator
    private lateinit var cache: AidenChatCache
    private lateinit var drafts: AidenChatDraftStore
    private lateinit var model: AidenChatViewModel
    private val models = ViewModelStore()
    private lateinit var other: AidenBrowserRecordingFile
    private lateinit var video: ByteArray
    private val rec = AidenBrowserRecordingRecap("recording-0f1e2d3c-4b5a-4678-9abc-def012345678", "video/mp4", 1000, 1)
    private val otherRec = AidenBrowserRecordingRecap("recording-11111111-2222-4333-8444-555555555555", "video/mp4", 1000, 1)
    private val shownRecording = mutableStateOf(rec)
    private val initial = AidenChat(
        id = "chat-recording", workspaceId = "workspace-recording", title = "Recording",
        messages = listOf(AidenChatMessage("reply", AidenChatRole.ASSISTANT, "Recorded", createdAt = Instant.EPOCH)),
        createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r1"
    )
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Before
    fun setup() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        root = File(context.cacheDir, "recording-ownership-${UUID.randomUUID()}").apply { mkdirs() }
        recordings = File(root, "recordings")
        video = instrumentation.context.assets.open("browser-recording/recording.mp4").use { it.readBytes() }
        // Exercise the real pinned HTTPS client without changing app network policy.
        val password = "recording-test".toCharArray()
        val keys = KeyStore.getInstance("PKCS12").apply {
            instrumentation.context.assets.open("browser-recording/server.p12").use { load(it, password) }
        }
        val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keys, password) }
        val tls = SSLContext.getInstance("TLS").apply { init(keyManagers.keyManagers, null, null) }
        server = tls.serverSocketFactory.createServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val ca = instrumentation.context.assets.open("browser-recording/ca.der").use { it.readBytes() }
        val certificate = keys.getCertificate("recording-test")
        val pin = "sha256/" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded))
        val trust = AidenPairingTrust("private-ca", Base64.getEncoder().encodeToString(ca))
        workers.submit {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                workers.submit { respond(socket) }
            }
        }
        val grants = listOf(AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ)
        val installations = AidenInstallationStore(root, InMemoryAidenSecureStore())
        installations.addInstallation(AidenPairingExchange(
            instanceId = "instance-recording", deviceId = "device-recording",
            endpoint = "https://127.0.0.1:${server.localPort}/api/aiden/v1",
            serverSpkiSha256 = pin, credential = "synthetic-recording", capabilities = grants
        ), trust)
        cache = AidenChatCache(root)
        drafts = AidenChatDraftStore(root)
        instrumentation.runOnMainSync {
            coordinator = AidenRemoteCoordinator(
                installations, root, cache, drafts,
                scope = CoroutineScope(Dispatchers.Main + coordinatorJob), browserRecordingDir = recordings
            )
        }
        runBlocking { withTimeout(10_000) { coordinator.serverInfo.first { it != null } } }
        instrumentation.runOnMainSync {
            model = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
            models.put("chat", model)
        }
        other = (runBlocking {
            model.browserRecording(otherRec.copy(sizeBytes = video.size.toLong()))
        } as AidenBrowserRecordingLoad.Ready).recording
        compose.setContent {
            AidenTheme {
                val playback = remember(model) { AidenBrowserRecordingPlayback(
                    load = { recording ->
                        val loaded = if (finishDespiteCancellation) {
                            // A provider that completes despite card cancellation still
                            // transfers a real file; the disposed owner must reject it.
                            withContext(NonCancellable) { model.browserRecording(recording) }
                        } else model.browserRecording(recording)
                        resultFile = (loaded as? AidenBrowserRecordingLoad.Ready)?.recording
                        delivered.add(loaded)
                        loaded
                    },
                    release = { file -> releaseFiles.add(file.file); model.releaseBrowserRecording(file) }
                ) }
                CompositionLocalProvider(LocalAidenBrowserRecordingPlayback provides playback) {
                    if (visible.value) {
                        AidenBrowserRecordingCard(shownRecording.value.copy(sizeBytes = video.size.toLong()), AidenTheme.palette)
                    }
                }
            }
        }
    }

    private fun respond(socket: Socket) {
        socket.use {
            val input = socket.getInputStream().bufferedReader()
            val path = input.readLine()?.split(" ")?.getOrNull(1) ?: return
            while (!input.readLine().isNullOrEmpty()) { }
            val isVideo = path.contains("/recordings/")
            val body = when {
                isVideo -> video
                path.endsWith("/server") -> """{"protocolVersion":1,"instanceId":"instance-recording","name":"Recording Mac","appVersion":"1.0","capabilities":["server:read","chat:read"],"serverCapabilities":["server:read","chat:read"],"features":["chat-browser-recordings-v1"],"connectionMode":"lan","serverTime":"2026-11-02T12:00:00Z"}""".toByteArray()
                path.endsWith("/workspaces") -> """{"workspaces":[]}""".toByteArray()
                path.endsWith("/chats/${initial.id}") -> json.encodeToString(initial).toByteArray()
                else -> "{}".toByteArray()
            }
            val out = socket.getOutputStream()
            val mimeType = if (isVideo) "video/mp4" else "application/json"
            out.write(("HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\nContent-Type: $mimeType\r\n" +
                "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n").toByteArray())
            if (isVideo && path.endsWith(rec.id)) {
                val prefix = body.size / 2
                out.write(body, 0, prefix)
                out.flush()
                requested.countDown()
                check(sendTail.await(10, TimeUnit.SECONDS))
                try { out.write(body, prefix, body.size - prefix) } catch (_: Exception) { }
            } else out.write(body)
            out.flush()
        }
    }

    private fun startPaused() {
        compose.mainClock.autoAdvance = false
        compose.onNodeWithText("Play").performClick()
        assertTrue("real recording HTTP request started", requested.await(5, TimeUnit.SECONDS))
        eventually { recordings.listFiles().orEmpty().any { it.extension == "part" && it.length() > 0 } }
    }
    private fun finishWithoutFrame(): AidenBrowserRecordingFile {
        val frame = compose.mainClock.currentTime
        sendTail.countDown()
        assertTrue("real model returned Ready", delivered.poll(5, TimeUnit.SECONDS) is AidenBrowserRecordingLoad.Ready)
        instrumentation.runOnMainSync { /* after the card's continuation assigns playing */ }
        assertEquals("no recomposition frame ran after delivery", frame, compose.mainClock.currentTime)
        return resultFile!!
    }
    private fun navigateAway() {
        instrumentation.runOnMainSync {
            visible.value = false
            models.clear()
        }
        compose.mainClock.advanceTimeBy(32)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Close").assertDoesNotExist()
    }
    private fun eventually(condition: () -> Boolean) {
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!condition() && System.nanoTime() < end) Thread.sleep(10)
        assertTrue(condition())
    }
    private fun otherIntact() { assertArrayEquals(video, other.file.readBytes()) }


    @Test
    fun deliveredBeforePlayerCompositionIsReleasedOnNavigation() {
        startPaused()
        val file = finishWithoutFrame()
        assertArrayEquals(video, file.file.readBytes())
        navigateAway()
        eventually { !file.file.exists() }
        assertEquals("the card already owned its delivered file", listOf(file.file), releaseFiles.toList())
        otherIntact()
        instrumentation.runOnMainSync {
            model = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
            models.put("later-chat", model)
        }
        val later = (runBlocking { model.browserRecording(otherRec.copy(sizeBytes = video.size.toLong())) } as AidenBrowserRecordingLoad.Ready).recording
        assertFalse(file.file.exists())
        assertArrayEquals(video, later.file.readBytes())
        model.releaseBrowserRecording(later)
    }

    @Test
    fun ordinaryComposedPlayerDismissalReleasesOwnedFile() {
        startPaused()
        val file = finishWithoutFrame()
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Close").performClick()
        compose.waitForIdle()
        eventually { !file.file.exists() }
        assertEquals(listOf(file.file), releaseFiles.toList())
        otherIntact()
        navigateAway()
        assertEquals("closing then disposing releases once", listOf(file.file), releaseFiles.toList())
    }

    @Test
    fun ordinaryComposedPlayerNavigationReleasesOwnedFile() {
        startPaused()
        val file = finishWithoutFrame()
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Close").assertExists()
        navigateAway()
        eventually { !file.file.exists() }
        assertEquals(listOf(file.file), releaseFiles.toList())
        otherIntact()
    }

    @Test
    fun lateCompletionAfterCardDisposalReleasesItsFile() {
        finishDespiteCancellation = true
        startPaused()
        navigateAway()
        val file = finishWithoutFrame()
        eventually { !file.file.exists() }
        assertEquals(listOf(file.file), releaseFiles.toList())
        otherIntact()
    }


    @Test
    fun replacingCardReleasesOldDeliveryAndOwnsTheNextOne() {
        startPaused()
        val first = finishWithoutFrame()
        instrumentation.runOnMainSync { shownRecording.value = otherRec }
        compose.mainClock.advanceTimeBy(32)
        compose.waitForIdle()
        eventually { !first.file.exists() }
        assertEquals(listOf(first.file), releaseFiles.toList())
        compose.onNodeWithText("Play").performClick()
        val next = finishWithoutFrame()
        assertNotEquals("another Play of the held recording has its own file", other.file, next.file)
        navigateAway()
        eventually { !next.file.exists() }
        assertEquals(listOf(first.file, next.file), releaseFiles.toList())
        otherIntact()
    }


    @Test
    fun cancellationBeforeDeliveryCleansDownloadAndPreservesOtherPlayer() {
        startPaused()
        navigateAway()
        sendTail.countDown()
        eventually { recordings.listFiles().orEmpty().all { it == other.file } }
        assertNull(resultFile)
        otherIntact()
    }

    @After
    fun cleanup() {
        sendTail.countDown()
        instrumentation.runOnMainSync { models.clear() }
        coordinatorJob.cancel()
        if (::server.isInitialized) server.close()
        workers.shutdownNow()
        if (::root.isInitialized) root.deleteRecursively()
    }
}
