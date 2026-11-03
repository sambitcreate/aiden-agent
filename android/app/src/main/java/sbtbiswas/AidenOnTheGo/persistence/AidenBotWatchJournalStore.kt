package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.auth.AidenSecureStore
import java.security.MessageDigest
import java.time.Instant

/** Exact person-authored draft and bounded typed request only; never provider credentials or arguments. */
interface AidenBotWatchJournal {
    fun read(): String?
    /** Must finish durable storage before returning; failures forbid network transmission. */
    fun write(record: String?)
}

/** Encrypted preferences are already excluded from cloud backups and device transfer. */
class AidenBotWatchJournalStore(private val secureStore: AidenSecureStore) {
    private val codec = MapSerializer(String.serializer(), String.serializer())
    private val json = Json { ignoreUnknownKeys = false }
    private val purged = mutableSetOf<String>()

    fun journal(instanceId: String, deviceId: String, pairedAt: Instant, botId: String, stillPaired: () -> Boolean): AidenBotWatchJournal {
        val scope = scope(instanceId, deviceId, pairedAt)
        return object : AidenBotWatchJournal {
            override fun read(): String? = synchronized(this@AidenBotWatchJournalStore) {
                if (!stillPaired() || scope in purged) null else records(scope)[botId]
            }
            override fun write(record: String?) = synchronized(this@AidenBotWatchJournalStore) {
                check(stillPaired() && scope !in purged) { "Pairing no longer exists" }
                val records = records(scope).toMutableMap()
                if (record == null) records.remove(botId) else {
                    check(record.toByteArray(Charsets.UTF_8).size <= 280_000) { "Watch journal is too large" }
                    records[botId] = record
                }
                check(records.size <= 64) { "Too many saved watch drafts" }
                val encoded = json.encodeToString(codec, records)
                check(encoded.toByteArray(Charsets.UTF_8).size <= 4 * 1_048_576) { "Saved watch drafts are full" }
                if (records.isEmpty()) secureStore.removeCredentialDurably(scope)
                else secureStore.setCredentialDurably(scope, encoded)
            }
        }
    }

    @Synchronized
    fun purge(instanceId: String, deviceId: String, pairedAt: Instant) {
        val scope = scope(instanceId, deviceId, pairedAt)
        purged += scope
        secureStore.removeCredentialDurably(scope)
    }

    private fun records(scope: String): Map<String, String> {
        val saved = secureStore.getCredential(scope) ?: return emptyMap()
        // Corruption is a visible refusal, never permission to overwrite a possibly pending identity.
        check(saved.toByteArray(Charsets.UTF_8).size <= 4 * 1_048_576) { "Saved watch drafts are invalid" }
        return json.decodeFromString(codec, saved).also { records ->
            check(records.size <= 64 && records.values.all { it.toByteArray(Charsets.UTF_8).size <= 280_000 })
        }
    }

    companion object {
        private fun scope(instanceId: String, deviceId: String, pairedAt: Instant): String {
            val identity = "$instanceId\u001f$deviceId\u001f$pairedAt"
            val digest = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
            return "aiden:bot-watches:v1:$digest"
        }
    }
}
