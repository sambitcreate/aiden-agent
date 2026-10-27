package sbtbiswas.AidenOnTheGo.notifications

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairingIdentity
import java.util.UUID
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient

/** In-memory only: neither an Intent extra nor Activity saved state grants creation consent. */
class AidenNewChatLinkConsent {
    data class Target(
        val pairing: AidenPairingIdentity,
        val installationName: String,
        val workspaceId: String,
        val workspaceName: String,
        val origin: AidenPairingIdentity?,
        val createdAtMillis: Long = System.currentTimeMillis(),
        val id: String = UUID.randomUUID().toString(),
        val originClient: AidenRemoteClient? = null
    )
    private val _pending = MutableStateFlow<Target?>(null)
    val pending = _pending.asStateFlow()
    private val _approved = MutableStateFlow<Target?>(null)
    val approved = _approved.asStateFlow()
    private var active: Target? = null

    fun propose(target: Target): Boolean {
        if (_pending.value != null || _approved.value != null || active != null) return false
        _pending.value = target
        return true
    }

    fun approve(id: String, isValid: (Target) -> Boolean, nowMillis: Long = System.currentTimeMillis()): Target? {
        val target = _pending.value ?: return null
        if (target.id != id) return null
        _pending.value = null
        if (nowMillis - target.createdAtMillis !in 0 until 60_000 || !isValid(target)) return null
        _approved.value = target
        return target
    }

    fun invalidate() { _pending.value = null; _approved.value = null; active = null }

    suspend fun <T> perform(target: Target, isValid: () -> Boolean, operation: suspend () -> T): T? {
        if (_approved.value?.id != target.id || active != null) return null
        _approved.value = null // Consume before suspension, including activity/lifecycle effects.
        if (System.currentTimeMillis() - target.createdAtMillis !in 0 until 60_000 || !isValid()) return null
        active = target
        try {
            val result = operation()
            currentCoroutineContext().ensureActive()
            return result.takeIf { active?.id == target.id && isValid() }
        } finally {
            if (active?.id == target.id) active = null
        }
    }
}
