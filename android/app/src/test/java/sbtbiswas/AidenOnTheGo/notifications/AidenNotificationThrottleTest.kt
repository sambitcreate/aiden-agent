package sbtbiswas.AidenOnTheGo.notifications

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AidenNotificationThrottleTest {
    private data class Update(val text: String, val terminal: Boolean = false)

    @Test
    fun continuousStreamStillPublishesOncePerPeriodWithTheLatestValue() = runTest {
        val upstream = MutableSharedFlow<Update>()
        val emitted = mutableListOf<Pair<Long, String>>()
        val job = launch {
            upstream.throttleLatest(1_000, { testScheduler.currentTime }) { it.terminal }
                .collect { emitted += testScheduler.currentTime to it.text }
        }
        runCurrent()

        // A token every 100 ms for 3 s never pauses long enough for a debounce.
        for (index in 0 until 30) {
            upstream.emit(Update("t$index"))
            advanceTimeBy(100)
            runCurrent()
        }

        assertEquals(listOf(0L to "t0", 1_000L to "t9", 2_000L to "t19"), emitted.take(3))
        job.cancel()
    }

    @Test
    fun urgentValueSkipsTheRemainingPeriod() = runTest {
        val upstream = MutableSharedFlow<Update>()
        val emitted = mutableListOf<Pair<Long, String>>()
        val job = launch {
            upstream.throttleLatest(1_000, { testScheduler.currentTime }) { it.terminal }
                .collect { emitted += testScheduler.currentTime to it.text }
        }
        runCurrent()

        upstream.emit(Update("running"))
        advanceTimeBy(200)
        upstream.emit(Update("more text"))
        advanceTimeBy(100)
        upstream.emit(Update("done", terminal = true))
        runCurrent()
        advanceTimeBy(2_000)
        runCurrent()

        assertEquals(listOf(0L to "running", 300L to "done"), emitted)
        job.cancel()
    }

    @Test
    fun quietStreamPublishesEachValueWithoutDelay() = runTest {
        val upstream = MutableSharedFlow<Update>()
        val emitted = mutableListOf<Pair<Long, String>>()
        val job = launch {
            upstream.throttleLatest(1_000, { testScheduler.currentTime }).collect {
                emitted += testScheduler.currentTime to it.text
            }
        }
        runCurrent()

        upstream.emit(Update("first"))
        advanceTimeBy(1_500)
        upstream.emit(Update("second"))
        runCurrent()

        assertEquals(listOf(0L to "first", 1_500L to "second"), emitted)
        job.cancel()
    }
}
