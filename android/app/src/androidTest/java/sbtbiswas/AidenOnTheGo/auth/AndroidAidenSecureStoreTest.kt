package sbtbiswas.AidenOnTheGo.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.crypto.tink.Aead
import com.google.crypto.tink.DeterministicAead
import com.google.crypto.tink.InsecureSecretKeyAccess
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.TinkProtoKeysetFormat
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.aead.PredefinedAeadParameters
import com.google.crypto.tink.daead.DeterministicAeadConfig
import com.google.crypto.tink.daead.PredefinedDeterministicAeadParameters
import com.google.crypto.tink.integration.android.AndroidKeystoreKmsClient
import com.google.crypto.tink.subtle.Base64
import com.google.crypto.tink.subtle.Hex
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenPairingExchange
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournalStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import java.nio.ByteBuffer
import java.nio.file.Files
import java.security.KeyStore
import java.security.MessageDigest
import java.time.Instant
import javax.crypto.KeyGenerator

@RunWith(AndroidJUnit4::class)
class AndroidAidenSecureStoreTest {
    private lateinit var appContext: Context

    @Before
    fun setUp() {
        appContext = ApplicationProvider.getApplicationContext()
        resetSecurePreferencesAndKeystore()
    }

    @After
    fun tearDown() {
        resetSecurePreferencesAndKeystore()
    }

    @Test
    fun freshInstallProvisionsKeystoreKeysetsPurgesFallbackAndSurvivesRestart() {
        val fallbackPrefs = appContext.getSharedPreferences(AIDEN_FALLBACK_PREFS_FILE_NAME, Context.MODE_PRIVATE)
        assertTrue(fallbackPrefs.edit().putString("legacy-scope", "plaintext-secret").commit())

        val store = AndroidAidenSecureStore(appContext)
        assertTrue(fallbackPrefs.all.isEmpty())

        store.setCredential("inst-fresh:dev-fresh", "desktop-secret-token")
        store.setCredential("empty-scope", "")
        store.setCredentialDurably("unicode-scope", "watch draft 🚀 日本語 café")

        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertTrue(keyStore.containsAlias(AIDEN_MASTER_KEY_ALIAS))

        val rawPrefs = appContext.getSharedPreferences(AIDEN_SECURE_PREFS_FILE_NAME, Context.MODE_PRIVATE)
        val rawEntries = rawPrefs.all
        assertTrue(rawEntries.containsKey(AIDEN_KEY_KEYSET_ALIAS))
        assertTrue(rawEntries.containsKey(AIDEN_VALUE_KEYSET_ALIAS))
        assertEquals(5, rawEntries.size)
        for ((rawKey, rawValue) in rawEntries) {
            assertFalse(rawKey.contains("inst-fresh"))
            assertFalse(rawKey.contains("unicode-scope"))
            assertFalse(rawValue.toString().contains("desktop-secret-token"))
            assertFalse(rawValue.toString().contains("watch draft"))
        }

        val restarted = AndroidAidenSecureStore(appContext)
        assertEquals("desktop-secret-token", restarted.getCredential("inst-fresh:dev-fresh"))
        assertEquals("", restarted.getCredential("empty-scope"))
        assertEquals("watch draft 🚀 日本語 café", restarted.getCredential("unicode-scope"))
        assertNull(restarted.getCredential("missing-scope"))

        restarted.removeCredential("empty-scope")
        restarted.removeCredentialDurably("unicode-scope")

        val afterDeletes = AndroidAidenSecureStore(appContext)
        assertNull(afterDeletes.getCredential("empty-scope"))
        assertNull(afterDeletes.getCredential("unicode-scope"))
        assertEquals("desktop-secret-token", afterDeletes.getCredential("inst-fresh:dev-fresh"))
    }

