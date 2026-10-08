package sbtbiswas.AidenOnTheGo.networking

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException

// Native client for one shared iOS simulator, reached through the Mac's
// authenticated hub relay (Aiden Remote contract revision 25). Video is the
// helper's MJPEG body; input is the helper's `[tag][json]` socket.
// Adapted from t3code apps/mobile/src/features/devices/device-stream.browser.ts (MIT)
// and Aiden's renderer/lib/device-stream.ts.

class AidenSimulatorStreamException(message: String) : IOException(message)

/**
 * Incremental `multipart/x-mixed-replace` parser. Feed it arbitrary chunks;
 * it returns every JPEG completed by that chunk. A part's `Content-Length` is
 * honoured when present (the JPEG may contain the boundary bytes); otherwise a
 * part ends at the next `\r\n--<boundary>`. A part larger than
 * [maximumPartBytes] fails the stream instead of growing the buffer.
 */
class AidenMjpegParser(
    boundary: String = DEFAULT_BOUNDARY,
    private val maximumPartBytes: Int = MAXIMUM_PART_BYTES
) {
    private val delimiter = "--$boundary".toByteArray(Charsets.US_ASCII)
    private val bodyTerminator = "\r\n--$boundary".toByteArray(Charsets.US_ASCII)

    private var buffer = ByteArray(16 * 1024)
    private var start = 0
    private var end = 0
    private var searchFrom = 0

    private enum class State { BOUNDARY, HEADERS, BODY }
    private var state = State.BOUNDARY
    private var contentLength = -1
    private var headersFrom = 0

    fun feed(chunk: ByteArray, offset: Int = 0, length: Int = chunk.size - offset): List<ByteArray> {
        append(chunk, offset, length)
        val frames = mutableListOf<ByteArray>()
        while (true) {
            val progressed = when (state) {
                State.BOUNDARY -> seekBoundary()
                State.HEADERS -> readHeaders()
                State.BODY -> readBody(frames)
            }
            if (!progressed) break
        }
        return frames
    }

    private fun seekBoundary(): Boolean {
        val index = indexOf(delimiter, maxOf(start, searchFrom))
        if (index < 0) {
            // Keep only a possible partial delimiter at the tail.
            val keep = minOf(end - start, delimiter.size - 1)
            start = end - keep
            searchFrom = start
            return false
        }
        start = index + delimiter.size
        headersFrom = start
        searchFrom = start
        contentLength = -1
        state = State.HEADERS
        return true
    }

    private fun readHeaders(): Boolean {
        val terminator = indexOf(HEADER_END, maxOf(headersFrom, searchFrom))
        if (terminator < 0) {
            if (end - headersFrom > MAXIMUM_HEADER_BYTES) {
                throw AidenSimulatorStreamException("MJPEG part headers are too large.")
            }
            searchFrom = maxOf(headersFrom, end - HEADER_END.size + 1)
            return false
        }
        // The delimiter line's own CRLF is the first half of an empty header block.
        val headerText = String(buffer, headersFrom, terminator - headersFrom, Charsets.ISO_8859_1)
        contentLength = parseContentLength(headerText)
        if (contentLength > maximumPartBytes) {
            throw AidenSimulatorStreamException("MJPEG part exceeds the frame limit.")
        }
        start = terminator + HEADER_END.size
        searchFrom = start
        state = State.BODY
        return true
    }

    private fun readBody(frames: MutableList<ByteArray>): Boolean {
        if (contentLength >= 0) {
            if (end - start < contentLength) return false
            frames += buffer.copyOfRange(start, start + contentLength)
            start += contentLength
        } else {
            val index = indexOf(bodyTerminator, maxOf(start, searchFrom))
            if (index < 0) {
                if (end - start > maximumPartBytes + bodyTerminator.size) {
                    throw AidenSimulatorStreamException("MJPEG part exceeds the frame limit.")
                }
                searchFrom = maxOf(start, end - bodyTerminator.size + 1)
                return false
            }
            if (index - start > maximumPartBytes) {
                throw AidenSimulatorStreamException("MJPEG part exceeds the frame limit.")
            }
            frames += buffer.copyOfRange(start, index)
            // Leave "--boundary" in place for the next part.
            start = index + 2
        }
        searchFrom = start
        state = State.BOUNDARY
        return true
    }

    private fun append(chunk: ByteArray, offset: Int, length: Int) {
        if (length <= 0) return
        if (end + length > buffer.size) {
            val live = end - start
            val needed = live + length
            if (needed > buffer.size || start == 0) {
                var capacity = buffer.size
                while (capacity < needed) capacity *= 2
                val next = ByteArray(capacity)
                System.arraycopy(buffer, start, next, 0, live)
                buffer = next
            } else {
                System.arraycopy(buffer, start, buffer, 0, live)
            }
            searchFrom -= start
            headersFrom -= start
            start = 0
            end = live
        }
        System.arraycopy(chunk, offset, buffer, end, length)
        end += length
    }

    private fun indexOf(pattern: ByteArray, from: Int): Int {
        var i = maxOf(from, start)
        val last = end - pattern.size
        outer@ while (i <= last) {
            for (j in pattern.indices) {
                if (buffer[i + j] != pattern[j]) {
                    i++
                    continue@outer
                }
            }
            return i
        }
        return -1
    }

    companion object {
        const val DEFAULT_BOUNDARY = "frame"
        const val MAXIMUM_PART_BYTES = 8 * 1024 * 1024
        private const val MAXIMUM_HEADER_BYTES = 8 * 1024
        private val HEADER_END = "\r\n\r\n".toByteArray(Charsets.US_ASCII)
        private val BOUNDARY_PARAMETER = Regex("""(?i)(?:^|;)\s*boundary\s*=\s*("([^"]*)"|[^;\s]+)""")

        /** The multipart boundary from a `Content-Type` header, or `frame` when absent. */
        fun boundaryFrom(contentType: String?): String {
            val match = contentType?.let { BOUNDARY_PARAMETER.find(it) } ?: return DEFAULT_BOUNDARY
            val raw = match.groupValues[2].ifEmpty { match.groupValues[1] }
            val boundary = raw.removePrefix("--")
            return boundary.takeIf { it.isNotEmpty() && it.length <= 70 && it.all { ch -> ch.code in 0x21..0x7E } }
                ?: DEFAULT_BOUNDARY
        }

        private fun parseContentLength(headers: String): Int {
            for (line in headers.split("\r\n")) {
                val colon = line.indexOf(':')
                if (colon <= 0) continue
                if (!line.substring(0, colon).trim().equals("Content-Length", ignoreCase = true)) continue
                val value = line.substring(colon + 1).trim()
                if (value.isEmpty() || !value.all { it.isDigit() } || value.length > 10) {
                    throw AidenSimulatorStreamException("Invalid MJPEG Content-Length.")
                }
                return value.toLongOrNull()?.takeIf { it <= Int.MAX_VALUE }?.toInt()
                    ?: throw AidenSimulatorStreamException("Invalid MJPEG Content-Length.")
            }
            return -1
        }
    }
}

