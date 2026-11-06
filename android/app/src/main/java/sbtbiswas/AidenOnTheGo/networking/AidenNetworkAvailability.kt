package sbtbiswas.AidenOnTheGo.networking

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.os.SystemClock
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeoutOrNull
import sbtbiswas.AidenOnTheGo.models.AidenTerminalReconciliation
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException

/**
 * The device's network reachability as stream recovery sees it.
 *
 * Only a platform report of no default network counts as offline; an unknown
 * or not-yet-reported state counts as available, so a missing signal never
 * blocks a reconnect. Repeated identical values are conflated by the flow.
 */
interface AidenNetworkAvailability {
    val isAvailable: StateFlow<Boolean>
    val rechecks: StateFlow<Long> get() = NoRechecks

    companion object {
        private val NoRechecks = MutableStateFlow(0L).asStateFlow()
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
    private val recheckState = MutableStateFlow(0L)
    override val rechecks: StateFlow<Long> = recheckState.asStateFlow()

    fun recheck() { recheckState.update { it + 1 } }

    private val tracker = AidenDefaultNetworkTracker<Network>()

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            state.value = tracker.onAvailable(network)
            recheck()
        }

        override fun onLost(network: Network) {
            tracker.onLost(network)?.let { state.value = it }
        }
    }

    init {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) { recheck() }
        }
        try {
            ContextCompat.registerReceiver(context.applicationContext, receiver, IntentFilter(Intent.ACTION_SCREEN_ON), ContextCompat.RECEIVER_NOT_EXPORTED)
        } catch (_: RuntimeException) {
            // Activity resume still rechecks deadlines if this broadcast is unavailable.
        }
        try {
            manager?.registerDefaultNetworkCallback(callback)
        } catch (_: RuntimeException) {
            // Without a callback the state stays at its last known value.
            state.value = true
        }
    }
}

/**
 * Follows which network is the default so a late [onLost] for a network that
 * was already replaced cannot mark the device offline. During a
 * make-before-break handoff (Wi-Fi to cellular) the platform can report the
 * replacement through onAvailable before the previous network's onLost.
 */
internal class AidenDefaultNetworkTracker<N : Any> {
    private var current: N? = null

    /** The availability to publish: a new default network is always online. */
    @Synchronized
    fun onAvailable(network: N): Boolean {
        current = network
        return true
    }

    /**
     * Returns false when the current default network was lost, or null when
     * [network] was already superseded and the published state must not change.
     */
    @Synchronized
    fun onLost(network: N): Boolean? {
        val active = current
        if (active != null && active != network) return null
        current = null
        return false
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
    private val nowMilliseconds: () -> Long = SystemClock::elapsedRealtime,
    private val delayMilliseconds: (Int) -> Long = { AidenTerminalReconciliation.retryDelayMilliseconds(it) }
) {
    enum class ProbeFailureOutcome { NETWORK_RETURNED, BACKOFF_ELAPSED }

    val policy = AidenStreamRecoveryPolicy()

    fun recordHealthy() = policy.recordHealthy()

    companion object {
        /** The wait a 429 asked for, clamped, or 0 for any other failure. */
        fun serverRequestedDelayMilliseconds(error: Throwable): Long =
            (error as? AidenRemoteClientException.Server)?.retryAfterSeconds?.let { it * 1_000L } ?: 0L
    }

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
     * delay (the caller's warning); offline parking never calls it. A server
     * that asked for a longer wait (a 429's `Retry-After`) passes it as
     * [minimumDelayMilliseconds], so the reconnect never comes sooner.
     */
    suspend fun recoverAfterProbeFailure(
        minimumDelayMilliseconds: Long = 0,
        onBackoff: () -> Unit,
        onWaiting: (Boolean) -> Unit
    ): ProbeFailureOutcome {
        val started = nowMilliseconds()
        val serverDeadline = started + minimumDelayMilliseconds.coerceAtLeast(0)
        val outcome = when (val decision = policy.afterProbeFailure(availability.isAvailable.value)) {
            is AidenStreamRecoveryDecision.Backoff -> {
                onBackoff()
                val deadline = started + maxOf(delayMilliseconds(decision.attempt), minimumDelayMilliseconds)
                if (waitWhileOnline(deadline)) {
                    ProbeFailureOutcome.BACKOFF_ELAPSED
                } else {
                    policy.backoffInterruptedByNetworkLoss()
                    park(onWaiting)
                    ProbeFailureOutcome.NETWORK_RETURNED
                }
            }
            else -> {
                park(onWaiting)
                ProbeFailureOutcome.NETWORK_RETURNED
            }
        }
        while (!waitWhileOnline(serverDeadline)) park(onWaiting)
        return outcome
    }

    /** Recheck an elapsed-time deadline after network or device wake signals. */
    private suspend fun waitWhileOnline(deadline: Long): Boolean {
        while (availability.isAvailable.value) {
            // Capture the signal first so a wake racing the clock read is not lost.
            val generation = availability.rechecks.value
            val remaining = deadline - nowMilliseconds()
            if (remaining <= 0) return true
            val changed = withTimeoutOrNull(remaining) {
                combine(availability.isAvailable, availability.rechecks) { online, recheck -> online to recheck }
                    .first { (online, recheck) -> !online || recheck != generation }
            }
            if (changed == null && nowMilliseconds() >= deadline) return true
        }
        return false
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
