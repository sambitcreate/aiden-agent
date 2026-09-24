package sbtbiswas.AidenOnTheGo.features.chat

import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaDataSource
import android.media.MediaPlayer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.*
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import java.io.ByteArrayOutputStream
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** In-memory, one-segment native player. The paired desktop owns synthesis and replay. */
class AidenReadAloudPlayback(
    context: Context,
    private val scope: CoroutineScope,
    private val client: AidenRemoteClient?,
    private val chatId: String,
    private val current: () -> Boolean
) {
    var activeMessageId by mutableStateOf<String?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    private var epoch = 0L
    private var task: Job? = null
    private var player: MediaPlayer? = null
    private var requestId: String? = null
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private var focus: AudioFocusRequest? = null
    private val appContext = context.applicationContext
    private var noisyRegistered = false
    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { stop() }
    }

    fun stop() {
        epoch++
        task?.cancel(); task = null
        player?.release(); player = null
        activeMessageId = null
        focus?.let { audioManager.abandonAudioFocusRequest(it) }; focus = null
        if (noisyRegistered) { appContext.unregisterReceiver(noisy); noisyRegistered = false }
        val id = requestId; requestId = null
        if (id != null && client != null) {
            // Bounded cleanup outlives a disposed Compose scope; never retries start.
            CoroutineScope(Dispatchers.IO).launch {
                withTimeoutOrNull(10_000) { runCatching { client.stopReadAloud(chatId, id) } }
            }
        }
    }

    fun toggle(messageId: String) {
        if (activeMessageId != null) { stop(); return }
        stop()
        val api = client ?: return
        val token = epoch
        val id = UUID.randomUUID().toString()
        requestId = id; activeMessageId = messageId; error = null
        task = scope.launch {
            fun checkCurrent() { if (!isActive || epoch != token || !current()) throw CancellationException() }
            try {
                checkCurrent()
                val status = api.readAloudStatus(chatId)
                checkCurrent()
                check(status.enabled && status.ready) { READ_ALOUD_SETUP_GUIDANCE }
                val source = status.source
                check(source != null && source.chatId == chatId && source.messageId == messageId) { "This response is no longer available for Read Aloud." }
                val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(attributes).setOnAudioFocusChangeListener { change ->
                        if (change < 0) stop()
                    }.build()
                check(audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Audio playback is in use. Try again when it is available." }
                focus = request
                ContextCompat.registerReceiver(appContext, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
                noisyRegistered = true
                var job = api.startReadAloud(chatId, AidenReadAloudStart(id, source, status.settingsRevision))
                checkCurrent()
                val jobId = job.jobId
                var polls = 0
                while (job.phase != "completed") {
                    check(job.isValid && job.chatId == chatId && job.jobId == jobId && job.phase !in setOf("failed", "cancelled") && polls < 1_800) {
                        job.error?.message ?: "This soundbite is unavailable. Generation will not retry automatically."
                    }
                    delay(500); checkCurrent()
                    val update = api.readAloudStatus(chatId)
                    checkCurrent()
                    check(update.ready && update.source?.sourceRevision == source.sourceRevision) { "Read Aloud was disabled or the response changed on the desktop." }
                    job = update.job ?: throw IllegalStateException("This soundbite is no longer available.")
                    polls++
                }
                check(job.isValid && job.chatId == chatId && job.jobId == jobId && job.readySegments == job.totalSegments) { "Invalid Read Aloud completion." }
                var totalBytes = 0
                for (segment in 0 until job.totalSegments) {
                    val buffer = ByteArrayOutputStream()
                    var expectedTotal: Int? = null
                    while (true) {
                        val chunk = api.readAloudAudio(chatId, jobId, segment, buffer.size())
                        checkCurrent()
                        buffer.write(chunk.validatedBytes(buffer.size(), expectedTotal))
                        expectedTotal = chunk.segmentBytes
                        if (chunk.complete) break
                    }
                    totalBytes += buffer.size()
                    check(totalBytes <= 32 * 1_024 * 1_024) { "Read Aloud audio exceeded its session limit." }
                    val audio = MediaPlayer()
                    player = audio
                    audio.setAudioAttributes(attributes)
                    audio.setDataSource(MemoryAudio(buffer.toByteArray()))
                    var playbackError = false
                    suspendCancellableCoroutine<Unit> { continuation ->
                        audio.setOnPreparedListener { if (continuation.isActive) continuation.resume(Unit) }
                        audio.setOnErrorListener { _, _, _ ->
                            playbackError = true
                            if (continuation.isActive) continuation.resumeWithException(IllegalStateException("Read Aloud audio could not be played."))
                            true
                        }
                        audio.prepareAsync()
                    }
                    checkCurrent()
                    audio.start()
                    var ticks = 0
                    while (audio.isPlaying) {
                        delay(200); checkCurrent(); ticks++
                        if (ticks % 10 == 0) {
                            val update = api.readAloudStatus(chatId)
                            checkCurrent()
                            check(update.ready && update.source?.sourceRevision == source.sourceRevision && update.job?.jobId == jobId && update.job.phase == "completed") { "Read Aloud stopped on the desktop." }
                        }
                    }
                    check(!playbackError) { "Read Aloud audio could not be played." }
                    player = null; audio.release()
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                if (epoch == token && current()) error = failure.message ?: "Read Aloud is unavailable."
            } finally {
                if (epoch == token) stop()
            }
        }
    }

    private class MemoryAudio(private val bytes: ByteArray) : MediaDataSource() {
        override fun getSize(): Long = bytes.size.toLong()
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            if (position < 0 || position >= bytes.size) return -1
            val count = minOf(size, bytes.size - position.toInt())
            bytes.copyInto(buffer, offset, position.toInt(), position.toInt() + count)
            return count
        }
        override fun close() = Unit
    }
}
