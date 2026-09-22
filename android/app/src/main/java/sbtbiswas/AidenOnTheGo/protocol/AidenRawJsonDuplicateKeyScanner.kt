package sbtbiswas.AidenOnTheGo.protocol

class AidenRawJsonDuplicateKeyScanner(private val bytes: ByteArray) {
    private var offset = 0
    private var totalObjectKeys = 0

    companion object {
        fun validate(bytes: ByteArray) {
            val scanner = AidenRawJsonDuplicateKeyScanner(bytes)
            scanner.parseDocument()
        }

        fun validate(jsonString: String) {
            validate(jsonString.toByteArray(Charsets.UTF_8))
        }
    }

    private data class RawKey(val scalars: List<Int>, val displayValue: String)

    private fun parseDocument() {
        parseValue(0)
        skipWhitespace()
        if (offset != bytes.size) {
            throw AidenRemoteContractException.InvalidJson("Unexpected trailing content")
        }
    }

    private fun parseValue(depth: Int) {
        if (depth > AidenRemoteProtocol.MAX_JSON_NESTING_DEPTH) {
            throw AidenRemoteContractException.PayloadTooLarge
        }
        skipWhitespace()
        val byte = peek() ?: throw AidenRemoteContractException.InvalidJson("Unexpected EOF")
        when (byte) {
            '{'.code.toByte() -> parseObject(depth)
            '['.code.toByte() -> parseArray(depth)
            '"'.code.toByte() -> parseString()
            't'.code.toByte() -> parseLiteral("true".toByteArray(Charsets.UTF_8))
            'f'.code.toByte() -> parseLiteral("false".toByteArray(Charsets.UTF_8))
            'n'.code.toByte() -> parseLiteral("null".toByteArray(Charsets.UTF_8))
            '-'.code.toByte(), in '0'.code.toByte()..'9'.code.toByte() -> parseNumber()
            else -> throw AidenRemoteContractException.InvalidJson("Unexpected token: ${byte.toInt().toChar()}")
        }
    }

    private fun parseObject(depth: Int) {
        consume('{'.code.toByte())
        skipWhitespace()
        val keys = mutableSetOf<RawKey>()
        if (consumeIf('}'.code.toByte())) return

        while (true) {
            skipWhitespace()
            if (peek() != '"'.code.toByte()) throw AidenRemoteContractException.InvalidJson("Expected object key string")
            val key = parseString()
            totalObjectKeys++
            if (totalObjectKeys > AidenRemoteProtocol.MAX_JSON_TOTAL_OBJECT_KEYS) {
                throw AidenRemoteContractException.PayloadTooLarge
            }
            if (!keys.add(key)) {
                throw AidenRemoteContractException.DuplicateJsonKey(key.displayValue)
            }
            if (AidenRemoteProtocol.FORBIDDEN_WIRE_KEYS.contains(key.displayValue)) {
                throw AidenRemoteContractException.UnsafePayloadField(key.displayValue)
            }
            skipWhitespace()
            consume(':'.code.toByte())
            parseValue(depth + 1)
            skipWhitespace()
            if (consumeIf(','.code.toByte())) continue
            consume('}'.code.toByte())
            return
        }
    }

    private fun parseArray(depth: Int) {
        consume('['.code.toByte())
        skipWhitespace()
        if (consumeIf(']'.code.toByte())) return

        while (true) {
            parseValue(depth + 1)
            skipWhitespace()
            if (consumeIf(','.code.toByte())) continue
            consume(']'.code.toByte())
            return
        }
    }

    private fun parseLiteral(literal: ByteArray) {
        if (bytes.size - offset < literal.size) {
            throw AidenRemoteContractException.InvalidJson("Unexpected EOF reading literal")
        }
        for (i in literal.indices) {
            if (bytes[offset + i] != literal[i]) {
                throw AidenRemoteContractException.InvalidJson("Invalid literal match")
            }
        }
        offset += literal.size
    }

    private fun parseNumber() {
        consumeIf('-'.code.toByte())
        if (consumeIf('0'.code.toByte())) {
            val next = peek()
            if (next != null && next in '0'.code.toByte()..'9'.code.toByte()) {
                throw AidenRemoteContractException.InvalidJson("Leading zeroes in number")
            }
        } else {
            val first = peek()
            if (first == null || first !in '1'.code.toByte()..'9'.code.toByte()) {
                throw AidenRemoteContractException.InvalidJson("Invalid number start")
            }
            offset++
            while (true) {
                val next = peek() ?: break
                if (next in '0'.code.toByte()..'9'.code.toByte()) offset++ else break
            }
        }

        if (consumeIf('.'.code.toByte())) {
            val first = peek()
            if (first == null || first !in '0'.code.toByte()..'9'.code.toByte()) {
                throw AidenRemoteContractException.InvalidJson("Invalid fraction in number")
            }
            offset++
            while (true) {
                val next = peek() ?: break
                if (next in '0'.code.toByte()..'9'.code.toByte()) offset++ else break
            }
        }

        val exp = peek()
        if (exp == 'e'.code.toByte() || exp == 'E'.code.toByte()) {
            offset++
            consumeIf('+'.code.toByte())
            consumeIf('-'.code.toByte())
            val first = peek()
            if (first == null || first !in '0'.code.toByte()..'9'.code.toByte()) {
                throw AidenRemoteContractException.InvalidJson("Invalid exponent in number")
            }
            offset++
            while (true) {
                val next = peek() ?: break
                if (next in '0'.code.toByte()..'9'.code.toByte()) offset++ else break
            }
        }
    }

