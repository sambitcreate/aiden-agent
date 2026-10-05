package sbtbiswas.AidenOnTheGo.networking

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AidenStreamNetworkRecoveryTest {
    private class FakeNetwork(initial: Boolean) : AidenNetworkAvailability {
        val state = MutableStateFlow(initial)
        override val isAvailable: StateFlow<Boolean> = state
    }

    @Test
    fun decisionTableParksOfflineAndSpendsBackoffOnlyOnline() {
        val policy = AidenStreamRecoveryPolicy()
        assertEquals(AidenStreamRecoveryDecision.WaitForNetwork, policy.afterStreamFailure(networkAvailable = false))
        assertEquals(AidenStreamRecoveryDecision.ProbeStatus, policy.afterStreamFailure(networkAvailable = true))

        assertEquals(AidenStreamRecoveryDecision.WaitForNetwork, policy.afterProbeFailure(networkAvailable = false))
        assertEquals(AidenStreamRecoveryDecision.WaitForNetwork, policy.afterProbeFailure(networkAvailable = false))
        assertEquals(AidenStreamRecoveryDecision.Backoff(0), policy.afterProbeFailure(networkAvailable = true))
        assertEquals(AidenStreamRecoveryDecision.Backoff(1), policy.afterProbeFailure(networkAvailable = true))

        policy.backoffInterruptedByNetworkLoss()
        assertEquals(AidenStreamRecoveryDecision.Backoff(1), policy.afterProbeFailure(networkAvailable = true))

        policy.recordHealthy()
        assertEquals(AidenStreamRecoveryDecision.Backoff(0), policy.afterProbeFailure(networkAvailable = true))
    }

    @Test
    fun offlineStreamFailureParksWithoutProbingThenReconnectsWhenOnline() = runTest {
        val network = FakeNetwork(initial = false)
        val recovery = AidenStreamNetworkRecovery(network) { error("no backoff while offline") }
        val waiting = mutableListOf<Boolean>()

        val parked = async { recovery.shouldProbeAfterStreamFailure { waiting += it } }
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(listOf(true), waiting)
        assertFalse("parked until the network returns, however long that takes", parked.isCompleted)

        network.state.value = true
        assertFalse("network return reopens the stream directly, without a status probe", parked.await())
        assertEquals(listOf(true, false), waiting)
        assertEquals(0, recovery.policy.retryAttempt)

        assertTrue(recovery.shouldProbeAfterStreamFailure { waiting += it })
        assertEquals("an online failure never reports waiting", listOf(true, false), waiting)
    }

    @Test
    fun flappingNetworkWakesTheParkedConsumerOnceAndNeverSpendsBackoff() = runTest {
        val network = FakeNetwork(initial = false)
        val recovery = AidenStreamNetworkRecovery(network) { error("no backoff while offline") }
        val waiting = mutableListOf<Boolean>()
        var wakes = 0

        val first = async { recovery.shouldProbeAfterStreamFailure { waiting += it }.also { wakes++ } }
        runCurrent()
        // Online, offline, online, online before the parked consumer even runs.
        network.state.value = true
        network.state.value = false
        network.state.value = true
        network.state.value = true
        runCurrent()
        assertFalse(first.await())
        assertEquals("one parked consumer reconnects once however often the network flaps", 1, wakes)

        // The reopened stream fails again because the network dropped once
        // more: a probe failure while offline parks instead of backing off.
        network.state.value = false
        val second = async {
            recovery.recoverAfterProbeFailure(
                onBackoff = { error("no backoff while offline") },
                onWaiting = { waiting += it }
            )
        }
        runCurrent()
        assertEquals(listOf(true, false, true), waiting)
        network.state.value = true
        assertEquals(AidenStreamNetworkRecovery.ProbeFailureOutcome.NETWORK_RETURNED, second.await())
        assertEquals(0, recovery.policy.retryAttempt)
        assertEquals(listOf(true, false, true, false), waiting)
    }

    @Test
    fun networkDropDuringBackoffRefundsTheAttemptAndWaitsForNetwork() = runTest {
        val network = FakeNetwork(initial = true)
        val recovery = AidenStreamNetworkRecovery(network) { 1_000L * (it + 1) }
        val waiting = mutableListOf<Boolean>()
        var backoffs = 0

        val interrupted = async {
            recovery.recoverAfterProbeFailure(onBackoff = { backoffs++ }, onWaiting = { waiting += it })
        }
        advanceTimeBy(400)
        runCurrent()
        assertEquals(1, backoffs)
        network.state.value = false
        runCurrent()
        assertEquals("the backoff ends as soon as the network drops", listOf(true), waiting)
        assertEquals(400L, testScheduler.currentTime)

        // Staying offline past the original delay does not end the wait.
        advanceTimeBy(10_000)
        runCurrent()
        assertFalse(interrupted.isCompleted)
        network.state.value = true
        assertEquals(AidenStreamNetworkRecovery.ProbeFailureOutcome.NETWORK_RETURNED, interrupted.await())
        assertEquals(listOf(true, false), waiting)
        assertEquals("the interrupted backoff is refunded", 0, recovery.policy.retryAttempt)

        // The next online failure starts from the same first delay.
        val start = testScheduler.currentTime
        assertEquals(
            AidenStreamNetworkRecovery.ProbeFailureOutcome.BACKOFF_ELAPSED,
            recovery.recoverAfterProbeFailure(onBackoff = { backoffs++ }, onWaiting = { waiting += it })
        )
        assertEquals(1_000L, testScheduler.currentTime - start)
        assertEquals(2, backoffs)
    }

    @Test
    fun onlineProbeFailuresKeepGrowingTheBackoff() = runTest {
        val network = FakeNetwork(initial = true)
        val recovery = AidenStreamNetworkRecovery(network) { 1_000L * (it + 1) }
        val elapsed = mutableListOf<Long>()
        repeat(3) {
            val start = testScheduler.currentTime
            assertEquals(
                AidenStreamNetworkRecovery.ProbeFailureOutcome.BACKOFF_ELAPSED,
                recovery.recoverAfterProbeFailure(onBackoff = {}, onWaiting = { error("online never waits") })
            )
            elapsed += testScheduler.currentTime - start
        }
        assertEquals(listOf(1_000L, 2_000L, 3_000L), elapsed)
        recovery.recordHealthy()
        val start = testScheduler.currentTime
        recovery.recoverAfterProbeFailure(onBackoff = {}, onWaiting = {})
        assertEquals(1_000L, testScheduler.currentTime - start)
    }

    @Test
    fun cancellingAParkedConsumerClearsTheWaitingState() = runTest {
        val network = FakeNetwork(initial = false)
        val recovery = AidenStreamNetworkRecovery(network)
        val waiting = mutableListOf<Boolean>()
        val parked = async { recovery.shouldProbeAfterStreamFailure { waiting += it } }
        runCurrent()
        parked.cancel()
        runCurrent()
        assertTrue(parked.isCancelled)
        assertEquals(listOf(true, false), waiting)
    }
}
