package sbtbiswas.AidenOnTheGo.features.chat

/**
 * The line a collapsed, still-thinking reasoning card shows: the latest sentence or
 * line the model has finished, with Markdown markers removed. Unfinished text is left
 * out, so the row changes once per finished thought instead of per token. Mirrors the
 * desktop's `latestReasoningLine`.
 */
object AidenReasoningLine {
    private val sentenceEnd = setOf('.', '!', '?', '…')
    private val closers = setOf('"', '\'', ')', ']', '”', '’')
    private val leadingMarker = Regex("""^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)""")
    private val inlineMarker = Regex("""\*\*|__|`""")
    private val whitespaceRun = Regex("""\s+""")

    fun latest(text: String): String {
        var end = lastUnitEnd(text, text.length)
        while (end >= 0) {
            val start = lastUnitEnd(text, end) + 1
            val line = clean(text.substring(start, end))
            if (line.isNotEmpty()) return line
            end = start - 1
        }
        return ""
    }

    /**
     * The index of the whitespace that ends the last finished unit before [before], or -1.
     * A unit ends at a line break, or at sentence punctuation (and any closing quotes)
     * that whitespace already follows.
     */
    private fun lastUnitEnd(text: String, before: Int): Int {
        for (index in before - 1 downTo 0) {
            val char = text[index]
            if (char == '\n') return index
            if (!char.isWhitespace()) continue
            var mark = index - 1
            while (mark >= 0 && text[mark] in closers) mark -= 1
            if (mark >= 0 && text[mark] in sentenceEnd) return index
        }
        return -1
    }

    private fun clean(line: String): String = line
        .replaceFirst(leadingMarker, "")
        .replace(inlineMarker, "")
        .replace(whitespaceRun, " ")
        .trim()
}
