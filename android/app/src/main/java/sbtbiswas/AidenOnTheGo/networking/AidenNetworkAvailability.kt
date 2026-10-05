package sbtbiswas.AidenOnTheGo.networking

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import sbtbiswas.AidenOnTheGo.models.AidenTerminalReconciliation

/**
 * The device's network reachability as stream recovery sees it.
 *
 * Only a platform report of no default network counts as offline; an unknown
 * or not-yet-reported state counts as available, so a missing signal never
 * blocks a reconnect. Repeated identical values are conflated by the flow.
 */
interface AidenNetworkAvailability {
    val isAvailable: StateFlow<Boolean>

    companion object {
        val AlwaysAvailable: AidenNetworkAvailability = object : AidenNetworkAvailability {
            override val isAvailable: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()
        }
    }
}

/** Process-wide default-network callback feeding [isAvailable]. */
class AidenConnectivityNetworkAvailability(context: Context) : AidenNetworkAvailability {
    private val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val state = MutableStateFlow(manager?.let { runCatching { it.activeNetwork != null }.getOrDefault(true) } ?: true)
    override val isAvailable: StateFlow<Boolean> = state.asStateFlow()

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            state.value = true
        }

        override fun onLost(network: Network) {
            // The default-network callback reports a replacement network
            // through onAvailable, so a Wi-Fi to cellular handoff recovers.
            state.value = false
        }
    }

    init {
        try {
            manager?.registerDefaultNetworkCallback(callback)
        } catch (_: RuntimeException) {
            // Without a callback the state stays at its last known value.
            state.value = true
        }
    }
}

sealed interface AidenStreamRecoveryDecision {
    /** Park without probing, warning, or spending backoff until the network returns. */
    data object WaitForNetwork : AidenStreamRecoveryDecision
    /** Ask the Mac for the stream's status before deciding. */
    data object ProbeStatus : AidenStreamRecoveryDecision
    /** Sleep the jittered delay for this attempt, then reopen the stream. */
    data class Backoff(val attempt: Int) : AidenStreamRecoveryDecision
}

/**
 * The reconnect decision table shared with iOS's `AidenStreamRecoveryPolicy`.
 *
 * | Event                          | Offline          | Online                       |
 * |--------------------------------|------------------|------------------------------|
 * | Event stream failed            | WaitForNetwork   | ProbeStatus                  |
 * | Status probe failed            | WaitForNetwork   | Backoff(attempt), attempt+1  |
 * | Network dropped during backoff | refund attempt, WaitForNetwork                  |
 * | Healthy event or status        | attempt reset to 0                              |
 *
 * Network return reopens the stream from its last applied sequence through
 * the one consumer coroutine, so a flapping network cannot start a second stream.
 */
class AidenStreamRecoveryPolicy {
    var retryAttempt: Int = 0
        private set

    fun afterStreamFailure(networkAvailable: Boolean): AidenStreamRecoveryDecision =
        if (networkAvailable) AidenStreamRecoveryDecision.ProbeStatus else AidenStreamRecoveryDecision.WaitForNetwork

    fun afterProbeFailure(networkAvailable: Boolean): AidenStreamRecoveryDecision {
        if (!networkAvailable) return AidenStreamRecoveryDecision.WaitForNetwork
        return AidenStreamRecoveryDecision.Backoff(retryAttempt++)
    }

    /** A backoff the network cut short never reached its reconnect, so it does not count. */
    fun backoffInterruptedByNetworkLoss() {
        retryAttempt = maxOf(0, retryAttempt - 1)
    }

    fun recordHealthy() {
        retryAttempt = 0
    }
}

/**
 * Runs the decision table's waits against an injected [AidenNetworkAvailability].
 * The chat stream consumer owns one instance per stream, so every reconnect it
 * triggers is that consumer's own single-flight next iteration.
 */
class AidenStreamNetworkRecovery(
    private val availability: AidenNetworkAvailability,
    private val delayMilliseconds: (Int) -> Long = { AidenTerminalReconciliation.retryDelayMilliseconds(it) }
) {
    enum class ProbeFailureOutcome { NETWORK_RETURNED, BACKOFF_ELAPSED }

    val policy = AidenStreamRecoveryPolicy()

    fun recordHealthy() = policy.recordHealthy()

    /**
     * After the event stream fails. Returns true when the caller should probe
     * status, or false after parking offline until the network returned, in
     * which case the caller reopens the stream directly.
     */
    suspend fun shouldProbeAfterStreamFailure(onWaiting: (Boolean) -> Unit): Boolean {
        if (policy.afterStreamFailure(availability.isAvailable.value) != AidenStreamRecoveryDecision.WaitForNetwork) {
            return true
        }
        park(onWaiting)
        return false
    }

    /**
     * After the status probe fails. [onBackoff] runs before an online backoff
     * delay (the caller's warning); offline parking never calls it.
     */
    suspend fun recoverAfterProbeFailure(
        onBackoff: () -> Unit,
        onWaiting: (Boolean) -> Unit
    ): ProbeFailureOutcome {
        return when (val decision = policy.afterProbeFailure(availability.isAvailable.value)) {
            is AidenStreamRecoveryDecision.Backoff -> {
                onBackoff()
                val lost = withTimeoutOrNull(delayMilliseconds(decision.attempt)) {
                    availability.isAvailable.first { !it }
                }
                if (lost == null) return ProbeFailureOutcome.BACKOFF_ELAPSED
                policy.backoffInterruptedByNetworkLoss()
                park(onWaiting)
                ProbeFailureOutcome.NETWORK_RETURNED
            }
            else -> {
                park(onWaiting)
                ProbeFailureOutcome.NETWORK_RETURNED
            }
        }
    }

    private suspend fun park(onWaiting: (Boolean) -> Unit) {
        onWaiting(true)
        try {
            availability.isAvailable.first { it }
        } finally {
            onWaiting(false)
        }
    }
}
