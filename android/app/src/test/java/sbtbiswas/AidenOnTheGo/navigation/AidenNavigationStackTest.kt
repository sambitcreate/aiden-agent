package sbtbiswas.AidenOnTheGo.navigation

import androidx.compose.runtime.saveable.SaverScope
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AidenNavigationStackTest {
    private val root = AidenNavigationStack.Root

    @Test
    fun backReturnsToTheScreenThatOpenedTheCurrentOne() {
        val stack = root
            .push(AidenScreen.BotProfile("bot-1"))
            .push(AidenScreen.ChatDetail("chat-1"))

        val afterBack = stack.pop()!!
        assertEquals(AidenScreen.BotProfile("bot-1"), afterBack.current)
        assertEquals(AidenScreen.ProductShell, afterBack.pop()!!.current)
        assertNull("the root falls through so the system can close the app", afterBack.pop()!!.pop())
        assertFalse(root.canPop)
    }

    @Test
    fun reopeningTheCurrentScreenOrTheShellDoesNotGrowTheStack() {
        val chat = root.push(AidenScreen.ChatDetail("chat-1"))
        assertEquals(chat, chat.push(AidenScreen.ChatDetail("chat-1")))
        assertEquals(root, chat.push(AidenScreen.BotProfile("b")).push(AidenScreen.ProductShell))
    }

    @Test
    fun depthIsCappedWhileTheShellStaysAtTheRoot() {
        var stack = root
        repeat(40) { stack = stack.push(AidenScreen.ChatDetail("chat-$it")) }

        assertEquals(AidenNavigationStack.MAX_DEPTH, stack.depth)
        assertEquals(AidenScreen.ProductShell, stack.entries.first())
        assertEquals(AidenScreen.ChatDetail("chat-39"), stack.current)
        assertEquals(AidenScreen.ChatDetail("chat-38"), stack.pop()!!.current)
    }

    @Test
    fun voiceLaunchIsNotReplayedWhenReturningToAChat() {
        val stack = root
            .push(AidenScreen.ChatDetail("chat-1", startsVoice = true))
            .push(AidenScreen.BotProfile("bot-1"))

        assertEquals(AidenScreen.ChatDetail("chat-1", startsVoice = false), stack.pop()!!.current)
    }

    @Test
    fun savedBotEditReturnsToTheProfileThatOpenedTheEditor() {
        val fromProfile = root.push(AidenScreen.BotProfile("bot-1")).push(AidenScreen.BotEditor("bot-1"))
        assertEquals(root.push(AidenScreen.BotProfile("bot-1")), fromProfile.completeBotEdit("bot-1"))

        val created = root.push(AidenScreen.BotEditor(null)).completeBotEdit("bot-new")
        assertEquals(root.push(AidenScreen.BotProfile("bot-new")), created)
        assertEquals(root, created.pop())
    }

    @Test
    fun deepLinksStartAFreshPathFromTheShell() {
        val deep = root.push(AidenScreen.BotProfile("b")).push(AidenScreen.ChatDetail("c"))
        val linked = deep.resetTo(AidenScreen.WorkspaceGit("w"))
        assertEquals(listOf(AidenScreen.ProductShell, AidenScreen.WorkspaceGit("w")), linked.entries)
    }

    @Test
    fun savedStateRestoresTheWholeStackWithoutReplayingVoice() {
        val stack = root
            .push(AidenScreen.WorkspaceFiles("ws|with|pipes"))
            .push(AidenScreen.BotEditor(null))
            .push(AidenScreen.BotEditor("bot-1"))
            .push(AidenScreen.WorkspaceGit("ws-2"))
            .push(AidenScreen.ChatDetail("chat-1", startsVoice = true))

        val saved = with(AidenNavigationStack.Saver) { SaverScope { true }.save(stack) }!!
        val restored = AidenNavigationStack.Saver.restore(saved)!!

        assertEquals(stack.entries.dropLast(1), restored.entries.dropLast(1))
        assertEquals(AidenScreen.ChatDetail("chat-1", startsVoice = false), restored.current)
    }

    @Test
    fun settingsAndPairingPagesSurviveSavedStateRestore() {
        val stack = root
            .push(AidenScreen.Settings())
            .push(AidenScreen.Settings(AidenSettingsPage.PROVIDERS))
            .push(AidenScreen.Settings(AidenSettingsPage.ADD_PROVIDER))
            .push(AidenScreen.Installations)
            .push(AidenScreen.PairDesktop)

        val saved = with(AidenNavigationStack.Saver) { SaverScope { true }.save(stack) }!!
        val restored = AidenNavigationStack.Saver.restore(saved)!!

        assertEquals(stack, restored)
        assertEquals(AidenScreen.Installations, restored.pop()!!.current)
        // Every page has its own identity, so each keeps its own saved scroll and form state.
        assertEquals(stack.entries.size, stack.entries.map { it.stateKey }.toSet().size)
    }

    @Test
    fun unknownSettingsPagesAreDroppedOnRestore() {
        val restored = AidenNavigationStack.decode(listOf("settings", "settings|retired-page", "settings|voice"))
        assertEquals(root.push(AidenScreen.Settings()).push(AidenScreen.Settings(AidenSettingsPage.VOICE)), restored)
    }

    @Test
    fun corruptSavedEntriesAreDroppedRatherThanCrashingRestore() {
        val restored = AidenNavigationStack.decode(listOf("chat|", "mystery|x", "shell", "bot|b1"))
        assertEquals(root.push(AidenScreen.BotProfile("b1")), restored)
        assertEquals(root, AidenNavigationStack.decode(emptyList()))
    }

    @Test
    fun backDetectionAndDiscardedStateFollowTheStackChange() {
        val chat = root.push(AidenScreen.ChatDetail("c", startsVoice = true))
        val profile = chat.push(AidenScreen.BotProfile("b"))

        assertFalse(profile.isBackFrom(chat))
        assertTrue(profile.pop()!!.isBackFrom(profile))
        assertTrue(root.isBackFrom(profile))
        assertFalse("a deep link to a sibling is not a pop", chat.resetTo(AidenScreen.BotProfile("x")).isBackFrom(profile))

        // Pushing over a voice-launched chat must keep that chat's saved UI state.
        assertTrue(profile.discardedFrom(chat).isEmpty())
        assertEquals(listOf(AidenScreen.BotProfile("b")), profile.pop()!!.discardedFrom(profile))
    }

    @Test
    fun predictiveBackRoundsAndLiftsTheRecedingScreenWithTheGesture() {
        val rest = predictiveBackDepth(0f, reduceMotion = false)
        val half = predictiveBackDepth(0.5f, reduceMotion = false)
        val full = predictiveBackDepth(1f, reduceMotion = false)

        assertEquals(AidenPredictiveBackDepth(1f, 0.dp, 0.dp), rest)
        assertTrue(half.scale < 1f && full.scale < half.scale)
        assertEquals(14.dp, half.cornerRadius)
        assertEquals(28.dp, full.cornerRadius)
        assertEquals(16.dp, full.shadowElevation)
        assertEquals("progress past the gesture end is clamped", full, predictiveBackDepth(1.4f, reduceMotion = false))
    }

    @Test
    fun predictiveBackHoldsTheScreenStillWhenMotionIsReduced() {
        assertEquals(AidenPredictiveBackDepth(1f, 0.dp, 0.dp), predictiveBackDepth(0.7f, reduceMotion = true))
    }
}
