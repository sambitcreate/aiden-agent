package sbtbiswas.AidenOnTheGo.navigation

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.saveable.Saver

/** Pages inside Settings. [token] is the saved-state spelling and must stay stable. */
enum class AidenSettingsPage(val token: String) {
    ROOT("root"),
    APPEARANCE("appearance"),
    VOICE("voice"),
    PROVIDERS("providers"),
    ADD_PROVIDER("add-provider"),
    ABOUT("about");

    companion object {
        fun fromToken(token: String): AidenSettingsPage? = entries.firstOrNull { it.token == token }
    }
}

@Immutable
sealed class AidenScreen {
    data object ProductShell : AidenScreen()
    data class ChatDetail(val chatId: String, val startsVoice: Boolean = false) : AidenScreen()
    data class BotProfile(val botId: String) : AidenScreen()
    data class BotEditor(val botId: String?) : AidenScreen()
    data class WorkspaceFiles(val workspaceId: String) : AidenScreen()
    data class WorkspaceGit(val workspaceId: String) : AidenScreen()
    data class Settings(val page: AidenSettingsPage = AidenSettingsPage.ROOT) : AidenScreen()
    data object Installations : AidenScreen()
    data object PairDesktop : AidenScreen()

    /**
     * Stable identity for saved per-entry UI state. Voice start is a one-shot
     * launch request, not part of the destination, so it is excluded.
     */
    val stateKey: String get() = encode(this)

    internal companion object {
        private const val SEPARATOR = '|'

        fun encode(screen: AidenScreen): String = when (screen) {
            ProductShell -> "shell"
            is ChatDetail -> "chat$SEPARATOR${screen.chatId}"
            is BotProfile -> "bot$SEPARATOR${screen.botId}"
            is BotEditor -> screen.botId?.let { "bot-edit$SEPARATOR$it" } ?: "bot-new"
            is WorkspaceFiles -> "files$SEPARATOR${screen.workspaceId}"
            is WorkspaceGit -> "git$SEPARATOR${screen.workspaceId}"
            is Settings -> if (screen.page == AidenSettingsPage.ROOT) "settings" else "settings$SEPARATOR${screen.page.token}"
            Installations -> "installations"
            PairDesktop -> "pair"
        }

        fun decode(token: String): AidenScreen? {
            val kind = token.substringBefore(SEPARATOR)
            val id = token.substringAfter(SEPARATOR, missingDelimiterValue = "")
            return when {
                kind == "shell" -> ProductShell
                kind == "bot-new" -> BotEditor(null)
                kind == "settings" && id.isEmpty() -> Settings()
                kind == "installations" -> Installations
                kind == "pair" -> PairDesktop
                id.isEmpty() -> null
                kind == "chat" -> ChatDetail(id)
                kind == "bot" -> BotProfile(id)
                kind == "bot-edit" -> BotEditor(id)
                kind == "files" -> WorkspaceFiles(id)
                kind == "git" -> WorkspaceGit(id)
                kind == "settings" -> AidenSettingsPage.fromToken(id)?.let(::Settings)
                else -> null
            }
        }
    }
}

/**
 * The Activity's back stack. The product shell is always the root, so system
 * back at the root leaves the app while every pushed screen pops to the screen
 * that opened it instead of jumping straight to the shell.
 */
@Immutable
class AidenNavigationStack private constructor(val entries: List<AidenScreen>) {
    val current: AidenScreen get() = entries.last()
    val canPop: Boolean get() = entries.size > 1
    val depth: Int get() = entries.size

    fun push(screen: AidenScreen): AidenNavigationStack {
        if (screen == AidenScreen.ProductShell) return Root
        if (screen == current) return this
        // Voice start is a one-shot launch request: returning to a chat later
        // must not start dictation again.
        val next = entries.map { if (it is AidenScreen.ChatDetail && it.startsVoice) it.copy(startsVoice = false) else it } + screen
        // Cap depth so a long chat-to-bot-to-chat chain cannot grow the saved
        // state without bound. The root is always kept.
        return AidenNavigationStack(
            if (next.size <= MAX_DEPTH) next else listOf(AidenScreen.ProductShell) + next.takeLast(MAX_DEPTH - 1)
        )
    }

    /** The stack below the current screen, or null at the root. */
    fun pop(): AidenNavigationStack? = if (canPop) AidenNavigationStack(entries.dropLast(1)) else null

    /** Deep links replace whatever was open with a fresh path from the shell. */
    fun resetTo(screen: AidenScreen): AidenNavigationStack = Root.push(screen)

    /**
     * A saved Bot editor hands off to that Bot's profile. When the editor was
     * opened from the same profile, return to it rather than stacking a copy.
     */
    fun completeBotEdit(botId: String): AidenNavigationStack {
        val profile = AidenScreen.BotProfile(botId)
        if (current !is AidenScreen.BotEditor) return push(profile)
        val below = pop() ?: Root
        return if (below.current == profile) below else below.push(profile)
    }

    /** True when this stack is [previous] with screens popped off its top. */
    fun isBackFrom(previous: AidenNavigationStack): Boolean =
        depth < previous.depth && previous.entries.take(depth).map { it.stateKey } == entries.map { it.stateKey }

    /** Screens of [previous] that no longer appear here, whose saved UI state can be dropped. */
    fun discardedFrom(previous: AidenNavigationStack): List<AidenScreen> {
        val kept = entries.mapTo(HashSet()) { it.stateKey }
        return previous.entries.filter { it.stateKey !in kept }
    }

    /** Saved-state form. Voice launch requests are dropped so recreation never restarts dictation. */
    fun encode(): List<String> = entries.map { AidenScreen.encode(it) }

    override fun equals(other: Any?): Boolean = other is AidenNavigationStack && other.entries == entries
    override fun hashCode(): Int = entries.hashCode()
    override fun toString(): String = "AidenNavigationStack($entries)"

    companion object {
        const val MAX_DEPTH = 16
        val Root = AidenNavigationStack(listOf(AidenScreen.ProductShell))

        fun decode(tokens: List<String>): AidenNavigationStack {
            val screens = tokens.mapNotNull { AidenScreen.decode(it) }.filter { it != AidenScreen.ProductShell }
            return screens.fold(Root) { stack, screen -> stack.push(screen) }
        }

        val Saver: Saver<AidenNavigationStack, ArrayList<String>> = Saver(
            save = { ArrayList(it.encode()) },
            restore = { decode(it) }
        )
    }
}
