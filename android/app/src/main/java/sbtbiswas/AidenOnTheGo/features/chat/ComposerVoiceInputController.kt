package sbtbiswas.AidenOnTheGo.features.chat

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputMode
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticArea
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticCode
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticEvent
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticOutcome
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnostics
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

object ComposerVoiceDraftComposer {
    fun composedDraft(baseDraft: String, transcript: String): String {
        val cleanTranscript = transcript.trim()
        if (cleanTranscript.isEmpty()) return baseDraft
        val cleanBase = baseDraft.trim()
        return if (cleanBase.isEmpty()) cleanTranscript else "$cleanBase $cleanTranscript"
    }
}

enum class ComposerVoiceInputState { IDLE, PREPARING, LISTENING, TRANSCRIBING }

internal class ComposerVoiceSessionFence {
    private val generation = AtomicLong(0)

    val current: Long get() = generation.get()

    fun advance(): Long = generation.incrementAndGet()

    fun accepts(session: Long): Boolean = generation.get() == session
}

@Stable
class ComposerVoiceInputController(private val context: Context) {
    var state by mutableStateOf(ComposerVoiceInputState.IDLE)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set
    var rms by mutableFloatStateOf(0f)
        private set

    val isListening: Boolean get() = state == ComposerVoiceInputState.LISTENING
    val isBusy: Boolean get() = state != ComposerVoiceInputState.IDLE

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var recognizer: SpeechRecognizer? = null
    @Volatile private var audioRecord: AudioRecord? = null
    private var preparationJob: Job? = null
    private var recordingJob: Job? = null
    private var transcriptionJob: Job? = null
    private val sessionFence = ComposerVoiceSessionFence()
    private var nativeStopRequestedSession: Long? = null
    private var baseDraft = ""
    private var updateDraft: ((String) -> Unit)? = null
    private var activeClient: AidenRemoteClient? = null
    private var activeModelId: String? = null
    @Volatile private var shouldTranscribeMacRecording = false

    fun start(
        mode: AidenVoiceInputMode,
        currentDraft: String,
        client: AidenRemoteClient?,
        updateDraft: (String) -> Unit
    ) {
        if (state != ComposerVoiceInputState.IDLE) return
        val session = beginSession(currentDraft, updateDraft)
        if (mode == AidenVoiceInputMode.ON_DEVICE) startNative(session) else startMac(client, session)
    }

    fun stopKeepingTranscript() {
        val session = sessionFence.current
        when {
            recognizer != null -> {
                nativeStopRequestedSession = session
                state = ComposerVoiceInputState.TRANSCRIBING
                recognizer?.stopListening()
            }
            audioRecord != null -> stopMacRecording(transcribe = true, session = session)
        }
    }

    fun stopBeforeSubmittingDraft() = cancelDiscardingRecording()

    fun cancelDiscardingRecording() {
        invalidateSession()
        recognizer?.cancel()
        destroyNativeRecognizer()
        stopMacRecording(transcribe = false, session = null)
        clearSession()
    }

    fun reportPermissionDenied() {
        AidenDiagnostics.record(AidenDiagnosticArea.SPEECH, AidenDiagnosticEvent.SPEECH_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.UNAUTHORIZED)
        errorMessage = "Microphone access is disabled. Enable it in Settings to use voice input."
    }

    fun destroy() {
        cancelDiscardingRecording()
        scope.cancel()
    }

    private fun beginSession(currentDraft: String, updateDraft: (String) -> Unit): Long {
        val session = sessionFence.advance()
        nativeStopRequestedSession = null
        preparationJob?.cancel()
        transcriptionJob?.cancel()
        errorMessage = null
        baseDraft = currentDraft
        this.updateDraft = updateDraft
        return session
    }

    private fun invalidateSession() {
        sessionFence.advance()
        nativeStopRequestedSession = null
        preparationJob?.cancel()
        preparationJob = null
        transcriptionJob?.cancel()
        transcriptionJob = null
    }

    private fun isCurrent(session: Long): Boolean = sessionFence.accepts(session)

