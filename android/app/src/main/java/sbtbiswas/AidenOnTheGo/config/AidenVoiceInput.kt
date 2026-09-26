package sbtbiswas.AidenOnTheGo.config

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class AidenVoiceInputMode(val wireValue: String, val title: String) {
    ON_DEVICE("on-device", "On this device"),
    PAIRED_MAC("paired-mac", "Paired desktop");

    companion object {
        fun fromWireValue(value: String?): AidenVoiceInputMode =
            entries.firstOrNull { it.wireValue == value } ?: ON_DEVICE
    }
}

class AidenVoiceInputStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        "aiden_voice_input",
        Context.MODE_PRIVATE
    )
    private val _mode = MutableStateFlow(
        AidenVoiceInputMode.fromWireValue(preferences.getString(KEY_MODE, null))
    )
    val mode: StateFlow<AidenVoiceInputMode> = _mode.asStateFlow()

    fun updateMode(mode: AidenVoiceInputMode) {
        preferences.edit().putString(KEY_MODE, mode.wireValue).apply()
        _mode.value = mode
    }

    private companion object {
        const val KEY_MODE = "mode"
    }
}
