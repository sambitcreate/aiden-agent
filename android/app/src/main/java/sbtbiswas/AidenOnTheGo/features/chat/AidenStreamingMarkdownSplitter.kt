package sbtbiswas.AidenOnTheGo.features.chat

/**
 * Seals the settled front of a streaming reply into stable chunks so only the
 * active tail re-renders per tick. A chunk ends only where Markdown cannot
 * carry state across the seam (after a closed code block, a blank line, a
 * heading or a thematic break), and only once it is at least
 * [STABLE_CHUNK_TARGET_UTF8_BYTES] long, so short replies stay one document.
 *
 * Code blocks pair their ``` runs exactly as the message renderer does (each
 * run toggles a block, wherever it sits on the line), so a chunk never splits
 * a block the finished message would show whole.
 *
 * The chunks plus the tail always reproduce the reply exactly, and a growing
 * reply keeps every chunk it already sealed, with the same id and text.
 */
object AidenStreamingMarkdownSplitter {
    /** Measured in UTF-8 bytes, so the threshold matches the iOS splitter. */
    const val STABLE_CHUNK_TARGET_UTF8_BYTES = 6_000

    /** How a sealed chunk ends. */
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

    fun split(text: String): Segments = Session().split(text)

    /**
     * Splits one growing reply tick after tick. Each call scans only the text
     * after the last sealed chunk, since a seal always leaves no code block
     * open; a reply that is not a continuation of the previous one starts over.
     */
    class Session {
        private var source = ""
        private var sealedEnd = 0
        private val chunks = ArrayList<Chunk>()

        fun split(text: String): Segments {
            if (sealedEnd > text.length || !text.regionMatches(0, source, 0, sealedEnd)) {
                chunks.clear()
                sealedEnd = 0
            }
            source = text
            sealedEnd = sealFrom(text, sealedEnd, chunks)
            return Segments(chunks.toList(), text.substring(sealedEnd))
        }
    }

    /** Seals chunks from [from], which must not be inside a code block, and returns where the tail starts. */
    private fun sealFrom(text: String, from: Int, stableChunks: MutableList<Chunk>): Int {
        var lineStart = from
        var chunkStart = from
        var chunkBytes = 0
        var inCodeBlock = false
        var fenceSearchFrom = from

        while (lineStart < text.length) {
            val lineEnd = lineEnd(text, lineStart)
            val hasLineBreak = lineEnd < text.length
            val nextLineStart = if (hasLineBreak) lineEnd + 1 else text.length
            chunkBytes += utf8Length(text, lineStart, nextLineStart)

            var fenceRuns = 0
            var searchFrom = maxOf(lineStart, fenceSearchFrom)
            while (true) {
                val run = fenceRunIndex(text, searchFrom, lineEnd)
                if (run < 0) break
                inCodeBlock = !inCodeBlock
                fenceRuns++
                searchFrom = run + FENCE.length
            }
            fenceSearchFrom = searchFrom

            val seam = when {
                inCodeBlock -> null
                fenceRuns > 0 -> Seam.CODE_FENCE
                !hasLineBreak -> null
                text.substring(lineStart, lineEnd).isBlank() -> Seam.BLANK_LINE
                isStableSingleLineBlock(text.substring(lineStart, lineEnd).trim()) -> Seam.SINGLE_LINE_BLOCK
                else -> null
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

        return chunkStart
    }

    private const val FENCE = "```"

    /** The first ``` run starting in [from, end) that also ends by [end], or -1. */
    private fun fenceRunIndex(text: String, from: Int, end: Int): Int {
        var index = from
        while (index + FENCE.length <= end) {
            if (text[index] == '`' && text[index + 1] == '`' && text[index + 2] == '`') return index
            index++
        }
        return -1
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
}