enum class AidenSimulatorOrientation(val wireValue: String) {
    PORTRAIT("portrait"),
    LANDSCAPE_LEFT("landscape_left"),
    PORTRAIT_UPSIDE_DOWN("portrait_upside_down"),
    LANDSCAPE_RIGHT("landscape_right");

    /** Rotate cycles portrait → landscape left → upside down → landscape right. */
    val next: AidenSimulatorOrientation
        get() = entries[(ordinal + 1) % entries.size]

    companion object {
        fun fromWire(value: String): AidenSimulatorOrientation? = entries.firstOrNull { it.wireValue == value }
    }
}

/** The helper's last reported framebuffer size and orientation. */
data class AidenSimulatorScreen(
    val width: Int,
    val height: Int,
    val orientation: AidenSimulatorOrientation
)

enum class AidenSimulatorTouchPhase(val wireValue: String) { BEGIN("begin"), MOVE("move"), END("end") }

enum class AidenSimulatorButton(val wireValue: String) {
    HOME("home"),
    LOCK("lock"),
    APP_SWITCHER("app_switcher")
}

/** Encoders and decoders for the helper's binary `[tag][UTF-8 JSON]` messages. */
object AidenSimulatorInput {
    const val TAG_TOUCH = 0x03
    const val TAG_BUTTON = 0x04
    const val TAG_ORIENTATION = 0x07
    const val TAG_HARDWARE_KEYBOARD = 0x0D
    const val TAG_SCREEN_CONFIG = 0x82
    const val TAG_CONTROL_REPLY = 0x90

    private val json = Json { ignoreUnknownKeys = true }

    fun hardwareKeyboard(enabled: Boolean): ByteArray =
        tagged(TAG_HARDWARE_KEYBOARD, buildJsonObject { put("enabled", enabled) })

