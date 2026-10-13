package sbtbiswas.AidenOnTheGo.features.chat

/**
 * Seals the settled front of a streaming reply into stable chunks so only the
 * active tail re-renders per tick. A chunk ends only where Markdown cannot
 * carry state across the seam (after a closed code fence, a blank line, a
 * heading or a thematic break), and only once it is at least
 * [STABLE_CHUNK_TARGET_UTF8_BYTES] long, so short replies stay one document.
 *
 * The chunks plus the tail always reproduce the reply exactly, and a growing
 * reply keeps every chunk it already sealed, with the same id and text.
 */
object AidenStreamingMarkdownSplitter {
    /** Measured in UTF-8 bytes, so the threshold matches the iOS splitter. */
    const val STABLE_CHUNK_TARGET_UTF8_BYTES = 6_000

    /** How a sealed chunk ends, which decides the gap before the next one. */
    enum class Seam { BLANK_LINE, CODE_FENCE, SINGLE_LINE_BLOCK }

    data class Chunk(
        /** Sequential from 0, stable while the reply only grows. */
        val id: Int,
        /** Offset of the chunk's first character in the reply. */
        val start: Int,
        val text: String,
        val seam: Seam
    )

    data class Segments(val stableChunks: List<Chunk>, val activeMarkdown: String)

    fun split(text: String): Segments {
        var lineStart = 0
        var chunkStart = 0
        var chunkBytes = 0
        var openFence: FenceRun? = null
        val stableChunks = mutableListOf<Chunk>()

        while (lineStart < text.length) {
            val lineEnd = lineEnd(text, lineStart)
            val hasLineBreak = lineEnd < text.length
            val nextLineStart = if (hasLineBreak) lineEnd + 1 else text.length
            chunkBytes += utf8Length(text, lineStart, nextLineStart)
            val trimmed = text.substring(lineStart, lineEnd).trim()

            var seam: Seam? = null
            val fence = openFence
            if (fence != null) {
                if (fence.isClosedBy(trimmed)) {
                    openFence = null
                    seam = Seam.CODE_FENCE
                }
            } else {
                val opening = FenceRun.opening(trimmed)
                if (opening != null) {
                    openFence = opening
                } else if (hasLineBreak) {
                    if (trimmed.isEmpty()) {
                        seam = Seam.BLANK_LINE
                    } else if (isStableSingleLineBlock(trimmed)) {
                        seam = Seam.SINGLE_LINE_BLOCK
                    }
                }
            }

            if (seam != null && nextLineStart < text.length && chunkBytes >= STABLE_CHUNK_TARGET_UTF8_BYTES) {
                val chunkText = text.substring(chunkStart, nextLineStart)
                if (chunkText.isNotBlank()) {
                    stableChunks += Chunk(stableChunks.size, chunkStart, chunkText, seam)
                }
                chunkStart = nextLineStart
                chunkBytes = 0
            }

            lineStart = nextLineStart
        }

        return Segments(stableChunks, text.substring(chunkStart))
    }

    /** The `\n` ending the line that starts at [start]; a `\r\n` pair does not end a line. */
    private fun lineEnd(text: String, start: Int): Int {
        var searchStart = start
        while (true) {
            val newline = text.indexOf('\n', searchStart)
            if (newline < 0) return text.length
            if (newline == start || text[newline - 1] != '\r') return newline
            searchStart = newline + 1
        }
    }

    private fun utf8Length(text: String, start: Int, end: Int): Int {
        var bytes = 0
        var index = start
        while (index < end) {
            val char = text[index]
            bytes += when {
                char.code < 0x80 -> 1
                char.code < 0x800 -> 2
                // A surrogate pair is one 4-byte scalar; each half counts 2.
                Character.isSurrogate(char) -> 2
                else -> 3
            }
            index++
        }
        return bytes
    }

    private fun isStableSingleLineBlock(trimmed: String): Boolean {
        val headingMarkers = trimmed.takeWhile { it == '#' }.length
        val isHeading = headingMarkers in 1..6 && trimmed.getOrNull(headingMarkers)?.isWhitespace() == true
        return isHeading || trimmed == "---" || trimmed == "***"
    }

    /**
     * The opening run of a fenced code block. Per CommonMark only a line of
     * the same character, at least as long, with no info string closes it, so
     * a ```` fence can hold ``` lines and a ~~~ fence can hold ``` lines.
     */
    private class FenceRun(val character: Char, val length: Int) {
        fun isClosedBy(trimmed: String): Boolean {
            val run = trimmed.takeWhile { it == character }.length
            return run >= length && run == trimmed.length
        }

        companion object {
            fun opening(trimmed: String): FenceRun? {
                val first = trimmed.firstOrNull() ?: return null
                if (first != '`' && first != '~') return null
                val length = trimmed.takeWhile { it == first }.length
                return if (length >= 3) FenceRun(first, length) else null
            }
        }
    }
}
