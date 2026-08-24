package sbtbiswas.AidenOnTheGo.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

interface AidenSecureStore {
    fun getCredential(scope: String): String?
    fun setCredential(scope: String, credential: String)
    fun removeCredential(scope: String)
    fun clearAll()
}

class AndroidAidenSecureStore(context: Context) : AidenSecureStore {
    private val prefs: SharedPreferences by lazy {
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
            // Fallback for tests or sandbox
            context.getSharedPreferences("sbtbiswas.AidenOnTheGo.pairing.fallback", Context.MODE_PRIVATE)
        }
    }

    override fun getCredential(scope: String): String? = prefs.getString(scope, null)

    override fun setCredential(scope: String, credential: String) {
        prefs.edit().putString(scope, credential).apply()
    }

    override fun removeCredential(scope: String) {
        prefs.edit().remove(scope).apply()
    }

    override fun clearAll() {
        prefs.edit().clear().apply()
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
