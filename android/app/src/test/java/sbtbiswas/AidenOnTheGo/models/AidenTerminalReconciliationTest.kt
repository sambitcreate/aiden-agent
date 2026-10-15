package sbtbiswas.AidenOnTheGo.models

import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class AidenTerminalReconciliationTest {
    @Test
    fun delaysStayWithinTheUpperHalfOfEachExponentialStep() {
        val expectedCeilings = listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L, 30_000L)
        for ((attempt, ceiling) in expectedCeilings.withIndex()) {
            repeat(200) { seed ->
                val delay = AidenTerminalReconciliation.retryDelayMilliseconds(attempt, Random(seed))
                assertTrue("attempt $attempt gave $delay", delay in ceiling / 2..ceiling)
            }
        }
    }

    @Test
    fun devicesRetryingTheSameAttemptSpreadOut() {
        val delays = (0 until 50).map { device ->
            AidenTerminalReconciliation.retryDelayMilliseconds(4, Random(device))
        }.toSet()
        assertTrue("only ${delays.size} distinct delays", delays.size > 40)
    }

    @Test
    fun negativeAttemptsUseTheFirstStep() {
        val delay = AidenTerminalReconciliation.retryDelayMilliseconds(-3, Random(1))
        assertTrue(delay in 500L..1_000L)
    }
}
