package sbtbiswas.AidenOnTheGo.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

interface AidenSecureStore {
    fun getCredential(scope: String): String?
    fun setCredential(scope: String, credential: String)
    fun removeCredential(scope: String)
    /** Durably fences a request journal before its network mutation can begin. */
    fun setCredentialDurably(scope: String, value: String) = setCredential(scope, value)
    fun removeCredentialDurably(scope: String) = removeCredential(scope)
    fun clearAll()
}

class AndroidAidenSecureStore(context: Context) : AidenSecureStore {
    init {
        // Older development builds could write credentials here when Android Keystore
        // initialization failed. Remove that plaintext migration artifact eagerly.
        context.getSharedPreferences(
            "sbtbiswas.AidenOnTheGo.pairing.fallback",
            Context.MODE_PRIVATE
        ).edit().clear().apply()
    }

    private val prefs: SharedPreferences? by lazy {
        try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                "sbtbiswas.AidenOnTheGo.pairing",
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (_: Exception) {
            // Pairing credentials must never fall back to ordinary SharedPreferences.
            // Returning no credential keeps an existing installation disconnected, while
            // writes fail explicitly so pairing can surface the secure-storage problem.
            null
        }
    }

    override fun getCredential(scope: String): String? = prefs?.getString(scope, null)

    override fun setCredential(scope: String, credential: String) {
        val encryptedPreferences = prefs
            ?: throw IllegalStateException("Android secure credential storage is unavailable")
        encryptedPreferences.edit().putString(scope, credential).apply()
    }

    override fun setCredentialDurably(scope: String, value: String) {
        val encryptedPreferences = prefs
            ?: throw IllegalStateException("Android secure storage is unavailable")
        check(encryptedPreferences.edit().putString(scope, value).commit()) { "Secure state could not be saved" }
    }

    override fun removeCredentialDurably(scope: String) {
        val encryptedPreferences = prefs ?: return
        check(encryptedPreferences.edit().remove(scope).commit()) { "Secure state could not be removed" }
    }

    override fun removeCredential(scope: String) {
        prefs?.edit()?.remove(scope)?.apply()
    }

    override fun clearAll() {
        prefs?.edit()?.clear()?.apply()
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