    private fun parseString(): RawKey {
        consume('"'.code.toByte())
        val scalars = mutableListOf<Int>()
        val sb = StringBuilder()

        while (offset < bytes.size) {
            val byte = bytes[offset++]
            when (byte) {
                '"'.code.toByte() -> return RawKey(scalars, sb.toString())
                '\\'.code.toByte() -> {
                    if (offset >= bytes.size) throw AidenRemoteContractException.InvalidJson("Unterminated escape")
                    val escape = bytes[offset++]
                    when (escape) {
                        '"'.code.toByte() -> { scalars.add('"'.code); sb.append('"') }
                        '\\'.code.toByte() -> { scalars.add('\\'.code); sb.append('\\') }
                        '/'.code.toByte() -> { scalars.add('/'.code); sb.append('/') }
                        'b'.code.toByte() -> { scalars.add(0x08); sb.append('\b') }
                        'f'.code.toByte() -> { scalars.add(0x0C); sb.append('\u000C') }
                        'n'.code.toByte() -> { scalars.add(0x0A); sb.append('\n') }
                        'r'.code.toByte() -> { scalars.add(0x0D); sb.append('\r') }
                        't'.code.toByte() -> { scalars.add(0x09); sb.append('\t') }
                        'u'.code.toByte() -> {
                            val first = readHexQuad()
                            if (first in 0xD800..0xDBFF) {
                                if (!consumeIf('\\'.code.toByte()) || !consumeIf('u'.code.toByte())) {
                                    throw AidenRemoteContractException.InvalidJson("Expected low surrogate")
                                }
                                val second = readHexQuad()
                                if (second !in 0xDC00..0xDFFF) {
                                    throw AidenRemoteContractException.InvalidJson("Invalid low surrogate")
                                }
                                val codePoint = 0x10000 + ((first - 0xD800) shl 10) + (second - 0xDC00)
                                scalars.add(codePoint)
                                sb.append(String(Character.toChars(codePoint)))
                            } else if (first in 0xDC00..0xDFFF) {
                                throw AidenRemoteContractException.InvalidJson("Unpaired low surrogate")
                            } else {
                                scalars.add(first)
                                sb.append(first.toChar())
                            }
                        }
                        else -> throw AidenRemoteContractException.InvalidJson("Unknown escape: ${escape.toInt().toChar()}")
                    }
                }
                else -> {
                    val unsigned = byte.toInt() and 0xFF
                    if (unsigned < 0x20) throw AidenRemoteContractException.InvalidJson("Unescaped control char in string")
                    if (unsigned < 0x80) {
                        scalars.add(unsigned)
                        sb.append(unsigned.toChar())
                    } else {
                        // Multi-byte UTF-8
                        offset-- // backtrack this byte to decode
                        val start = offset
                        val codePoint = readUtf8CodePoint()
                        scalars.add(codePoint)
                        sb.append(String(Character.toChars(codePoint)))
                    }
                }
            }
        }
        throw AidenRemoteContractException.InvalidJson("Unterminated string")
    }

    private fun readUtf8CodePoint(): Int {
        val b1 = (bytes[offset++].toInt() and 0xFF)
        return when {
            b1 and 0xE0 == 0xC0 -> {
                val b2 = (bytes[offset++].toInt() and 0xFF)
                ((b1 and 0x1F) shl 6) or (b2 and 0x3F)
            }
            b1 and 0xF0 == 0xE0 -> {
                val b2 = (bytes[offset++].toInt() and 0xFF)
                val b3 = (bytes[offset++].toInt() and 0xFF)
                ((b1 and 0x0F) shl 12) or ((b2 and 0x3F) shl 6) or (b3 and 0x3F)
            }
            b1 and 0xF8 == 0xF0 -> {
                val b2 = (bytes[offset++].toInt() and 0xFF)
                val b3 = (bytes[offset++].toInt() and 0xFF)
                val b4 = (bytes[offset++].toInt() and 0xFF)
                ((b1 and 0x07) shl 18) or ((b2 and 0x3F) shl 12) or ((b3 and 0x3F) shl 6) or (b4 and 0x3F)
            }
            else -> b1
        }
    }

    private fun readHexQuad(): Int {
        if (bytes.size - offset < 4) throw AidenRemoteContractException.InvalidJson("Incomplete hex escape")
        var value = 0
        for (i in 0 until 4) {
            val digit = hexValue(bytes[offset++]) ?: throw AidenRemoteContractException.InvalidJson("Invalid hex digit")
            value = (value shl 4) or digit
        }
        return value
    }

    private fun hexValue(byte: Byte): Int? {
        val b = byte.toInt() and 0xFF
        return when (b) {
            in '0'.code..'9'.code -> b - '0'.code
            in 'a'.code..'f'.code -> b - 'a'.code + 10
            in 'A'.code..'F'.code -> b - 'A'.code + 10
            else -> null
        }
    }

    private fun peek(): Byte? = if (offset < bytes.size) bytes[offset] else null

    private fun consume(expected: Byte) {
        if (!consumeIf(expected)) throw AidenRemoteContractException.InvalidJson("Expected byte: ${expected.toInt().toChar()}")
    }

    private fun consumeIf(expected: Byte): Boolean {
        if (peek() == expected) {
            offset++
            return true
        }
        return false
    }

    private fun skipWhitespace() {
        while (offset < bytes.size) {
            val b = bytes[offset]
            if (b == ' '.code.toByte() || b == '\t'.code.toByte() || b == '\n'.code.toByte() || b == '\r'.code.toByte()) {
                offset++
            } else {
                break
            }
        }
    }
}