    /**
     * A touch at ([x], [y]) normalized to the displayed frame (0,0 top-left).
     * A portrait framebuffer shown rotated is remapped into its own axes.
     */
    fun touch(
        phase: AidenSimulatorTouchPhase,
        x: Double,
        y: Double,
        screen: AidenSimulatorScreen?
    ): ByteArray {
        val (mappedX, mappedY) = mapTouch(x, y, screen)
        return tagged(TAG_TOUCH, buildJsonObject {
            put("type", phase.wireValue)
            put("x", mappedX)
            put("y", mappedY)
        })
    }

    fun button(button: AidenSimulatorButton): ByteArray =
        tagged(TAG_BUTTON, buildJsonObject { put("button", button.wireValue) })

    /** Rotates one step from the last screen config's orientation (portrait without one). */
    fun rotate(screen: AidenSimulatorScreen?): ByteArray {
        val next = (screen?.orientation ?: AidenSimulatorOrientation.PORTRAIT).next
        return tagged(TAG_ORIENTATION, buildJsonObject { put("orientation", next.wireValue) })
    }

    fun mapTouch(x: Double, y: Double, screen: AidenSimulatorScreen?): Pair<Double, Double> {
        if (screen == null || screen.width > screen.height) return x to y
        return when (screen.orientation) {
            AidenSimulatorOrientation.LANDSCAPE_LEFT -> y to 1 - x
            AidenSimulatorOrientation.LANDSCAPE_RIGHT -> 1 - y to x
            AidenSimulatorOrientation.PORTRAIT_UPSIDE_DOWN -> 1 - x to 1 - y
            AidenSimulatorOrientation.PORTRAIT -> x to y
        }
    }

