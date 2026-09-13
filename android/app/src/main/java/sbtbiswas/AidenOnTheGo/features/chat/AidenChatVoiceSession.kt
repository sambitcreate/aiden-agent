package sbtbiswas.AidenOnTheGo.features.chat

import androidx.lifecycle.ViewModel

/** Voice capture belongs to the chat entry, not the pane's current composition. */
class AidenChatVoiceSession(val controller: ComposerVoiceInputController) : ViewModel() {
    override fun onCleared() { controller.destroy() }
}