    @Test
    fun decryptsPrePopulatedEncryptedSharedPreferencesFixtureAndFourBotJournalsInPlace() {
        val tempDir = Files.createTempDirectory("aiden-android-upgrade-").toFile()
        try {
            DeterministicAeadConfig.register()
            AeadConfig.register()
            val config = RegistryConfiguration.get()

            // Provision the legacy MasterKey (_androidx_security_master_key_) exactly as MasterKey.Builder did.
            val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            keyGenerator.init(
                KeyGenParameterSpec.Builder(
                    AIDEN_MASTER_KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            keyGenerator.generateKey()

            val masterAead = AndroidKeystoreKmsClient().getAead(AIDEN_MASTER_KEY_URI)
            val keyKeysetHandle = KeysetHandle.generateNew(
                PredefinedDeterministicAeadParameters.AES256_SIV,
                config
            )
            val valueKeysetHandle = KeysetHandle.generateNew(
                PredefinedAeadParameters.AES256_GCM,
                config
            )
            val daead = keyKeysetHandle.getPrimitive(config, DeterministicAead::class.java)
            val aead = valueKeysetHandle.getPrimitive(config, Aead::class.java)

            // Seed installations.json using an in-memory store first so we mirror a pre-upgrade disk state.
            val seedInstallations = AidenInstallationStore(tempDir, InMemoryAidenSecureStore())
            val paired = seedInstallations.addInstallation(
                AidenPairingExchange(
                    instanceId = "inst-upgrade",
                    deviceId = "dev-upgrade",
                    endpoint = "https://desktop.example.test/api/aiden/v1",
                    serverSpkiSha256 = "sha256/upgrade",
                    credential = "legacy-desktop-bearer-token",
                    capabilities = listOf(AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE)
                ),
                trust = null
            )

            val rawPrefs = appContext.getSharedPreferences(AIDEN_SECURE_PREFS_FILE_NAME, Context.MODE_PRIVATE)
            val editor = rawPrefs.edit()
            editor.putString(
                AIDEN_KEY_KEYSET_ALIAS,
                Hex.encode(
                    TinkProtoKeysetFormat.serializeEncryptedKeyset(
                        keyKeysetHandle,
                        masterAead,
                        ByteArray(0),
                        config
                    )
                )
            )
            editor.putString(
                AIDEN_VALUE_KEYSET_ALIAS,
                Hex.encode(
                    TinkProtoKeysetFormat.serializeEncryptedKeyset(
                        valueKeysetHandle,
                        masterAead,
                        ByteArray(0),
                        config
                    )
                )
            )

            putLegacyEncryptedString(
                editor = editor,
                daead = daead,
                aead = aead,
                key = paired.credentialScope,
                value = "legacy-desktop-bearer-token"
            )
            putLegacyEncryptedString(
                editor = editor,
                daead = daead,
                aead = aead,
                key = botJournalScope("bot-watches", paired.instanceId, paired.deviceId, paired.createdAt),
                value = """{"bot-1":"frozen-watch-request"}"""
            )
            putLegacyEncryptedString(
                editor = editor,
                daead = daead,
                aead = aead,
                key = botJournalScope("bot-open-work", paired.instanceId, paired.deviceId, paired.createdAt),
                value = """{"bot-1":"frozen-open-work-request"}"""
            )
            putLegacyEncryptedString(
                editor = editor,
                daead = daead,
                aead = aead,
                key = botJournalScope("bot-routine-controls", paired.instanceId, paired.deviceId, paired.createdAt),
                value = """{"bot-1|routine|nightly":"frozen-routine-model-request"}"""
            )
            putLegacyEncryptedString(
                editor = editor,
                daead = daead,
                aead = aead,
                key = botJournalScope("bot-peers", paired.instanceId, paired.deviceId, paired.createdAt),
                value = """{"bot-1|peer|reviewer":"frozen-peer-request"}"""
            )
            assertTrue(editor.commit())

            val upgradedStore = AndroidAidenSecureStore(appContext)
            val upgradedInstallations = AidenInstallationStore(tempDir, upgradedStore)
            val active = upgradedInstallations.activeInstallation
            assertNotNull(active)
            assertEquals("legacy-desktop-bearer-token", upgradedInstallations.getCredential(active!!))

            assertEquals(
                "frozen-watch-request",
                AidenBotWatchJournalStore(upgradedStore)
                    .journal(paired.instanceId, paired.deviceId, paired.createdAt, "bot-1") { true }
                    .read()
            )
            assertEquals(
                "frozen-open-work-request",
                AidenBotWatchJournalStore(upgradedStore, "bot-open-work")
                    .journal(paired.instanceId, paired.deviceId, paired.createdAt, "bot-1") { true }
                    .read()
            )
            assertEquals(
                "frozen-routine-model-request",
                AidenBotWatchJournalStore(upgradedStore, "bot-routine-controls", 1088)
                    .journal(paired.instanceId, paired.deviceId, paired.createdAt, "bot-1|routine|nightly") { true }
                    .read()
            )
            assertEquals(
                "frozen-peer-request",
                AidenBotWatchJournalStore(upgradedStore, "bot-peers", 1088)
                    .journal(paired.instanceId, paired.deviceId, paired.createdAt, "bot-1|peer|reviewer") { true }
                    .read()
            )

            // Mutate in place and confirm readability across a subsequent restart.
            AidenBotWatchJournalStore(upgradedStore)
                .journal(paired.instanceId, paired.deviceId, paired.createdAt, "bot-2") { true }
                .write("post-upgrade-watch-request")

            val reopenedStore = AndroidAidenSecureStore(appContext)
            assertEquals("legacy-desktop-bearer-token", reopenedStore.getCredential(paired.credentialScope))
            assertEquals(
                "frozen-watch-request",
                AidenBotWatchJournalStore(reopenedStore)
                    .journal(paired.instanceId, paired.deviceId, paired.createdAt, "bot-1") { true }
                    .read()
            )
            assertEquals(
                "post-upgrade-watch-request",
                AidenBotWatchJournalStore(reopenedStore)
                    .journal(paired.instanceId, paired.deviceId, paired.createdAt, "bot-2") { true }
                    .read()
            )
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun durableSetAndRemoveCommitSynchronouslyAndThrowWhenCommitReturnsFalse() {
        val store = AndroidAidenSecureStore(appContext)
        store.setCredentialDurably("durable-scope", "committed-value")
        assertEquals(
            "committed-value",
            AndroidAidenSecureStore(appContext).getCredential("durable-scope")
        )
        store.removeCredentialDurably("durable-scope")
        assertNull(AndroidAidenSecureStore(appContext).getCredential("durable-scope"))

        DeterministicAeadConfig.register()
        AeadConfig.register()
        val config = RegistryConfiguration.get()
        val daead = KeysetHandle.generateNew(PredefinedDeterministicAeadParameters.AES256_SIV, config)
            .getPrimitive(config, DeterministicAead::class.java)
        val aead = KeysetHandle.generateNew(PredefinedAeadParameters.AES256_GCM, config)
            .getPrimitive(config, Aead::class.java)

        val failingCommitBackend = object : RawPreferencesBackend {
            private val entries = mutableMapOf<String, String>()
            override fun allKeys(): Set<String> = entries.keys.toSet()
            override fun contains(key: String): Boolean = entries.containsKey(key)
            override fun getString(key: String): String? = entries[key]
            override fun putStringAsync(key: String, value: String) {
                entries[key] = value
            }
            override fun putStringCommit(key: String, value: String): Boolean = false
            override fun removeAsync(key: String) {
                entries.remove(key)
            }
            override fun removeCommit(key: String): Boolean = false
            override fun removeManyAsync(keys: Collection<String>) {
                keys.forEach(entries::remove)
            }
        }
        val failingStore = AndroidAidenSecureStore(
            purgeFallbackPreferences = {},
            openCipherStore = { TinkPreferencesStore(failingCommitBackend, daead, aead) }
        )

        val saveError = assertThrows(IllegalStateException::class.java) {
            failingStore.setCredentialDurably("scope", "value")
        }
        assertEquals("Secure state could not be saved", saveError.message)

        val removeError = assertThrows(IllegalStateException::class.java) {
            failingStore.removeCredentialDurably("scope")
        }
        assertEquals("Secure state could not be removed", removeError.message)
    }

    @Test
    fun tamperedCiphertextsAndReservedKeysRaiseSecurityExceptionAndProtectBotJournals() {
        val store = AndroidAidenSecureStore(appContext)
        val pairedAt = Instant.parse("2026-04-01T12:00:00Z")
        val watchJournal = AidenBotWatchJournalStore(store)
            .journal("inst-tamper", "dev-tamper", pairedAt, "bot-1") { true }
        watchJournal.write("pending-mutation-uuid-do-not-overwrite")
        store.setCredentialDurably("other-scope", "other-value")

        val rawPrefs = appContext.getSharedPreferences(AIDEN_SECURE_PREFS_FILE_NAME, Context.MODE_PRIVATE)
        val userKeys = rawPrefs.all.keys.filterNot(::isReservedSecureStoreKey)
        assertEquals(2, userKeys.size)

        val scopeKey = botJournalScope("bot-watches", "inst-tamper", "dev-tamper", pairedAt)
        val watchEncryptedKey = userKeys.single { key ->
            // Identify which encrypted key corresponds to the Bot watch journal by temporarily testing the other.
            rawPrefs.getString(key, null) != null && run {
                val otherCandidate = userKeys.first { it != key }
                val savedOther = rawPrefs.getString(otherCandidate, null)!!
                assertTrue(rawPrefs.edit().remove(otherCandidate).commit())
                val stillPresent = store.getCredential(scopeKey) != null
                assertTrue(rawPrefs.edit().putString(otherCandidate, savedOther).commit())
                stillPresent
            }
        }
        val otherEncryptedKey = userKeys.single { it != watchEncryptedKey }
        val originalCiphertext = rawPrefs.getString(watchEncryptedKey, null)!!

        // Flip a byte in the AES-GCM ciphertext/tag.
        val corruptedBytes = Base64.decode(originalCiphertext, Base64.DEFAULT)
        corruptedBytes[corruptedBytes.lastIndex] = (corruptedBytes.last().toInt() xor 0x01).toByte()
        val corruptedCiphertext = Base64.encode(corruptedBytes)
        assertTrue(rawPrefs.edit().putString(watchEncryptedKey, corruptedCiphertext).commit())

        assertThrows(SecurityException::class.java) {
            store.getCredential(scopeKey)
        }
        assertThrows(SecurityException::class.java) {
            watchJournal.read()
        }
        assertThrows(SecurityException::class.java) {
            watchJournal.write("attempted-overwrite-uuid")
        }
        // Confirm the tampered record on disk was NOT overwritten by the failed write.
        assertEquals(corruptedCiphertext, rawPrefs.getString(watchEncryptedKey, null))

        // Swapping valid ciphertext from another scope must fail AAD verification with SecurityException.
        val swappedCiphertext = rawPrefs.getString(otherEncryptedKey, null)!!
        assertTrue(rawPrefs.edit().putString(watchEncryptedKey, swappedCiphertext).commit())
        assertThrows(SecurityException::class.java) {
            store.getCredential(scopeKey)
        }

        // Malformed Base64 must raise SecurityException.
        assertTrue(rawPrefs.edit().putString(watchEncryptedKey, "%%%not-valid-base64%%%").commit())
        assertThrows(SecurityException::class.java) {
            store.getCredential(scopeKey)
        }

        // Reserved keyset aliases must always throw SecurityException.
        assertThrows(SecurityException::class.java) { store.getCredential(AIDEN_KEY_KEYSET_ALIAS) }
        assertThrows(SecurityException::class.java) { store.getCredential(AIDEN_VALUE_KEYSET_ALIAS) }
        assertThrows(SecurityException::class.java) { store.setCredential(AIDEN_KEY_KEYSET_ALIAS, "x") }
        assertThrows(SecurityException::class.java) { store.removeCredential(AIDEN_VALUE_KEYSET_ALIAS) }
    }

    @Test
    fun clearAllRemovesCredentialsAndBotJournalsWhilePreservingTinkKeysets() {
        val store = AndroidAidenSecureStore(appContext)
        val pairedAt = Instant.parse("2026-05-01T00:00:00Z")
        store.setCredential("inst-clear:dev-clear", "desktop-token")
        AidenBotWatchJournalStore(store)
            .journal("inst-clear", "dev-clear", pairedAt, "bot-1") { true }
            .write("watch-record")
        AidenBotWatchJournalStore(store, "bot-open-work")
            .journal("inst-clear", "dev-clear", pairedAt, "bot-1") { true }
            .write("open-work-record")

        val rawPrefs = appContext.getSharedPreferences(AIDEN_SECURE_PREFS_FILE_NAME, Context.MODE_PRIVATE)
        val keyKeysetBefore = rawPrefs.getString(AIDEN_KEY_KEYSET_ALIAS, null)
        val valueKeysetBefore = rawPrefs.getString(AIDEN_VALUE_KEYSET_ALIAS, null)
        assertNotNull(keyKeysetBefore)
        assertNotNull(valueKeysetBefore)

        store.clearAll()

        assertNull(store.getCredential("inst-clear:dev-clear"))
        assertNull(
            AidenBotWatchJournalStore(store)
                .journal("inst-clear", "dev-clear", pairedAt, "bot-1") { true }
                .read()
        )
        assertNull(
            AidenBotWatchJournalStore(store, "bot-open-work")
                .journal("inst-clear", "dev-clear", pairedAt, "bot-1") { true }
                .read()
        )
        assertEquals(
            setOf(AIDEN_KEY_KEYSET_ALIAS, AIDEN_VALUE_KEYSET_ALIAS),
            rawPrefs.all.keys
        )
        assertEquals(keyKeysetBefore, rawPrefs.getString(AIDEN_KEY_KEYSET_ALIAS, null))
        assertEquals(valueKeysetBefore, rawPrefs.getString(AIDEN_VALUE_KEYSET_ALIAS, null))

        // Subsequent writes on both the current instance and a fresh instance remain valid.
        store.setCredentialDurably("inst-after-clear:dev-1", "fresh-secret")
        assertEquals("fresh-secret", store.getCredential("inst-after-clear:dev-1"))
        assertEquals(
            "fresh-secret",
            AndroidAidenSecureStore(appContext).getCredential("inst-after-clear:dev-1")
        )
    }

    @Test
    fun failsClosedWhenKeystoreIsUnavailableOrKeysetIsCleartext() {
        val unavailableStore = AndroidAidenSecureStore(
            purgeFallbackPreferences = {},
            openCipherStore = { null }
        )
        assertNull(unavailableStore.getCredential("inst-1:dev-1"))
        assertThrows(IllegalStateException::class.java) {
            unavailableStore.setCredential("inst-1:dev-1", "secret")
        }
        assertThrows(IllegalStateException::class.java) {
            unavailableStore.setCredentialDurably("inst-1:dev-1", "secret")
        }
        unavailableStore.removeCredential("inst-1:dev-1")
        unavailableStore.removeCredentialDurably("inst-1:dev-1")
        unavailableStore.clearAll()

        // Plant a cleartext Tink keyset into SharedPreferences and verify AndroidAidenSecureStore
        // refuses AndroidKeysetManager's cleartext fallback and fails closed instead.
        AeadConfig.register()
        val config = RegistryConfiguration.get()
        val cleartextValueKeysetHex = Hex.encode(
            TinkProtoKeysetFormat.serializeKeyset(
                KeysetHandle.generateNew(PredefinedAeadParameters.AES256_GCM, config),
                InsecureSecretKeyAccess.get(),
                config
            )
        )
        val rawPrefs = appContext.getSharedPreferences(AIDEN_SECURE_PREFS_FILE_NAME, Context.MODE_PRIVATE)
        assertTrue(rawPrefs.edit().putString(AIDEN_VALUE_KEYSET_ALIAS, cleartextValueKeysetHex).commit())

        val tamperedKeysetStore = AndroidAidenSecureStore(appContext)
        assertNull(tamperedKeysetStore.getCredential("inst-1:dev-1"))
        assertThrows(IllegalStateException::class.java) {
            tamperedKeysetStore.setCredential("inst-1:dev-1", "secret")
        }
        assertThrows(IllegalStateException::class.java) {
            tamperedKeysetStore.setCredentialDurably("inst-1:dev-1", "secret")
        }
    }

    private fun resetSecurePreferencesAndKeystore() {
        appContext.getSharedPreferences(AIDEN_SECURE_PREFS_FILE_NAME, Context.MODE_PRIVATE)
            .edit().clear().commit()
        appContext.getSharedPreferences(AIDEN_FALLBACK_PREFS_FILE_NAME, Context.MODE_PRIVATE)
            .edit().clear().commit()
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keyStore.containsAlias(AIDEN_MASTER_KEY_ALIAS)) {
            keyStore.deleteEntry(AIDEN_MASTER_KEY_ALIAS)
        }
    }

    private fun putLegacyEncryptedString(
        editor: android.content.SharedPreferences.Editor,
        daead: DeterministicAead,
        aead: Aead,
        key: String,
        value: String
    ) {
        val encryptedKey = Base64.encode(
            daead.encryptDeterministically(
                key.toByteArray(Charsets.UTF_8),
                AIDEN_SECURE_PREFS_FILE_NAME.toByteArray(Charsets.UTF_8)
            )
        )
        val stringBytes = value.toByteArray(Charsets.UTF_8)
        val payload = ByteBuffer.allocate(Int.SIZE_BYTES + Int.SIZE_BYTES + stringBytes.size)
            .putInt(0)
            .putInt(stringBytes.size)
            .put(stringBytes)
            .array()
        val encryptedValue = Base64.encode(
            aead.encrypt(payload, encryptedKey.toByteArray(Charsets.UTF_8))
        )
        editor.putString(encryptedKey, encryptedValue)
    }

    private fun botJournalScope(
        namespace: String,
        instanceId: String,
        deviceId: String,
        pairedAt: Instant
    ): String {
        val identity = "$instanceId\u001f$deviceId\u001f$pairedAt"
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(identity.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return "aiden:$namespace:v1:$digest"
    }
}
