package sbtbiswas.AidenOnTheGo.navigation

import androidx.compose.runtime.Immutable
import sbtbiswas.AidenOnTheGo.ui.theme.AidenWindowWidthClass

/**
 * How the back stack is laid out in the window. Each scene is one slot of the host's
 * screen transition, identified by [key]; changes within a scene (a different chat in
 * the detail pane) animate inside it instead of replacing it.
 */
@Immutable
sealed interface AidenNavigationScene {
    val key: String

    /** Saved-state keys of the screens this scene composes. */
    val screenKeys: Set<String>

    /** One screen fills the window. */
    data class Single(val screen: AidenScreen) : AidenNavigationScene {
        override val key: String get() = screen.stateKey
        override val screenKeys: Set<String> get() = setOf(screen.stateKey)
    }

    /**
     * The product shell as a list pane beside a detail pane holding [detail], or a
     * placeholder while no chat is open.
     */
    data class ListDetail(val detail: AidenScreen.ChatDetail?) : AidenNavigationScene {
        override val key: String get() = KEY
        override val screenKeys: Set<String>
            get() = setOfNotNull(AidenScreen.ProductShell.stateKey, detail?.stateKey)

        companion object {
            const val KEY = "list-detail"
        }
    }
}

/**
 * Picks the layout for [stack] in a window of [widthClass]. Expanded windows show the
 * shell beside the chat it opened (and any chats opened from that chat, which stack
 * inside the detail pane so back walks through them there). Every other stack, and
 * every stack on compact and medium windows, shows its top screen alone.
 */
fun aidenNavigationScene(stack: AidenNavigationStack, widthClass: AidenWindowWidthClass): AidenNavigationScene {
    val above = stack.entries.drop(1)
    if (widthClass == AidenWindowWidthClass.Expanded && above.all { it is AidenScreen.ChatDetail }) {
        return AidenNavigationScene.ListDetail(above.lastOrNull() as AidenScreen.ChatDetail?)
    }
    return AidenNavigationScene.Single(stack.current)
}

/** Whether [screen] sits directly on the shell, so a list pane beside it already leads back. */
fun AidenNavigationStack.opensFromShell(screen: AidenScreen): Boolean =
    entries.getOrNull(1)?.stateKey == screen.stateKey
