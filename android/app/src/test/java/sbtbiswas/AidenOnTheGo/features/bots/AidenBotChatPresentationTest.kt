package sbtbiswas.AidenOnTheGo.features.bots

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.config.AidenThemeCatalog
import sbtbiswas.AidenOnTheGo.models.AidenStreamInputMode
import sbtbiswas.AidenOnTheGo.ui.theme.aidenColorScheme

/** How the Bot chat draws what isn't in the Mac's transcript yet, and how a working Bot's face says so. */
class AidenBotChatPresentationTest {
    @Test
    fun onlyMessagesStillWaitingForTheReplyAreFadedAndEachSaysWhy() {
        assertEquals(AidenBotPendingBubble(true, AidenBotPendingCaption.SENDING), aidenBotOutgoingBubble(AidenBotOutgoingLook.Sending))
        assertEquals(
            AidenBotPendingBubble(true, AidenBotPendingCaption.QUEUED),
            aidenBotOutgoingBubble(AidenBotOutgoingLook.Queued(AidenStreamInputMode.QUEUE))
        )
        // A steer has joined the reply: it reads like any sent message, with no caption.
        assertEquals(
            AidenBotPendingBubble(false, null),
            aidenBotOutgoingBubble(AidenBotOutgoingLook.Queued(AidenStreamInputMode.STEER))
        )
        assertEquals(AidenBotPendingBubble(false, null), aidenBotOutgoingBubble(AidenBotOutgoingLook.Sent))
        assertEquals(AidenBotPendingBubble(false, AidenBotPendingCaption.FAILED), aidenBotOutgoingBubble(AidenBotOutgoingLook.Failed))
    }

    @Test
    fun aWaitingBubbleLooksDifferentFromASentOneAndKeepsItsWordsReadableInEveryTheme() {
        AidenThemeCatalog.palettes.forEach { (preset, palettes) ->
            palettes.forEachIndexed { index, palette ->
                val scheme = aidenColorScheme(palette, isDark = index == 1)
                val waiting = aidenBotUserBubbleColors(scheme, faded = true)
                val sent = aidenBotUserBubbleColors(scheme, faded = false)
                val name = "$preset ${if (index == 1) "dark" else "light"}"
                assertNotEquals("$name: a waiting bubble must not look sent", sent.container, waiting.container)
                // Opaque, so the contrast holds whatever the bubble sits on.
                assertEquals("$name: never dimmed with alpha", 1f, waiting.container.alpha)
                assertEquals(1f, waiting.content.alpha)
                val ratio = AidenPalette.contrastRatio(waiting.content, waiting.container)
                assertTrue("$name: waiting text contrast $ratio is below 4.5:1", ratio >= 4.5f)
            }
        }
    }

    @Test
    fun theBusyModeKeepsThePersonsPickWhileTheBotWorksAndIsQueueAgainAfter() {
        assertEquals(AidenStreamInputMode.STEER, aidenBotBusyMode(AidenStreamInputMode.STEER, isRunning = true))
        assertEquals(AidenStreamInputMode.QUEUE, aidenBotBusyMode(AidenStreamInputMode.STEER, isRunning = false))
        assertEquals(AidenStreamInputMode.QUEUE, aidenBotBusyMode(AidenStreamInputMode.QUEUE, isRunning = false))
    }

    @Test
    fun aWorkingBotAlwaysShowsItAndOnlyMovesWhenMotionIsAllowedAndTheAppIsInFront() {
        fun motion(photo: Boolean = false, reduce: Boolean = false, saver: Boolean = false, resumed: Boolean = true, working: Boolean = true) =
            aidenBotFaceMotion(working = working, photo = photo, reduceMotion = reduce, powerSave = saver, resumed = resumed)

        // A canonical face glances; nothing else is needed.
        assertEquals(AidenBotFaceMotion(glances = true, badge = false, badgeAnimates = false), motion())
        // R19: a face held still by Reduce Motion or battery saver wears the still glance badge.
        assertEquals(AidenBotFaceMotion(glances = false, badge = true, badgeAnimates = false), motion(reduce = true))
        assertEquals(AidenBotFaceMotion(glances = false, badge = true, badgeAnimates = false), motion(saver = true))
        // A photo can't glance: its badge moves, unless motion is off.
        assertEquals(AidenBotFaceMotion(glances = false, badge = true, badgeAnimates = true), motion(photo = true))
        assertEquals(AidenBotFaceMotion(glances = false, badge = true, badgeAnimates = false), motion(photo = true, reduce = true))
        // In the background nothing moves.
        assertFalse(motion(resumed = false).glances)
        assertFalse(motion(photo = true, resumed = false).badgeAnimates)
        // An idle Bot shows nothing.
        assertEquals(AidenBotFaceMotion(glances = false, badge = false, badgeAnimates = false), motion(working = false, reduce = true))
    }
}
