package sbtbiswas.AidenOnTheGo.networking

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** The shared `mobileSimulators` fixture in protocol/aiden-remote/v1/fixtures/contract.json. */
internal object AidenMobileSimulatorsFixture {
    val section: JsonObject by lazy {
        val text = javaClass.classLoader!!.getResourceAsStream("contract.json")!!.bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject.getValue("mobileSimulators").jsonObject
    }

    fun bytes(base64: String): ByteArray = Base64.getDecoder().decode(base64)

    fun mjpeg(key: String): ByteArray = bytes(section.getValue("mjpeg").jsonObject.getValue(key).jsonPrimitive.content)

    fun mjpegFrames(key: String): List<ByteArray> =
        section.getValue("mjpeg").jsonObject.getValue(key).jsonArray.map { bytes(it.jsonPrimitive.content) }
}

class AidenSimulatorStreamTest {
    private val fixture = AidenMobileSimulatorsFixture

    private fun assertFrames(expected: List<ByteArray>, actual: List<ByteArray>) {
        assertEquals("frame count", expected.size, actual.size)
        expected.zip(actual).forEachIndexed { index, (want, got) -> assertArrayEquals("frame $index", want, got) }
    }

    private fun parseWhole(stream: ByteArray, parser: AidenMjpegParser = AidenMjpegParser()) = parser.feed(stream)

    private fun parseBytewise(stream: ByteArray): List<ByteArray> {
        val parser = AidenMjpegParser()
        return stream.indices.flatMap { parser.feed(stream, it, 1) }
    }

    // --- MJPEG ---

    @Test
    fun lengthedStreamYieldsExactlyTheFixtureFramesHoweverItIsChunked() {
        val stream = fixture.mjpeg("streamBase64")
        val expected = fixture.mjpegFrames("framesBase64")
        assertFrames(expected, parseWhole(stream))
        assertFrames(expected, parseBytewise(stream))
        for (split in 0..stream.size) {
            val parser = AidenMjpegParser()
            val frames = parser.feed(stream.copyOfRange(0, split)) + parser.feed(stream.copyOfRange(split, stream.size))
            assertFrames(expected, frames)
        }
    }

    @Test
    fun contentLengthWinsOverBoundaryBytesInsideTheJpeg() {
        val second = fixture.mjpegFrames("framesBase64")[1]
        // The fixture's second JPEG embeds "\r\n--frame"; a boundary scan would cut it short.
        assertTrue(String(second, Charsets.ISO_8859_1).contains("\r\n--frame"))
        assertArrayEquals(second, parseWhole(fixture.mjpeg("streamBase64"))[1])
    }

    @Test
    fun unlengthedStreamFallsBackToTheBoundaryScanHoweverItIsChunked() {
        val stream = fixture.mjpeg("unlengthedStreamBase64")
        val expected = fixture.mjpegFrames("unlengthedFramesBase64")
        assertFrames(expected, parseWhole(stream))
        assertFrames(expected, parseBytewise(stream))
        for (split in 0..stream.size) {
            val parser = AidenMjpegParser()
            val frames = parser.feed(stream.copyOfRange(0, split)) + parser.feed(stream.copyOfRange(split, stream.size))
            assertFrames(expected, frames)
        }
    }

    @Test
    fun aPartialFrameAtTheEndIsNeverEmitted() {
        val lengthed = fixture.mjpeg("streamBase64")
        val firstFrame = fixture.mjpegFrames("framesBase64").first()
        // Cut inside the second JPEG body (its last 4 bytes are the JPEG end and the CRLF).
        assertFrames(listOf(firstFrame), parseWhole(lengthed.copyOfRange(0, lengthed.size - 4)))

        val unlengthed = fixture.mjpeg("unlengthedStreamBase64")
        val firstUnlengthed = fixture.mjpegFrames("unlengthedFramesBase64").first()
        // Without the closing delimiter the second body has no known end yet.
        val withoutTrailer = unlengthed.copyOfRange(0, unlengthed.size - "\r\n--frame\r\n".length)
        assertFrames(listOf(firstUnlengthed), parseWhole(withoutTrailer))
    }

    @Test
    fun anOversizePartFailsTheStreamInsteadOfGrowingTheBuffer() {
        assertThrows(AidenSimulatorStreamException::class.java) {
            parseWhole(fixture.mjpeg("streamBase64"), AidenMjpegParser(maximumPartBytes = 8))
        }
        val endless = "--frame\r\nContent-Type: image/jpeg\r\n\r\n".toByteArray() + ByteArray(64) { 0x11 }
        assertThrows(AidenSimulatorStreamException::class.java) {
            AidenMjpegParser(maximumPartBytes = 32).feed(endless)
        }
    }