    private fun startNative(session: Long) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
            fail("On-device speech recognition is not installed. Open Voice input in Settings to install language support.", session, AidenDiagnosticCode.UNAVAILABLE)
            return
        }
        try {
            state = ComposerVoiceInputState.PREPARING
            recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context).also {
                it.setRecognitionListener(nativeListener(session))
                it.startListening(recognitionIntent())
            }
        } catch (_: Exception) {
            fail("On-device speech recognition could not start.", session, AidenDiagnosticCode.UNAVAILABLE)
        }
    }

    private fun recognitionIntent(): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    }

    private fun nativeListener(session: Long) = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) { if (isCurrent(session)) state = ComposerVoiceInputState.LISTENING }
        override fun onBeginningOfSpeech() { if (isCurrent(session)) state = ComposerVoiceInputState.LISTENING }
        override fun onRmsChanged(rmsdB: Float) { if (isCurrent(session)) rms = rmsdB }
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() { if (isCurrent(session)) state = ComposerVoiceInputState.TRANSCRIBING }
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
        override fun onPartialResults(results: Bundle?) {
            if (isCurrent(session) && state != ComposerVoiceInputState.IDLE) firstTranscript(results)?.let { updateTranscript(it, session) }
        }
        override fun onResults(results: Bundle?) {
            if (!isCurrent(session) || state == ComposerVoiceInputState.IDLE) return
            firstTranscript(results)?.let { updateTranscript(it, session) }
            destroyNativeRecognizer()
            clearSession(session)
        }
        override fun onError(error: Int) {
            if (!isCurrent(session) || state == ComposerVoiceInputState.IDLE) return
            destroyNativeRecognizer()
            if (nativeStopRequestedSession == session || error == SpeechRecognizer.ERROR_CLIENT) clearSession(session)
            else fail(nativeErrorMessage(error), session, nativeDiagnosticCode(error))
        }
    }

    private fun startMac(client: AidenRemoteClient?, session: Long) {
        if (client == null) {
            fail("Connect to your paired desktop before using desktop transcription.", session, AidenDiagnosticCode.NETWORK)
            return
        }
        state = ComposerVoiceInputState.PREPARING
        activeClient = client
        preparationJob = scope.launch {
            try {
                val status = client.speechStatus()
                ensureActive()
                if (!isCurrent(session)) return@launch
                if (!status.engine.ready) throw IllegalStateException(status.engine.error ?: "The desktop speech engine is unavailable.")
                val selected = status.models.firstOrNull { it.id == status.selectedModelId && it.installed }
                    ?: status.models.firstOrNull { it.installed && it.recommended }
                    ?: status.models.firstOrNull { it.installed }
                    ?: throw IllegalStateException("Download a desktop speech model in Settings before using this option.")
                if (status.selectedModelId != selected.id) client.selectSpeechModel(selected.id)
                ensureActive()
                if (!isCurrent(session)) return@launch
                activeModelId = selected.id
                beginMacRecording(session)
            } catch (error: Exception) {
                if (isCurrent(session)) fail(error.message ?: "Desktop transcription is unavailable.", session, AidenDiagnosticCode.NETWORK)
            } finally {
                if (isCurrent(session)) preparationJob = null
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun beginMacRecording(session: Long) {
        if (!isCurrent(session)) return
        val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0) {
            fail("The microphone input format is unavailable.", session, AidenDiagnosticCode.UNAVAILABLE)
            return
        }
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(minimum * 2, 8_192)
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            fail("The microphone could not start.", session, AidenDiagnosticCode.UNAVAILABLE)
            return
        }
        audioRecord = recorder
        shouldTranscribeMacRecording = true
        recorder.startRecording()
        state = ComposerVoiceInputState.LISTENING
        recordingJob = scope.launch(Dispatchers.IO) {
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(4_096)
            while (isCurrent(session) && audioRecord === recorder && output.size() < MAX_PCM_BYTES) {
                val read = recorder.read(buffer, 0, minOf(buffer.size, MAX_PCM_BYTES - output.size()))
                if (read > 0) output.write(buffer, 0, read) else if (read < 0) break
            }
            val pcm = output.toByteArray()
            withContext(Dispatchers.Main.immediate) {
                if (!isCurrent(session)) return@withContext
                if (audioRecord === recorder) stopMacRecorderOnly(recorder)
                if (shouldTranscribeMacRecording && pcm.isNotEmpty()) transcribeMac(pcm, session)
                else if (state != ComposerVoiceInputState.TRANSCRIBING) clearSession(session)
            }
        }
    }

    private fun stopMacRecording(transcribe: Boolean, session: Long?) {
        shouldTranscribeMacRecording = transcribe
        if (transcribe && session != null && isCurrent(session)) state = ComposerVoiceInputState.TRANSCRIBING
        val recorder = audioRecord ?: run {
            if (!transcribe) clearSession()
            return
        }
        audioRecord = null
        runCatching { recorder.stop() }
        recorder.release()
        if (!transcribe) {
            recordingJob?.cancel()
            recordingJob = null
            clearSession()
        }
    }

    private fun stopMacRecorderOnly(recorder: AudioRecord) {
        audioRecord = null
        runCatching { recorder.stop() }
        recorder.release()
    }

    private fun transcribeMac(pcm: ByteArray, session: Long) {
        val client = activeClient
        val modelId = activeModelId
        if (client == null || modelId == null) {
            fail("Desktop transcription stopped because the connection changed.", session, AidenDiagnosticCode.NETWORK)
            return
        }
        state = ComposerVoiceInputState.TRANSCRIBING
        transcriptionJob = scope.launch {
            try {
                val encoded = withContext(Dispatchers.Default) { Base64.encodeToString(pcm, Base64.NO_WRAP) }
                val result = client.transcribeSpeech(encoded, modelId)
                ensureActive()
                if (!isCurrent(session)) return@launch
                updateTranscript(result.text, session)
                clearSession(session)
            } catch (error: Exception) {
                if (isCurrent(session)) fail(error.message ?: "The paired desktop could not transcribe this recording.", session, AidenDiagnosticCode.NETWORK)
            } finally {
                if (isCurrent(session)) transcriptionJob = null
            }
        }
    }

    private fun updateTranscript(transcript: String, session: Long) {
        if (isCurrent(session)) updateDraft?.invoke(ComposerVoiceDraftComposer.composedDraft(baseDraft, transcript))
    }

    private fun firstTranscript(bundle: Bundle?): String? = bundle
        ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        ?.firstOrNull()?.trim()?.takeIf(String::isNotEmpty)

    private fun destroyNativeRecognizer() {
        recognizer?.destroy()
        recognizer = null
    }

    private fun fail(message: String, session: Long, code: AidenDiagnosticCode = AidenDiagnosticCode.UNKNOWN) {
        if (!isCurrent(session)) return
        AidenDiagnostics.record(AidenDiagnosticArea.SPEECH, AidenDiagnosticEvent.SPEECH_FAILED, AidenDiagnosticOutcome.FAILED, code)
        destroyNativeRecognizer()
        stopMacRecording(transcribe = false, session = session)
        errorMessage = message
        clearSession(session)
    }

    private fun clearSession(expectedSession: Long? = null) {
        if (expectedSession != null && !isCurrent(expectedSession)) return
        state = ComposerVoiceInputState.IDLE
        rms = 0f
        baseDraft = ""
        updateDraft = null
        activeClient = null
        activeModelId = null
        shouldTranscribeMacRecording = false
        nativeStopRequestedSession = null
    }

    private fun nativeErrorMessage(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_NO_MATCH -> "I couldn't hear any speech. Try again."
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech was detected."
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone access is disabled. Enable it in Settings to use voice input."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognition is busy. Try again in a moment."
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
        SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "On-device speech recognition is not installed for this language."
        else -> "On-device speech recognition stopped unexpectedly."
    }

    private fun nativeDiagnosticCode(error: Int): AidenDiagnosticCode = when (error) {
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> AidenDiagnosticCode.UNAUTHORIZED
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
        SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE,
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> AidenDiagnosticCode.UNAVAILABLE
        else -> AidenDiagnosticCode.UNKNOWN
    }

    private companion object {
        const val SAMPLE_RATE = 16_000
        const val MAX_PCM_BYTES = SAMPLE_RATE * 2 * 60
    }
}
