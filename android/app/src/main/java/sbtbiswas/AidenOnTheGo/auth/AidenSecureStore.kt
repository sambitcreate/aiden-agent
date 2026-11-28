package sbtbiswas.AidenOnTheGo.auth

import android.content.Context
import android.content.SharedPreferences
import com.google.crypto.tink.Aead
import com.google.crypto.tink.DeterministicAead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.TinkProtoKeysetFormat
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.daead.DeterministicAeadConfig
import com.google.crypto.tink.integration.android.AndroidKeysetManager
import com.google.crypto.tink.integration.android.AndroidKeystoreKmsClient
import com.google.crypto.tink.subtle.Base64
import com.google.crypto.tink.subtle.Hex
import java.nio.BufferUnderflowException
import java.nio.ByteBuffer
import java.security.GeneralSecurityException

interface AidenSecureStore {
    fun getCredential(scope: String): String?
    fun setCredential(scope: String, credential: String)
    fun removeCredential(scope: String)
    /** Durably fences a request journal before its network mutation can begin. */
    fun setCredentialDurably(scope: String, value: String) = setCredential(scope, value)
    fun removeCredentialDurably(scope: String) = removeCredential(scope)
    fun clearAll()
}

internal const val AIDEN_SECURE_PREFS_FILE_NAME = "sbtbiswas.AidenOnTheGo.pairing"
internal const val AIDEN_FALLBACK_PREFS_FILE_NAME = "sbtbiswas.AidenOnTheGo.pairing.fallback"
internal const val AIDEN_MASTER_KEY_ALIAS = "_androidx_security_master_key_"
internal const val AIDEN_MASTER_KEY_URI = "android-keystore://$AIDEN_MASTER_KEY_ALIAS"
internal const val AIDEN_KEY_KEYSET_ALIAS = "__androidx_security_crypto_encrypted_prefs_key_keyset__"
internal const val AIDEN_VALUE_KEYSET_ALIAS = "__androidx_security_crypto_encrypted_prefs_value_keyset__"

private const val KEY_TEMPLATE_NAME = "AES256_SIV"
private const val VALUE_TEMPLATE_NAME = "AES256_GCM"
private const val NULL_PLAINTEXT_SENTINEL = "__NULL__"
private const val STRING_ENCRYPTED_TYPE_ID = 0
private val EMPTY_ASSOCIATED_DATA = ByteArray(0)
private val FILE_NAME_ASSOCIATED_DATA = AIDEN_SECURE_PREFS_FILE_NAME.toByteArray(Charsets.UTF_8)
private val keysetInitLock = Any()

internal fun isReservedSecureStoreKey(key: String): Boolean =
    key == AIDEN_KEY_KEYSET_ALIAS || key == AIDEN_VALUE_KEYSET_ALIAS

private fun requireNotReservedKey(key: String) {
    if (isReservedSecureStoreKey(key)) {
        throw SecurityException("$key is a reserved key for the encryption keyset.")
    }
}

internal interface RawPreferencesBackend {
    fun allKeys(): Set<String>
    fun contains(key: String): Boolean
    fun getString(key: String): String?
    fun putStringAsync(key: String, value: String)
    fun putStringCommit(key: String, value: String): Boolean
    fun removeAsync(key: String)
    fun removeCommit(key: String): Boolean
    fun removeManyAsync(keys: Collection<String>)
}