    @Test
    fun theBoundaryComesFromTheContentTypeHeader() {
        assertEquals("frame", AidenMjpegParser.boundaryFrom(fixture.section.getValue("mjpeg").jsonObject.getValue("contentType").jsonPrimitive.content))
        assertEquals("frame", AidenMjpegParser.boundaryFrom(null))
        assertEquals("frame", AidenMjpegParser.boundaryFrom("multipart/x-mixed-replace"))
        assertEquals("sim-42", AidenMjpegParser.boundaryFrom("multipart/x-mixed-replace;boundary=\"--sim-42\""))

        val custom = "--sim-42\r\nContent-Length: 3\r\n\r\nabc\r\n--sim-42\r\n\r\nxy--frame\r\n--sim-42\r\n".toByteArray()
        val frames = AidenMjpegParser(AidenMjpegParser.boundaryFrom("multipart/x-mixed-replace; boundary=sim-42")).feed(custom)
        assertEquals(listOf("abc", "xy--frame"), frames.map { String(it) })
    }

    // --- Input messages ---

    private fun screen(value: JsonObject?): AidenSimulatorScreen? = value?.let {
        AidenSimulatorScreen(
            width = it.getValue("width").jsonPrimitive.int,
            height = it.getValue("height").jsonPrimitive.int,
            orientation = AidenSimulatorOrientation.fromWire(it.getValue("orientation").jsonPrimitive.content)!!
        )
    }

    @Test
    fun everyFixtureInputVectorEncodesToItsTagAndPayload() {
        val vectors = fixture.section.getValue("inputMessages").jsonArray.map { it.jsonObject }
        assertTrue(vectors.size >= 10)
        for (vector in vectors) {
            val command = vector.getValue("command").jsonObject
            val screen = (vector["screen"] as? JsonObject).let(::screen)
            val message = when (val kind = command.getValue("kind").jsonPrimitive.content) {
                "hardwareKeyboard" -> AidenSimulatorInput.hardwareKeyboard(command.getValue("enabled").jsonPrimitive.boolean)
                "touch" -> AidenSimulatorInput.touch(
                    AidenSimulatorTouchPhase.entries.single { it.wireValue == command.getValue("phase").jsonPrimitive.content },
                    command.getValue("x").jsonPrimitive.double,
                    command.getValue("y").jsonPrimitive.double,
                    screen
                )
                "button" -> AidenSimulatorInput.button(
                    when (command.getValue("button").jsonPrimitive.content) {
                        "home" -> AidenSimulatorButton.HOME
                        "lock" -> AidenSimulatorButton.LOCK
                        "appSwitcher" -> AidenSimulatorButton.APP_SWITCHER
                        else -> error("unknown button")
                    }
                )
                "rotate" -> AidenSimulatorInput.rotate(screen)
                else -> error("unknown command $kind")
            }
            assertEquals("tag for $command", vector.getValue("tag").jsonPrimitive.int, message[0].toInt() and 0xFF)
            val payload = Json.parseToJsonElement(String(message, 1, message.size - 1, Charsets.UTF_8)).jsonObject
            assertEquals("payload for $command on $screen", vector.getValue("payload").jsonObject, payload)
        }
    }

    @Test
    fun everyFixtureScreenConfigDecodesOrIsRejected() {
        val vectors = fixture.section.getValue("screenConfigs").jsonArray.map { it.jsonObject }
        for (vector in vectors) {
            val body = vector.getValue("payload").toString().toByteArray(Charsets.UTF_8)
            val message = byteArrayOf(vector.getValue("tag").jsonPrimitive.int.toByte()) + body
            val expected = vector.getValue("screen").let { if (it is JsonNull) null else screen(it.jsonObject) }
            assertEquals("screen for $vector", expected, AidenSimulatorInput.decodeScreenConfig(message))
        }
        assertNull(AidenSimulatorInput.decodeScreenConfig(byteArrayOf()))
        assertNull(AidenSimulatorInput.decodeScreenConfig(byteArrayOf(0x82.toByte()) + "not json".toByteArray()))
        assertNull(AidenSimulatorInput.decodeScreenConfig(byteArrayOf(0x82.toByte()) + """{"width":"1206","height":2622,"orientation":"portrait"}""".toByteArray()))
    }
}
