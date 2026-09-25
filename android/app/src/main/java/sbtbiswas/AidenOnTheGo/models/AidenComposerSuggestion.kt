package sbtbiswas.AidenOnTheGo.models

/** Slice G composer trigger parsing. The palette tracks only the trailing
 * `/query` or `@query` token: the trigger must start the draft or follow
 * whitespace, and the token ends at the next whitespace. Anything else —
 * triggers inside a token, a completed mention, punctuation — is ordinary
 * text and never opens a palette. */
data class AidenComposerSuggestionQuery(
    val kind: Kind,
    val query: String,
    /** Start index of the trigger character in the draft; the selection
     * replaces `tokenStart..draft.length`. */
    val tokenStart: Int
) {
    enum class Kind { SKILL, MENTION }

    fun matches(candidate: String): Boolean =
        query.isEmpty() || candidate.contains(query, ignoreCase = true)

    /** Prefix matches rank ahead of substring matches, mirroring the desktop
     * palette ordering. */
    fun compare(a: String, b: String): Int {
        val aPrefix = a.startsWith(query, ignoreCase = true)
        val bPrefix = b.startsWith(query, ignoreCase = true)
        if (aPrefix != bPrefix) return if (aPrefix) -1 else 1
        return a.compareTo(b, ignoreCase = true)
    }

    companion object {
        const val MAX_QUERY_CHARACTERS = 256

        fun parse(draft: String): AidenComposerSuggestionQuery? {
            val tokenStart = draft.indexOfLast { it.isWhitespace() } + 1
            if (tokenStart >= draft.length) return null
            val kind = when (draft[tokenStart]) {
                '/' -> Kind.SKILL
                '@' -> Kind.MENTION
                else -> return null
            }
            val query = draft.substring(tokenStart + 1)
            if (query.codePointCount(0, query.length) > MAX_QUERY_CHARACTERS) return null
            return AidenComposerSuggestionQuery(kind = kind, query = query, tokenStart = tokenStart)
        }
    }
}

/** One row in the composer suggestion palette. Skills carry the opaque lease
 * redeemed on turn start; agents and files insert plain display text — the
 * client never resolves or expands them. */
sealed class AidenComposerSuggestion {
    abstract val rowId: String

    data class Skill(val entry: AidenRemoteSkillCatalogEntry) : AidenComposerSuggestion() {
        override val rowId: String get() = "skill-${entry.invocationId}"
    }

    data class Agent(val agent: AidenChatAgent) : AidenComposerSuggestion() {
        override val rowId: String get() = "agent-${agent.agentId}"
    }

    data class File(val entry: AidenWorkspaceFileEntry) : AidenComposerSuggestion() {
        override val rowId: String get() = "file-${entry.id}"
    }

    companion object {
        const val MAX_VISIBLE_ROWS = 100
    }
}
