package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalCoroutinesApi::class)
class AidenDebouncedDraftWriterTest {
    @Test
    fun burstOfKeystrokesPersistsOnlyTheLastValueAfterTheQuietPeriod() {
        val scope = TestScope()
        val writes = mutableListOf<String>()
        val writer = AidenDebouncedDraftWriter(scope, delayMillis = 500) { writes += it }

        for (prefix in listOf("h", "he", "hel", "hell", "hello")) {
            writer.schedule(prefix)
            scope.advanceTimeBy(100)
            scope.runCurrent()
        }
        assertEquals(emptyList<String>(), writes)

        scope.advanceTimeBy(401)
        scope.runCurrent()
        assertEquals(listOf("hello"), writes)
    }

    @Test
    fun flushWritesThePendingValueOnceAndCancelsTheTimer() {
        val scope = TestScope()
        val writes = mutableListOf<String>()
        val writer = AidenDebouncedDraftWriter(scope, delayMillis = 500) { writes += it }

        writer.schedule("draft")
        writer.flush()
        writer.flush()
        scope.advanceTimeBy(1_000)
        scope.runCurrent()

        assertEquals(listOf("draft"), writes)
        assertFalse(writer.hasPendingWrite)
    }

    @Test
    fun immediateWriteSupersedesAPendingKeystroke() {
        val scope = TestScope()
        val writes = mutableListOf<String>()
        val writer = AidenDebouncedDraftWriter(scope, delayMillis = 500) { writes += it }

        writer.schedule("about to send")
        writer.writeNow("")
        scope.advanceTimeBy(1_000)
        scope.runCurrent()

        assertEquals(listOf(""), writes)
    }

    @Test
    fun concurrentWritesLeaveTheNewestValueOnDisk() = runBlocking {
        val slowWriteStarted = CountDownLatch(1)
        val releaseSlowWrite = CompletableDeferred<Unit>()
        val writes = Collections.synchronizedList(mutableListOf<String>())
        val writer = AidenDebouncedDraftWriter(TestScope(), delayMillis = 500) { text ->
            if (text == "old") {
                slowWriteStarted.countDown()
                runBlocking { releaseSlowWrite.await() }
            }
            writes += text
        }

        val slow = async(Dispatchers.IO) { writer.writeNow("old") }
        assertEquals(true, slowWriteStarted.await(5, TimeUnit.SECONDS))
        // The newer value is accepted while the old write is still on disk.
        val newer = async(Dispatchers.IO) { writer.writeNow("new") }
        releaseSlowWrite.complete(Unit)
        slow.await()
        newer.await()

        assertEquals(listOf("old", "new"), writes.toList())
    }

    @Test
    fun supersededKeystrokeIsNeverWrittenAfterTheSendClear() {
        val writes = mutableListOf<String>()
        val directory = Files.createTempDirectory("draft-writer").toFile()
        val store = AidenChatDraftStore(root = directory)
        val session = store.beginSession("instance", "chat")
        val writer = AidenDebouncedDraftWriter(TestScope(), delayMillis = 500) {
            writes += it
            store.save(it, session)
        }

        writer.schedule("typed before send")
        writer.writeNow("")
        // A late flush of the superseded keystroke has nothing left to write.
        writer.flush()

        assertEquals(listOf(""), writes)
        assertEquals(null, store.load(session))
        directory.deleteRecursively()
    }

    @Test
    fun keystrokeTypedAfterAReservedClearStillWins() {
        val scope = TestScope()
        val writes = mutableListOf<String>()
        val writer = AidenDebouncedDraftWriter(scope, delayMillis = 500) { writes += it }

        val clear = writer.reserveWrite("")
        writer.schedule("typed while sending")
        writer.flush()
        clear()

        assertEquals(listOf("typed while sending"), writes)
    }
}
