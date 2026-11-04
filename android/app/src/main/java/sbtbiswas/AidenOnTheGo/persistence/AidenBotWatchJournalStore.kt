package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.auth.AidenSecureStore
import sbtbiswas.AidenOnTheGo.auth.AndroidAidenSecureStore
import java.security.MessageDigest
import java.time.Instant
import java.lang.ref.WeakReference

/** Exact person-authored draft and bounded typed request only; never provider credentials or arguments. */
interface AidenBotWatchJournal {
    /** Whether this handle still belongs to the current deletion/pairing generation. */
    val isCurrent: Boolean get() = true
    /** Called when deletion or pairing purge invalidates this handle, even with a request in flight. */
    fun onInvalidated(listener: () -> Unit) {}
    fun read(): String?
    /** Must finish durable storage before returning; failures forbid network transmission. */
    fun write(record: String?)
    fun replace(expected: String?, record: String?): Boolean {
        if (read() != expected) return false
        write(record); return true
    }
}

/** Encrypted preferences are already excluded from cloud backups and device transfer. */
class AidenBotWatchJournalStore(private val secureStore: AidenSecureStore, private val namespace: String = "bot-watches", private val maxRecords: Int = 64) {
    private val codec = MapSerializer(String.serializer(), String.serializer())
    private val json = Json { ignoreUnknownKeys = false }
    private val storeKey: Any = if (secureStore is AndroidAidenSecureStore) AndroidAidenSecureStore::class.java else secureStore
    private val purged: MutableSet<String> get() = purgedScopes.getOrPut(storeKey) { mutableSetOf() }

    fun journal(instanceId: String, deviceId: String, pairedAt: Instant, botId: String, stillPaired: () -> Boolean): AidenBotWatchJournal {
        val scope = scope(instanceId, deviceId, pairedAt)
        val owner = ownerBot(botId)
        val lifetime = synchronized(journalLock) {
            val key = BotScope(scope,owner)
            JournalLifetime(key, epochs.getOrPut(storeKey) { mutableMapOf() }[key] ?: 0L).also {
                val handles = liveHandles.getOrPut(storeKey) { mutableListOf() }
                handles.removeAll { handle -> handle.get() == null }
                handles += WeakReference(it)
            }
        }
        return object : AidenBotWatchJournal {
            override val isCurrent: Boolean get() = synchronized(journalLock) {
                lifetime.valid && scope !in purged && lifetime.generation == (epochs[storeKey]?.get(lifetime.key) ?: 0L)
            }
            override fun onInvalidated(listener: () -> Unit) = synchronized(journalLock) {
                lifetime.listener = listener
                if(!isCurrent) lifetime.invalidate()
            }
            override fun read(): String? = synchronized(journalLock) {
                if (!isCurrent || !stillPaired()) null else records(scope)[botId]
            }
            override fun replace(expected: String?, record: String?): Boolean = synchronized(journalLock) {
                if (read() != expected) false else { write(record); true }
            }
            override fun write(record: String?) = synchronized(journalLock) {
                check(isCurrent && stillPaired()) { "Bot or pairing no longer exists" }
                val records = records(scope).toMutableMap()
                if (record == null) records.remove(botId) else {
                    check(record.toByteArray(Charsets.UTF_8).size <= 280_000) { "Watch journal is too large" }
                    records[botId] = record
                }
                check(records.size <= maxRecords) { "Too many saved watch drafts" }
                val encoded = json.encodeToString(codec, records)
                check(encoded.toByteArray(Charsets.UTF_8).size <= 4 * 1_048_576) { "Saved watch drafts are full" }
                if (records.isEmpty()) secureStore.removeCredentialDurably(scope)
                else secureStore.setCredentialDurably(scope, encoded)
            }
        }
    }

    fun purge(instanceId: String, deviceId: String, pairedAt: Instant) = synchronized(journalLock) {
        val scope = scope(instanceId, deviceId, pairedAt)
        purged += scope
        invalidateHandles { it.key.scope == scope }
        secureStore.removeCredentialDurably(scope)
    }

    /** Exact Bot ownership, including all routine and Resume keys, without touching another Bot. */
    fun purgeBot(instanceId: String, deviceId: String, pairedAt: Instant, botId: String) = synchronized(journalLock) {
        val scope = scope(instanceId,deviceId,pairedAt)
        val key = BotScope(scope,botId)
        val generations = epochs.getOrPut(storeKey) { mutableMapOf() }
        generations[key] = (generations[key] ?: 0L) + 1
        invalidateHandles { it.key == key }
        val remaining = records(scope).filterKeys { ownerBot(it) != botId }
        if(remaining.isEmpty()) secureStore.removeCredentialDurably(scope)
        else secureStore.setCredentialDurably(scope,json.encodeToString(codec,remaining))
    }

    // Routine-control keys use a delimiter excluded by their host-owned ASCII ID grammar.
    private fun ownerBot(key: String) = if(namespace == "bot-routine-controls") key.substringBefore('|') else key
    private fun invalidateHandles(matches: (JournalLifetime) -> Boolean) {
        liveHandles[storeKey]?.removeAll { handle ->
            val lifetime = handle.get()
            if(lifetime != null && matches(lifetime)) lifetime.invalidate()
            lifetime == null || !lifetime.valid
        }
    }

    private fun records(scope: String): Map<String, String> {
        val saved = secureStore.getCredential(scope) ?: return emptyMap()
        // Corruption is a visible refusal, never permission to overwrite a possibly pending identity.
        check(saved.toByteArray(Charsets.UTF_8).size <= 4 * 1_048_576) { "Saved watch drafts are invalid" }
        return json.decodeFromString(codec, saved).also { records ->
            check(records.size <= maxRecords && records.values.all { it.toByteArray(Charsets.UTF_8).size <= 280_000 })
        }
    }

    private fun scope(instanceId: String, deviceId: String, pairedAt: Instant): String {
            val identity = "$instanceId\u001f$deviceId\u001f$pairedAt"
            val digest = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
            return "aiden:$namespace:v1:$digest"
        }
    private data class BotScope(val scope: String, val botId: String)
    private class JournalLifetime(val key: BotScope, val generation: Long) {
        var valid = true
        var listener: (() -> Unit)? = null
        fun invalidate() { valid = false; val callback = listener; listener = null; callback?.invoke() }
    }
    companion object {
        private val epochs = java.util.WeakHashMap<Any,MutableMap<BotScope,Long>>()
        private val liveHandles = java.util.WeakHashMap<Any,MutableList<WeakReference<JournalLifetime>>>()
        private val journalLock = Any()
        private val purgedScopes = java.util.WeakHashMap<Any,MutableSet<String>>()
    }
}