    /** A valid `0x82` screen config, or null for any other or malformed message. */
    fun decodeScreenConfig(message: ByteArray): AidenSimulatorScreen? {
        if (message.isEmpty() || (message[0].toInt() and 0xFF) != TAG_SCREEN_CONFIG) return null
        val payload = runCatching {
            json.parseToJsonElement(String(message, 1, message.size - 1, Charsets.UTF_8)).jsonObject
        }.getOrNull() ?: return null
        val width = payload.positiveInt("width") ?: return null
        val height = payload.positiveInt("height") ?: return null
        val orientation = (payload["orientation"] as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.let { AidenSimulatorOrientation.fromWire(it.content) }
            ?: return null
        return AidenSimulatorScreen(width, height, orientation)
    }

    private fun JsonObject.positiveInt(key: String): Int? {
        val primitive = this[key] as? JsonPrimitive ?: return null
        if (primitive.isString) return null
        val value = primitive.doubleOrNull ?: return null
        if (!value.isFinite() || value <= 0 || value > Int.MAX_VALUE) return null
        return value.toInt().takeIf { it > 0 }
    }

    private fun tagged(tag: Int, payload: JsonObject): ByteArray {
        val body = payload.toString().toByteArray(Charsets.UTF_8)
        val out = ByteArray(body.size + 1)
        out[0] = tag.toByte()
        System.arraycopy(body, 0, out, 1, body.size)
        return out
    }
}

enum class AidenSimulatorStreamPhase { CONNECTING, STREAMING, FAILED }

enum class AidenSimulatorStreamFailure {
    /** The credential or the simulator grant was refused; retrying cannot help. */
    REFUSED,
    /** Sharing was turned off on the Mac, or the device is gone. */
    NOT_FOUND,
    /** The relay already holds its per-device stream budget. */
    CAPACITY,
    NETWORK
}

data class AidenSimulatorStreamState(
    val phase: AidenSimulatorStreamPhase = AidenSimulatorStreamPhase.CONNECTING,
    val inputConnected: Boolean = false,
    val screen: AidenSimulatorScreen? = null,
    val failure: AidenSimulatorStreamFailure? = null
)

/**
 * One device's MJPEG stream plus its input socket. [start] opens the MJPEG
 * request first (serve-sim accepts HID only once capture runs) and the socket
 * once the stream answers. Decoding runs on [decodeDispatcher] and keeps only
 * the newest JPEG: a frame that arrives during a decode replaces the pending
 * one rather than queueing behind it.
 */
class AidenSimulatorStreamSession<Frame : Any>(
    private val httpClient: OkHttpClient,
    private val mjpegRequest: Request,
    private val inputRequest: Request,
    private val scope: CoroutineScope,
    private val decodeFrame: (ByteArray) -> Frame?,
    private val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
    private val decodeDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Default,
    private val retryDelayMillis: Long = RETRY_DELAY_MILLIS,
    private val clock: () -> Long = System::currentTimeMillis
) {
    private val _state = MutableStateFlow(AidenSimulatorStreamState())
    val state: StateFlow<AidenSimulatorStreamState> = _state.asStateFlow()

    private val _frame = MutableStateFlow<Frame?>(null)
    val frame: StateFlow<Frame?> = _frame.asStateFlow()

    private val pendingJpeg = MutableStateFlow<ByteArray?>(null)

    private val lock = Any()
    private var running = false
    private var generation = 0L
    @Volatile private var streamJob: Job? = null
    @Volatile private var decodeJob: Job? = null
    @Volatile private var retryJob: Job? = null
    private var streamCall: Call? = null
    private var socket: WebSocket? = null
    private var socketOpenedAt = 0L
    private var socketRetryAvailable = true
    /** When the current MJPEG read delivered its first frame, or 0. */
    @Volatile private var firstFrameAt = 0L

    fun start() {
        val runGeneration = synchronized(lock) {
            if (running) return
            running = true
            generation += 1
            socketRetryAvailable = true
            generation
        }
        _state.value = AidenSimulatorStreamState()
        decodeJob = scope.launch(decodeDispatcher) {
            pendingJpeg.filterNotNull().collect { jpeg ->
                val decoded = runCatching { decodeFrame(jpeg) }.getOrNull() ?: return@collect
                if (isCurrent(runGeneration)) _frame.value = decoded
            }
        }
        streamJob = scope.launch(ioDispatcher) { runStream(runGeneration) }
    }

    /** Closes the MJPEG request and the input socket. The last frame stays visible. */
    fun stop() {
        val call: Call?
        val ws: WebSocket?
        synchronized(lock) {
            if (!running) return
            running = false
            generation += 1
            call = streamCall
            ws = socket
            streamCall = null
            socket = null
        }
        call?.cancel()
        ws?.close(NORMAL_CLOSURE, null)
        streamJob?.cancel()
        decodeJob?.cancel()
        retryJob?.cancel()
        streamJob = null
        decodeJob = null
        retryJob = null
        pendingJpeg.value = null
        _state.update { it.copy(inputConnected = false) }
    }

    /** Sends one input message when the socket is connected; returns whether it was sent. */
    fun send(message: ByteArray): Boolean {
        val ws = synchronized(lock) { socket.takeIf { _state.value.inputConnected } } ?: return false
        return ws.send(message.toByteString())
    }

    private fun isCurrent(runGeneration: Long) = synchronized(lock) { running && generation == runGeneration }

    private suspend fun runStream(runGeneration: Long) {
        var streamRetryAvailable = true
        while (isCurrent(runGeneration)) {
            firstFrameAt = 0L
            val failure = try {
                readStream(runGeneration)
                AidenSimulatorStreamFailure.NETWORK
            } catch (error: CancellationException) {
                throw error
            } catch (error: StreamRefused) {
                error.failure
            } catch (_: Exception) {
                AidenSimulatorStreamFailure.NETWORK
            }
            if (!isCurrent(runGeneration)) return
            // A stream that delivered frames for a while earns a fresh retry; one that
            // drops straight after connecting keeps its spent budget and gives up.
            val streamingSince = firstFrameAt
            if (streamingSince > 0 && clock() - streamingSince >= STABLE_SOCKET_MILLIS) streamRetryAvailable = true
            if (failure == AidenSimulatorStreamFailure.NETWORK && streamRetryAvailable) {
                streamRetryAvailable = false
                _state.update { it.copy(phase = AidenSimulatorStreamPhase.CONNECTING) }
                delay(retryDelayMillis)
                continue
            }
            fail(runGeneration, failure)
            return
        }
    }

    private fun readStream(runGeneration: Long) {
        val call = httpClient.newCall(mjpegRequest)
        synchronized(lock) {
            if (!running || generation != runGeneration) return
            streamCall = call
        }
        call.execute().use { response ->
            if (!response.isSuccessful) throw StreamRefused(failureFor(response.code))
            val body = response.body ?: throw IOException("Empty MJPEG body")
            val parser = AidenMjpegParser(AidenMjpegParser.boundaryFrom(response.header("Content-Type")))
            // Screen capture now runs, so the helper will accept input.
            connectInput(runGeneration)
            val source = body.source()
            val chunk = ByteArray(READ_CHUNK_BYTES)
            while (isCurrent(runGeneration)) {
                val read = source.read(chunk)
                if (read < 0) break
                val frames = parser.feed(chunk, 0, read)
                if (frames.isNotEmpty()) {
                    if (firstFrameAt == 0L) firstFrameAt = clock()
                    pendingJpeg.value = frames.last()
                    if (_state.value.phase != AidenSimulatorStreamPhase.STREAMING) {
                        _state.update { it.copy(phase = AidenSimulatorStreamPhase.STREAMING, failure = null) }
                    }
                }
            }
        }
    }

    private fun connectInput(runGeneration: Long) {
        synchronized(lock) {
            if (!running || generation != runGeneration || socket != null) return
            socket = httpClient.newWebSocket(inputRequest, InputListener(runGeneration))
        }
    }

    private inner class InputListener(private val runGeneration: Long) : WebSocketListener() {
        private fun owns(webSocket: WebSocket) =
            synchronized(lock) { running && generation == runGeneration && socket === webSocket }

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (!owns(webSocket)) {
                webSocket.close(NORMAL_CLOSURE, null)
                return
            }
            synchronized(lock) { socketOpenedAt = clock() }
            webSocket.send(AidenSimulatorInput.hardwareKeyboard(false).toByteString())
            _state.update { it.copy(inputConnected = true) }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (!owns(webSocket)) return
            // 0x90 control replies and anything unknown are ignored here.
            val screen = AidenSimulatorInput.decodeScreenConfig(bytes.toByteArray()) ?: return
            _state.update { it.copy(screen = screen) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(NORMAL_CLOSURE, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            socketEnded(webSocket, if (code in REFUSAL_CLOSE_CODES) AidenSimulatorStreamFailure.REFUSED else null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            // Only a refused credential or grant is final; anything else may retry once.
            val refused = response?.code?.let { failureFor(it) }?.takeIf { it == AidenSimulatorStreamFailure.REFUSED }
            socketEnded(webSocket, refused)
        }

        private fun socketEnded(webSocket: WebSocket, refusal: AidenSimulatorStreamFailure?) {
            val retry: Boolean
            synchronized(lock) {
                if (socket !== webSocket) return
                socket = null
                if (!running || generation != runGeneration) return
                // A socket that stayed up for a while earns a fresh retry.
                if (socketOpenedAt > 0 && clock() - socketOpenedAt >= STABLE_SOCKET_MILLIS) socketRetryAvailable = true
                socketOpenedAt = 0
                retry = refusal == null && socketRetryAvailable
                if (retry) socketRetryAvailable = false
            }
            _state.update { it.copy(inputConnected = false) }
            if (refusal != null) {
                fail(runGeneration, refusal)
                return
            }
            if (!retry) return
            retryJob = scope.launch(ioDispatcher) {
                delay(retryDelayMillis)
                connectInput(runGeneration)
            }
        }
    }

    private fun fail(runGeneration: Long, failure: AidenSimulatorStreamFailure) {
        val call: Call?
        val ws: WebSocket?
        synchronized(lock) {
            if (!running || generation != runGeneration) return
            running = false
            generation += 1
            call = streamCall
            ws = socket
            streamCall = null
            socket = null
        }
        call?.cancel()
        ws?.close(NORMAL_CLOSURE, null)
        decodeJob?.cancel()
        retryJob?.cancel()
        _state.update {
            it.copy(phase = AidenSimulatorStreamPhase.FAILED, inputConnected = false, failure = failure)
        }
    }

    private class StreamRefused(val failure: AidenSimulatorStreamFailure) : IOException(failure.name)

    companion object {
        const val RETRY_DELAY_MILLIS = 1_000L
        private const val STABLE_SOCKET_MILLIS = 5_000L
        private const val READ_CHUNK_BYTES = 16 * 1024
        private const val NORMAL_CLOSURE = 1000
        /** Policy violation, Aiden's unauthorized close, and the browser's failed-upgrade code. */
        val REFUSAL_CLOSE_CODES = setOf(1006, 1008, 4401)

        fun failureFor(statusCode: Int): AidenSimulatorStreamFailure = when (statusCode) {
            401, 403 -> AidenSimulatorStreamFailure.REFUSED
            404 -> AidenSimulatorStreamFailure.NOT_FOUND
            429 -> AidenSimulatorStreamFailure.CAPACITY
            else -> AidenSimulatorStreamFailure.NETWORK
        }
    }
}
