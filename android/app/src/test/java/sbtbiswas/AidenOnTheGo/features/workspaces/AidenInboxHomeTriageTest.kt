package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatSummaryActivity
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageChange
import sbtbiswas.AidenOnTheGo.models.AidenPairingExchange
import sbtbiswas.AidenOnTheGo.models.AidenServer
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.CoroutineContext

/**
 * Inbox swipes through the Home view model against a scripted desktop: a
 * list page requested before a swipe must not undo it, and a swipe made on
 * one host must not reach another host's list.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AidenInboxHomeTriageTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
    private val doneAt = Instant.parse("2026-10-01T09:00:00Z")
    private val pinnedAt = Instant.parse("2026-10-01T08:00:00Z")

    /** One paired desktop whose list pages and triage answers the test scripts. */
    private inner class Desk(val instanceId: String) {
        val server = MockWebServer()

        /** The page the desktop answers with; read when a request arrives. */
        @Volatile var page: List<AidenChatSummary> = emptyList()

        /**
         * When set, every list read is answered only once it opens. Not just
         * the next one: a load the home started on its own (connecting can
         * start a second one once the workspaces arrive) may be cancelled by
         * the forced reload after its request already reached us, and the
         * forced reload's page must still be the held one.
         */
        @Volatile var heldPage: CountDownLatch? = null
        val pageArrived = AtomicInteger()
        val pagesServed = AtomicInteger()

        /** Per chat: a triage write is answered only once its latch opens. */
        val heldTriage = ConcurrentHashMap<String, CountDownLatch>()
        val triageArrived = ConcurrentHashMap<String, CountDownLatch>()
        val triageWrites = AtomicInteger()
        /** Triage writes answered, counted once a held one is let go. */
        val triageAnswered = AtomicInteger()
        val readWrites = AtomicInteger()

        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    return when {
                        path.endsWith("/server") -> MockResponse().setBody(json.encodeToString(AidenServer(
                            instanceId = instanceId, name = instanceId,
                            capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE),
                            features = listOf("chat-summaries-v1", "chat-read-state-v1", "chat-triage-v1"))))
                        path.endsWith("/workspaces") -> MockResponse().setBody(
                            """{"workspaces":[{"id":"workspace-1","name":"Workspace","permission":"ask","revision":"rev-1"}]}""")
                        path.endsWith("/chat-summaries") -> {
                            val answer = page
                            val hold = heldPage?.takeIf { it.count > 0 }
                            if (hold != null) {
                                pageArrived.incrementAndGet()
                                check(hold.await(8, TimeUnit.SECONDS))
                            }
                            pagesServed.incrementAndGet()
                            MockResponse().setBody("""{"summaries":[${answer.joinToString(",") { json.encodeToString(it) }}]}""")
                        }
                        path.endsWith("/triage") -> {
                            val chatId = path.substringBeforeLast("/triage").substringAfterLast("/")
                            triageWrites.incrementAndGet()
                            triageArrived[chatId]?.countDown()
                            heldTriage[chatId]?.let { check(it.await(8, TimeUnit.SECONDS)) }
                            triageAnswered.incrementAndGet()
                            val body = request.body.readUtf8()
                            val done = if (body.contains("\"done\":true")) "\"doneAt\":\"$doneAt\"," else ""
                            MockResponse().setBody("""{"chatId":"$chatId","revision":${triageWrites.get()},$done"updatedAt":"$doneAt"}""")
                        }
                        path.endsWith("/read") -> {
                            readWrites.incrementAndGet()
                            MockResponse().setResponseCode(204)
                        }
                        else -> MockResponse().setResponseCode(503)
                    }
                }
            }
            server.start()
        }

        fun pairing() = AidenPairingExchange(
            instanceId = instanceId, deviceId = "$instanceId-device",
            endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test",
            credential = "synthetic", capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE))
    }

    private inner class Harness(
        val main: CoroutineDispatcher,
        val desks: List<Desk>,
        cacheWriteDispatcher: CoroutineDispatcher = Dispatchers.IO
    ) {
        val root: File = tempFolder.newFolder()
        val store = AidenInstallationStore(root, InMemoryAidenSecureStore())
        val cache = AidenChatCache(root = File(root, "cache"))
        val scope = CoroutineScope(main + Job())
        val owners = ViewModelStore()
        lateinit var coordinator: AidenRemoteCoordinator
        lateinit var home: AidenWorkspaceHomeViewModel

        init {
            for (desk in desks.reversed()) store.addInstallation(desk.pairing(), null)
            coordinator = AidenRemoteCoordinator(store, root, cache, scope = scope)
            home = AidenWorkspaceHomeViewModel(coordinator, cache, cacheWriteDispatcher = cacheWriteDispatcher)
            owners.put("home", home)
        }

        fun row(id: String) = home.chats.value.first { it.id == id }

        suspend fun waitFor(what: String, condition: () -> Boolean) {
            withTimeout(5_000) { while (!condition()) kotlinx.coroutines.delay(10) }
            check(condition()) { what }
        }

        /** Waits until [desk]'s list is loaded and shown, after at least [after] pages. */
        suspend fun connectedTo(desk: Desk, after: Int = 0) {
            waitFor("connected to ${desk.instanceId}") {
                coordinator.activeInstanceId == desk.instanceId && desk.pagesServed.get() > after &&
                    !home.isLoading.value && home.chats.value.map { it.id }.toSet() == desk.page.map { it.id }.toSet()
            }
        }

        suspend fun switchTo(desk: Desk) {
            val served = desk.pagesServed.get()
            store.setActiveInstallation(desk.instanceId)
            connectedTo(desk, after = served)
        }

        /** Starts a reload whose page is read now but answered only after [release]. */
        suspend fun holdReload(desk: Desk): CountDownLatch {
            val release = CountDownLatch(1)
            val arrivedBefore = desk.pageArrived.get()
            desk.heldPage = release
            home.load(force = true)
            waitFor("held page requested") { desk.pageArrived.get() > arrivedBefore }
            return release
        }

        suspend fun reload() {
            val desk = desks.first { it.instanceId == coordinator.activeInstanceId }
            val served = desk.pagesServed.get()
            home.load(force = true)
            waitFor("reload settled") { desk.pagesServed.get() > served && !home.isLoading.value }
        }

        fun saved(id: String) = AidenChatCache(root = File(root, "cache"))
            .loadSummaries(coordinator.activeInstanceId!!)?.first { it.id == id }

        fun close() {
            desks.forEach { it.heldPage?.countDown(); it.heldTriage.values.forEach(CountDownLatch::countDown) }
            owners.clear()
            scope.cancel()
            desks.forEach { it.server.shutdown() }
        }
    }

    /**
     * One Main thread. With [inPlace], as on Android, `Main.immediate` work
     * started on it runs in place. [executor] lets a test queue work there.
     */
    private class TestMain(inPlace: Boolean = false) : MainCoroutineDispatcher() {
        @Volatile private var thread: Thread? = null
        val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "test-main").also { thread = it } }
        override val immediate: MainCoroutineDispatcher = if (!inPlace) this else object : MainCoroutineDispatcher() {
            override val immediate: MainCoroutineDispatcher get() = this
            override fun isDispatchNeeded(context: CoroutineContext) = Thread.currentThread() !== thread
            override fun dispatch(context: CoroutineContext, block: Runnable) = executor.execute(block)
        }
        override fun dispatch(context: CoroutineContext, block: Runnable) = executor.execute(block)
        fun close() { executor.shutdownNow() }
    }

    private fun scenario(
        desks: List<Desk>,
        cacheWriteDispatcher: CoroutineDispatcher = Dispatchers.IO,
        main: TestMain = TestMain(),
        body: suspend Harness.() -> Unit
    ) {
        Dispatchers.setMain(main)
        try {
            runBlocking(main) {
                val harness = Harness(main, desks, cacheWriteDispatcher)
                try { harness.body() } finally { harness.close() }
            }
        } finally { Dispatchers.resetMain(); main.close() }
    }

    @Test
    fun aPageRequestedBeforeASwipeKeepsTheRowWhereTheSwipeMovedItUntilALaterPageSettlesIt() {
        val desk = Desk("home-a")
        desk.page = listOf(summary("chat-1"))
        scenario(listOf(desk)) {
            connectedTo(desk)
            val release = holdReload(desk)
            home.setInboxTriage("chat-1", AidenChatTriageChange.done(true))
            waitFor("Done confirmed") { home.inboxNotice.value is AidenInboxNotice.Changed }

            release.countDown()
            waitFor("held page landed") { !home.isLoading.value }
            assertEquals(doneAt, row("chat-1").doneAt)
            assertEquals(1, row("chat-1").triageRevision)
            assertEquals(doneAt, saved("chat-1")?.doneAt)

            // The desktop has since undone it: a page requested after the
            // swipe settled is the host's word and wins.
            desk.page = listOf(summary("chat-1", triageRevision = 2))
            reload()
            assertNull(row("chat-1").doneAt)
            assertEquals(2, row("chat-1").triageRevision)
        }
    }

    @Test
    fun aSwipeStillOutKeepsItsRowOverEveryPageUntilItSettles() {
        val desk = Desk("home-a")
        desk.page = listOf(summary("chat-1"))
        scenario(listOf(desk)) {
            connectedTo(desk)
            desk.heldTriage["chat-1"] = CountDownLatch(1)
            desk.triageArrived["chat-1"] = CountDownLatch(1)
            home.setInboxTriage("chat-1", AidenChatTriageChange.done(true))
            withContext(Dispatchers.IO) { check(desk.triageArrived.getValue("chat-1").await(5, TimeUnit.SECONDS)) }

            // Requested after the swipe, but the host has not taken it yet.
            reload()
            assertTrue(row("chat-1").doneAt != null)

            desk.heldTriage.getValue("chat-1").countDown()
            waitFor("Done confirmed") { home.inboxNotice.value is AidenInboxNotice.Changed }
            assertEquals(doneAt, row("chat-1").doneAt)
        }
    }

    @Test
    fun markReadKeepsAPinTheDesktopMadeMeanwhile() {
        val desk = Desk("home-a")
        desk.page = listOf(summary("chat-1", unread = true))
        scenario(listOf(desk)) {
            connectedTo(desk)
            // The held page was read on the desktop after it pinned the chat
            // but before it took the read marker.
            desk.page = listOf(summary("chat-1", unread = true, pinnedAt = pinnedAt, triageRevision = 1))
            val release = holdReload(desk)
            home.markInboxRead("chat-1")
            waitFor("read marker sent") { desk.readWrites.get() == 1 && !row("chat-1").unread }

            release.countDown()
            waitFor("held page landed") { !home.isLoading.value }
            assertFalse(row("chat-1").unread)
            assertEquals(pinnedAt, row("chat-1").pinnedAt)
            assertEquals(1, row("chat-1").triageRevision)
        }
    }

    @Test
    fun aSwipeThatLandsWhileAHeldPageIsBeingSavedIsNotWrittenOver() {
        val desk = Desk("home-a")
        desk.page = listOf(summary("chat-1"))
        // Cache writes run on their own threads; one page save can be held
        // just before it takes the cache lock.
        val pool = Executors.newCachedThreadPool()
        val holdNextWrite = AtomicBoolean(false)
        val saveArrived = CountDownLatch(1)
        val releaseSave = CountDownLatch(1)
        val cacheWrites = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) {
                val held = holdNextWrite.getAndSet(false)
                pool.execute {
                    if (held) { saveArrived.countDown(); check(releaseSave.await(8, TimeUnit.SECONDS)) }
                    block.run()
                }
            }
        }
        try {
            scenario(listOf(desk), cacheWriteDispatcher = cacheWrites) {
                connectedTo(desk)
                val release = holdReload(desk)
                holdNextWrite.set(true)
                release.countDown()
                withContext(Dispatchers.IO) { check(saveArrived.await(5, TimeUnit.SECONDS)) }

                home.setInboxTriage("chat-1", AidenChatTriageChange.done(true))
                waitFor("Done confirmed") { home.inboxNotice.value is AidenInboxNotice.Changed }
                assertEquals(doneAt, saved("chat-1")?.doneAt)

                releaseSave.countDown()
                waitFor("held page saved") { !home.isLoading.value }
                assertEquals(doneAt, row("chat-1").doneAt)
                assertEquals(doneAt, saved("chat-1")?.doneAt)
            }
        } finally { releaseSave.countDown(); pool.shutdownNow() }
    }

    @Test
    fun switchingHostsDropsTheOldHostsSwipesAndItsLateAnswersStayThere() {
        val a = Desk("home-a")
        val b = Desk("home-b")
        a.page = listOf(summary("chat-1"))
        b.page = listOf(summary("chat-b"))
        scenario(listOf(a, b)) {
            connectedTo(a)
            val firstHeld = CountDownLatch(1)
            val firstArrived = CountDownLatch(1)
            a.heldTriage["chat-1"] = firstHeld
            a.triageArrived["chat-1"] = firstArrived
            home.setInboxTriage("chat-1", AidenChatTriageChange.done(true))
            withContext(Dispatchers.IO) { check(firstArrived.await(5, TimeUnit.SECONDS)) }

            switchTo(b)
            assertNull(home.inboxNotice.value)
            assertEquals(listOf("chat-b"), home.chats.value.map { it.id })

            switchTo(a)
            // The swipe made before the switch no longer rides over A's list.
            assertNull(row("chat-1").doneAt)

            // The same swipe again on A, still out when the old one answers.
            val secondHeld = CountDownLatch(1)
            val secondArrived = CountDownLatch(1)
            a.heldTriage["chat-1"] = secondHeld
            a.triageArrived["chat-1"] = secondArrived
            home.setInboxTriage("chat-1", AidenChatTriageChange.done(true))
            withContext(Dispatchers.IO) { check(secondArrived.await(5, TimeUnit.SECONDS)) }
            firstHeld.countDown()
            waitFor("old write answered") { a.triageAnswered.get() == 1 }
            // The old answer's revision reaches A's saved row; by then its
            // write has ended here too.
            waitFor("old answer saved") { saved("chat-1")?.triageRevision == 2 }
            assertNull("A late answer from before the switch shows nothing", home.inboxNotice.value)

            // The old write's end must not count as the new one's: the new
            // swipe is still out, so a page cannot undo it.
            reload()
            assertTrue(row("chat-1").doneAt != null)
            secondHeld.countDown()
            waitFor("new Done confirmed") { home.inboxNotice.value is AidenInboxNotice.Changed }
        }
    }

    @Test
    fun aMarkReadMadeAsAPageSaveReturnsStaysRead() {
        val desk = Desk("home-a")
        desk.page = listOf(summary("chat-1", unread = true))
        // Mark read must run on Main in place, inside the gap.
        val main = TestMain(inPlace = true)
        lateinit var harness: Harness
        val pool = Executors.newCachedThreadPool()
        val interceptNextWrite = AtomicBoolean(false)
        val holdNextWrite = AtomicBoolean(false)
        val releaseUpsert = CountDownLatch(1)
        val swiped = CountDownLatch(1)
        // The page save runs while Main is kept busy; once it has written the
        // cache, Mark read is swiped on Main before the save's caller resumes,
        // and that swipe's own cache write is held.
        val cacheWrites = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) {
                val intercepted = interceptNextWrite.getAndSet(false)
                val held = holdNextWrite.getAndSet(false)
                pool.execute {
                    if (held) check(releaseUpsert.await(8, TimeUnit.SECONDS))
                    if (!intercepted) return@execute block.run()
                    val mainBusy = CountDownLatch(1)
                    val saveDone = CountDownLatch(1)
                    main.executor.execute {
                        mainBusy.countDown()
                        check(saveDone.await(8, TimeUnit.SECONDS))
                        holdNextWrite.set(true)
                        harness.home.markInboxRead("chat-1")
                        swiped.countDown()
                    }
                    check(mainBusy.await(8, TimeUnit.SECONDS))
                    block.run()
                    saveDone.countDown()
                }
            }
        }
        try {
            scenario(listOf(desk), cacheWriteDispatcher = cacheWrites, main = main) {
                harness = this
                connectedTo(desk)
                assertTrue(row("chat-1").unread)
                val release = holdReload(desk)
                interceptNextWrite.set(true)
                release.countDown()
                waitFor("swiped in the gap and the page landed") { swiped.count == 0L && !home.isLoading.value }
                assertFalse("The page must not bring back the dot the swipe cleared", row("chat-1").unread)

                releaseUpsert.countDown()
                waitFor("read marker sent") { desk.readWrites.get() == 1 }
                assertFalse(row("chat-1").unread)
            }
        } finally { releaseUpsert.countDown(); pool.shutdownNow() }
    }

    private fun summary(
        id: String,
        unread: Boolean = false,
        pinnedAt: Instant? = null,
        triageRevision: Int? = null
    ) = AidenChatSummary(
        id = id,
        workspaceId = "workspace-1",
        title = "Chat $id",
        titlePending = false,
        createdAt = Instant.parse("2026-09-01T12:00:00Z"),
        updatedAt = Instant.parse("2026-09-01T12:01:00Z"),
        revision = "rev_" + Base64.getUrlEncoder().withoutPadding()
            .encodeToString(MessageDigest.getInstance("SHA-256").digest(id.toByteArray())),
        activity = AidenChatSummaryActivity.IDLE,
        unread = unread,
        pinnedAt = pinnedAt,
        triageRevision = triageRevision
    )
}
