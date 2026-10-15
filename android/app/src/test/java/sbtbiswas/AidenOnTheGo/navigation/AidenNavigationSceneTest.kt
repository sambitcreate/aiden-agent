package sbtbiswas.AidenOnTheGo.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.navigation.AidenNavigationScene.ListDetail
import sbtbiswas.AidenOnTheGo.navigation.AidenNavigationScene.Single
import sbtbiswas.AidenOnTheGo.ui.theme.AidenWindowWidthClass.Compact
import sbtbiswas.AidenOnTheGo.ui.theme.AidenWindowWidthClass.Expanded
import sbtbiswas.AidenOnTheGo.ui.theme.AidenWindowWidthClass.Medium

class AidenNavigationSceneTest {
    private val root = AidenNavigationStack.Root
    private val chat = AidenScreen.ChatDetail("c1")

    @Test
    fun phonesAndMediumWindowsShowTheTopScreenAlone() {
        val stack = root.push(chat)
        for (width in listOf(Compact, Medium)) {
            assertEquals(Single(chat), aidenNavigationScene(stack, width))
            assertEquals(Single(AidenScreen.ProductShell), aidenNavigationScene(root, width))
        }
    }

    @Test
    fun expandedWindowsPutTheShellBesideItsChats() {
        assertEquals("no chat open yet", ListDetail(null), aidenNavigationScene(root, Expanded))
        assertEquals(ListDetail(chat), aidenNavigationScene(root.push(chat), Expanded))

        val forked = root.push(chat).push(AidenScreen.ChatDetail("c2"))
        assertEquals(
            "a chat opened from a chat stays in the detail pane",
            ListDetail(AidenScreen.ChatDetail("c2")),
            aidenNavigationScene(forked, Expanded)
        )
    }

    @Test
    fun anyOtherScreenCoversTheWholeExpandedWindow() {
        val bot = AidenScreen.BotProfile("b1")
        assertEquals(Single(bot), aidenNavigationScene(root.push(chat).push(bot), Expanded))
        assertEquals(Single(chat), aidenNavigationScene(root.push(bot).push(chat), Expanded))
        assertEquals(Single(AidenScreen.Settings()), aidenNavigationScene(root.push(AidenScreen.Settings()), Expanded))
    }

    @Test
    fun poppingAChatKeepsTheListDetailLayoutSoBackStaysInsideThePane() {
        val forked = root.push(chat).push(AidenScreen.ChatDetail("c2"))
        val before = aidenNavigationScene(forked, Expanded)
        val after = aidenNavigationScene(forked.pop()!!, Expanded)
        assertEquals(before.key, after.key)
        assertEquals(ListDetail(chat), after)
        assertEquals(before.key, aidenNavigationScene(forked.pop()!!.pop()!!, Expanded).key)
    }

    @Test
    fun onlyTheChatOpenedFromTheShellHidesItsUpArrow() {
        val forked = root.push(chat).push(AidenScreen.ChatDetail("c2"))
        assertTrue(forked.opensFromShell(chat))
        assertFalse(forked.opensFromShell(AidenScreen.ChatDetail("c2")))
        assertFalse(root.opensFromShell(AidenScreen.ProductShell))
    }
}