internal class SharedPreferencesBackend(
    private val prefs: SharedPreferences
) : RawPreferencesBackend {
    override fun allKeys(): Set<String> = prefs.all.keys.toSet()

    override fun contains(key: String): Boolean = prefs.contains(key)

    override fun getString(key: String): String? = prefs.getString(key, null)

    override fun putStringAsync(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    override fun putStringCommit(key: String, value: String): Boolean =
        prefs.edit().putString(key, value).commit()

    override fun removeAsync(key: String) {
        prefs.edit().remove(key).apply()
    }

    override fun removeCommit(key: String): Boolean =
        prefs.edit().remove(key).commit()

    override fun removeManyAsync(keys: Collection<String>) {
        if (keys.isEmpty()) return
        val editor = prefs.edit()
        for (key in keys) {
            editor.remove(key)
        }
        editor.apply()
    }
}

internal class TinkPreferencesStore(
    private val backend: RawPreferencesBackend,
    private val keyDeterministicAead: DeterministicAead,
    private val valueAead: Aead
) {
    fun getString(scope: String): String? {
        requireNotReservedKey(scope)
        val encryptedKey = encryptKey(scope)
        val encryptedValue = try {
            backend.getString(encryptedKey)
        } catch (error: ClassCastException) {
            throw SecurityException("Could not read encrypted value for $scope", error)
        } ?: return null

        return decryptStringValue(encryptedKey, encryptedValue)
    }

    fun putStringAsync(scope: String, value: String) {
        requireNotReservedKey(scope)
        val (encryptedKey, encryptedValue) = encryptEntry(scope, value)
        backend.putStringAsync(encryptedKey, encryptedValue)
    }

    fun putStringSynchronously(scope: String, value: String): Boolean {
        requireNotReservedKey(scope)
        val (encryptedKey, encryptedValue) = encryptEntry(scope, value)
        return backend.putStringCommit(encryptedKey, encryptedValue)
    }

    fun removeAsync(scope: String) {
        requireNotReservedKey(scope)
        val encryptedKey = encryptKey(scope)
        backend.removeAsync(encryptedKey)
    }

    fun removeSynchronously(scope: String): Boolean {
        requireNotReservedKey(scope)
        val encryptedKey = encryptKey(scope)
        return backend.removeCommit(encryptedKey)
    }

    fun clearAll() {
        val userKeys = backend.allKeys().filterNot(::isReservedSecureStoreKey)
        backend.removeManyAsync(userKeys)
    }

    internal fun encryptKey(scope: String): String {
        return try {
            val cipherBytes = keyDeterministicAead.encryptDeterministically(
                scope.toByteArray(Charsets.UTF_8),
                FILE_NAME_ASSOCIATED_DATA
            )
            Base64.encode(cipherBytes)
        } catch (error: GeneralSecurityException) {
            throw SecurityException("Could not encrypt key", error)
        }
    }

    private fun encryptEntry(scope: String, value: String): Pair<String, String> {
        val encryptedKey = encryptKey(scope)
        val stringBytes = value.toByteArray(Charsets.UTF_8)
        val payload = ByteBuffer.allocate(Int.SIZE_BYTES + Int.SIZE_BYTES + stringBytes.size)
            .putInt(STRING_ENCRYPTED_TYPE_ID)
            .putInt(stringBytes.size)
            .put(stringBytes)
            .array()
        val encryptedValue = try {
            val cipherBytes = valueAead.encrypt(payload, encryptedKey.toByteArray(Charsets.UTF_8))
            Base64.encode(cipherBytes)
        } catch (error: GeneralSecurityException) {
            throw SecurityException("Could not encrypt value", error)
        }
        return encryptedKey to encryptedValue
    }

    private fun decryptStringValue(encryptedKey: String, encryptedValue: String): String? {
        return try {
            val cipherBytes = Base64.decode(encryptedValue, Base64.DEFAULT)
            val plainBytes = valueAead.decrypt(cipherBytes, encryptedKey.toByteArray(Charsets.UTF_8))
            val buffer = ByteBuffer.wrap(plainBytes)
            if (buffer.remaining() < Int.SIZE_BYTES + Int.SIZE_BYTES) {
                throw SecurityException("Decrypted payload is truncated")
            }
            val typeId = buffer.int
            if (typeId != STRING_ENCRYPTED_TYPE_ID) {
                throw SecurityException("Unexpected encrypted value type: $typeId")
            }
            val stringByteLength = buffer.int
            if (stringByteLength < 0 || stringByteLength != buffer.remaining()) {
                throw SecurityException("Invalid decrypted string byte length: $stringByteLength")
            }
            val stringBytes = ByteArray(stringByteLength)
            buffer.get(stringBytes)
            val decoded = String(stringBytes, Charsets.UTF_8)
            if (decoded == NULL_PLAINTEXT_SENTINEL) null else decoded
        } catch (error: SecurityException) {
            throw error
        } catch (error: GeneralSecurityException) {
            throw SecurityException("Could not decrypt value", error)
        } catch (error: IllegalArgumentException) {
            throw SecurityException("Malformed encrypted value encoding", error)
        } catch (error: BufferUnderflowException) {
            throw SecurityException("Truncated encrypted value payload", error)
        }
    }
}

private fun openHardwareBackedStore(context: Context): TinkPreferencesStore = synchronized(keysetInitLock) {
    DeterministicAeadConfig.register()
    AeadConfig.register()

    val appContext = context.applicationContext ?: context
    // Acquire or provision the hardware-backed master key explicitly first so AndroidKeysetManager
    // can never silently degrade to cleartext keysets when AndroidKeyStore is unavailable.
    val masterAead = AndroidKeystoreKmsClient.getOrGenerateNewAeadKey(AIDEN_MASTER_KEY_URI)

    val rawPrefs = appContext.getSharedPreferences(AIDEN_SECURE_PREFS_FILE_NAME, Context.MODE_PRIVATE)
    val backend = SharedPreferencesBackend(rawPrefs)

    // Pre-validate existing keyset blobs against masterAead so tampered cleartext keysets in XML fail closed.
    validateExistingPreferencesKeysets(backend, masterAead)

    val keyKeysetManager = AndroidKeysetManager.Builder()
        .withSharedPref(appContext, AIDEN_KEY_KEYSET_ALIAS, AIDEN_SECURE_PREFS_FILE_NAME)
        .withKeyTemplate(KeyTemplates.get(KEY_TEMPLATE_NAME))
        .withMasterKeyUri(AIDEN_MASTER_KEY_URI)
        .build()
    val valueKeysetManager = AndroidKeysetManager.Builder()
        .withSharedPref(appContext, AIDEN_VALUE_KEYSET_ALIAS, AIDEN_SECURE_PREFS_FILE_NAME)
        .withKeyTemplate(KeyTemplates.get(VALUE_TEMPLATE_NAME))
        .withMasterKeyUri(AIDEN_MASTER_KEY_URI)
        .build()

    check(keyKeysetManager.isUsingKeystore && valueKeysetManager.isUsingKeystore) {
        "Tink keysets must be backed by AndroidKeyStore"
    }

    verifyStoredEncryptedKeyset(backend, AIDEN_KEY_KEYSET_ALIAS, masterAead)
    verifyStoredEncryptedKeyset(backend, AIDEN_VALUE_KEYSET_ALIAS, masterAead)

    val registryConfig = RegistryConfiguration.get()
    val keyDeterministicAead = keyKeysetManager.keysetHandle.getPrimitive(
        registryConfig,
        DeterministicAead::class.java
    )
    val valueAead = valueKeysetManager.keysetHandle.getPrimitive(
        registryConfig,
        Aead::class.java
    )

    TinkPreferencesStore(
        backend = backend,
        keyDeterministicAead = keyDeterministicAead,
        valueAead = valueAead
    )
}

internal fun validateExistingPreferencesKeysets(
    backend: RawPreferencesBackend,
    masterAead: Aead
) {
    val existingKeys = backend.allKeys()
    val hasUserEntries = existingKeys.any { !isReservedSecureStoreKey(it) }
    if (hasUserEntries) {
        if (!backend.contains(AIDEN_KEY_KEYSET_ALIAS) || !backend.contains(AIDEN_VALUE_KEYSET_ALIAS)) {
            throw GeneralSecurityException("Encrypted preferences are missing keyset metadata")
        }
    }
    if (backend.contains(AIDEN_KEY_KEYSET_ALIAS)) {
        verifyStoredEncryptedKeyset(backend, AIDEN_KEY_KEYSET_ALIAS, masterAead)
    }
    if (backend.contains(AIDEN_VALUE_KEYSET_ALIAS)) {
        verifyStoredEncryptedKeyset(backend, AIDEN_VALUE_KEYSET_ALIAS, masterAead)
    }
}

internal fun verifyStoredEncryptedKeyset(
    backend: RawPreferencesBackend,
    keysetAlias: String,
    masterAead: Aead
) {
    val serializedHex = try {
        backend.getString(keysetAlias)
    } catch (error: ClassCastException) {
        throw GeneralSecurityException("Corrupted keyset entry type for $keysetAlias", error)
    } ?: throw GeneralSecurityException("Missing encrypted keyset for $keysetAlias")

    val encryptedBytes = try {
        Hex.decode(serializedHex)
    } catch (error: IllegalArgumentException) {
        throw GeneralSecurityException("Malformed hex keyset for $keysetAlias", error)
    }
    TinkProtoKeysetFormat.parseEncryptedKeyset(
        encryptedBytes,
        masterAead,
        EMPTY_ASSOCIATED_DATA,
        RegistryConfiguration.get()
    )
}

class AndroidAidenSecureStore internal constructor(
    purgeFallbackPreferences: () -> Unit,
    openCipherStore: () -> TinkPreferencesStore?
) : AidenSecureStore {
    constructor(context: Context) : this(
        purgeFallbackPreferences = {
            val appContext = context.applicationContext ?: context
            // Older development builds could write credentials here when Android Keystore
            // initialization failed. Remove that plaintext migration artifact eagerly.
            appContext.getSharedPreferences(
                AIDEN_FALLBACK_PREFS_FILE_NAME,
                Context.MODE_PRIVATE
            ).edit().clear().apply()
        },
        openCipherStore = {
            try {
                openHardwareBackedStore(context)
            } catch (_: Exception) {
                // Pairing credentials must never fall back to ordinary SharedPreferences.
                // Returning no credential keeps an existing installation disconnected, while
                // writes fail explicitly so pairing can surface the secure-storage problem.
                null
            }
        }
    )

    init {
        purgeFallbackPreferences()
    }

    private val cipherStore: TinkPreferencesStore? by lazy {
        try {
            openCipherStore()
        } catch (_: Exception) {
            null
        }
    }

    override fun getCredential(scope: String): String? {
        requireNotReservedKey(scope)
        return cipherStore?.getString(scope)
    }

    override fun setCredential(scope: String, credential: String) {
        requireNotReservedKey(scope)
        val encryptedPreferences = cipherStore
            ?: throw IllegalStateException("Android secure credential storage is unavailable")
        encryptedPreferences.putStringAsync(scope, credential)
    }

    override fun setCredentialDurably(scope: String, value: String) {
        requireNotReservedKey(scope)
        val encryptedPreferences = cipherStore
            ?: throw IllegalStateException("Android secure storage is unavailable")
        check(encryptedPreferences.putStringSynchronously(scope, value)) { "Secure state could not be saved" }
    }

    override fun removeCredentialDurably(scope: String) {
        requireNotReservedKey(scope)
        val encryptedPreferences = cipherStore ?: return
        check(encryptedPreferences.removeSynchronously(scope)) { "Secure state could not be removed" }
    }

    override fun removeCredential(scope: String) {
        requireNotReservedKey(scope)
        cipherStore?.removeAsync(scope)
    }

    override fun clearAll() {
        cipherStore?.clearAll()
    }
}

class InMemoryAidenSecureStore : AidenSecureStore {
    private val store = mutableMapOf<String, String>()

    override fun getCredential(scope: String): String? = store[scope]

    override fun setCredential(scope: String, credential: String) {
        store[scope] = credential
    }

    override fun removeCredential(scope: String) {
        store.remove(scope)
    }

    override fun clearAll() {
        store.clear()
    }
}
