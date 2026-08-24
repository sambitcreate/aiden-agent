package sbtbiswas.AidenOnTheGo.features.chat

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

sealed class VoiceInputState {
    object Idle : VoiceInputState()
    object RequestingPermission : VoiceInputState()
    object Listening : VoiceInputState()
}

object ComposerVoiceDraftComposer {
    fun composedDraft(baseDraft: String, transcript: String): String {
        val cleanTranscript = transcript.trim()
        if (cleanTranscript.isEmpty()) return baseDraft
        val cleanBase = baseDraft.trim()
        return if (cleanBase.isEmpty()) cleanTranscript else "$cleanBase $cleanTranscript"
    }
}

class ComposerVoiceInputController(private val context: Context) {
    private val _state = MutableStateFlow<VoiceInputState>(VoiceInputState.Idle)
    val state: StateFlow<VoiceInputState> = _state.asStateFlow()

    private val _liveTranscript = MutableStateFlow("")
    val liveTranscript: StateFlow<String> = _liveTranscript.asStateFlow()

    private val _audioAmplitude = MutableStateFlow(0f)
    val audioAmplitude: StateFlow<Float> = _audioAmplitude.asStateFlow()

    private var speechRecognizer: SpeechRecognizer? = null
    private var baseDraft: String = ""
    private var onDraftUpdated: ((String) -> Unit)? = null

    val isListening: Boolean get() = _state.value is VoiceInputState.Listening

    fun start(currentDraft: String, onUpdate: (String) -> Unit) {
        if (isListening) return
        baseDraft = currentDraft
        onDraftUpdated = onUpdate
        _liveTranscript.value = ""
        _audioAmplitude.value = 0f

        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            _state.value = VoiceInputState.Idle
            return
        }

        val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
        speechRecognizer = recognizer

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        }

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                _state.value = VoiceInputState.Listening
            }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {
                // rmsdB typically ranges from -2dB (silence) to 10dB (loud); normalize to 0f..1f
                val normalized = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
                _audioAmplitude.value = normalized
            }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {
                _state.value = VoiceInputState.Idle
                _audioAmplitude.value = 0f
            }
            override fun onError(error: Int) {
                _state.value = VoiceInputState.Idle
                _audioAmplitude.value = 0f
                stop()
            }
            override fun onResults(results: Bundle?) {
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = matches?.firstOrNull() ?: ""
                _liveTranscript.value = text
                onDraftUpdated?.invoke(ComposerVoiceDraftComposer.composedDraft(baseDraft, text))
                _state.value = VoiceInputState.Idle
            }
            override fun onPartialResults(partialResults: Bundle?) {
                val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = matches?.firstOrNull() ?: ""
                _liveTranscript.value = text
                onDraftUpdated?.invoke(ComposerVoiceDraftComposer.composedDraft(baseDraft, text))
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        recognizer.startListening(intent)
        _state.value = VoiceInputState.Listening
    }

    fun stop() {
        speechRecognizer?.stopListening()
        speechRecognizer?.destroy()
        speechRecognizer = null
        _state.value = VoiceInputState.Idle
    }
}
