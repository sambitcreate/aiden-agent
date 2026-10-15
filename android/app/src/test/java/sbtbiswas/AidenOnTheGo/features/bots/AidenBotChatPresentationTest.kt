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
import sbtbiswas.AidenOnTheGo.ui.theme.aidenFrameDue

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
                val waiting = aidenBotUserBubbleColors(scheme, palette.accentFill, faded = true)
                val sent = aidenBotUserBubbleColors(scheme, palette.accentFill, faded = false)
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
    fun captionsLinksAndErrorTextReadOnEverySurfaceTheyUseInEveryTheme() {
        val failures = mutableListOf<String>()
        AidenThemeCatalog.palettes.forEach { (preset, palettes) ->
            palettes.forEachIndexed { index, palette ->
                val scheme = aidenColorScheme(palette, isDark = index == 1)
                val text = aidenBotChatTextColors(scheme)
                val name = "$preset ${if (index == 1) "dark" else "light"}"
                // Where each is drawn: the chat and screens (the page), sheets, dialogs and menus
                // (raised), and, for an error, its own tint.
                val surfaces = mapOf("page" to scheme.background, "sheet" to palette.raised)
                val inks = mapOf("caption" to text.caption, "Try again" to text.link, "error" to text.error)
                for ((surface, color) in surfaces) {
                    for ((role, ink) in inks) {
                        val ratio = AidenPalette.contrastRatio(ink, color)
                        if (ratio < 4.5f) failures += "$name: $role on $surface is $ratio"
                    }
                }
                for ((surface, color) in mapOf("card" to scheme.surfaceContainer, "error tint" to scheme.errorContainer)) {
                    val ratio = AidenPalette.contrastRatio(text.error, color)
                    if (ratio < 4.5f) failures += "$name: error on $surface is $ratio"
                }
                // Still an error's colour, not the plain text one.
                assertNotEquals("$name: error text keeps its colour", scheme.onSurface, text.error)
                assertEquals(1f, text.error.alpha)
            }
        }
        assertTrue("below 4.5:1:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun theChatFollowsNewRowsOnlyAtItsEndOrAfterTheirOwnSend() {
        assertTrue("at the end", aidenBotFollowsTranscriptEnd(lastVisibleIndex = 9, totalCount = 10, justSent = false))
        assertTrue("a row or two short of it", aidenBotFollowsTranscriptEnd(lastVisibleIndex = 7, totalCount = 10, justSent = false))
        assertFalse("reading back", aidenBotFollowsTranscriptEnd(lastVisibleIndex = 3, totalCount = 10, justSent = false))
        assertTrue("their own message always shows", aidenBotFollowsTranscriptEnd(lastVisibleIndex = 3, totalCount = 10, justSent = true))
    }

    @Test
    fun framesAreCappedAtAboutThirtyASecond() {
        // A 120 Hz display offers a frame every ~8 ms: only one in four or so is drawn.
        var shown = 0L
        var drawn = 0
        for (elapsed in generateSequence(0L) { it + 8 }.takeWhile { it <= 1_000 }) {
            if (aidenFrameDue(shown, elapsed)) {
                shown = elapsed
                drawn += 1
            }
        }
        assertTrue("$drawn frames in a second", drawn in 25..31)
        assertTrue("a restarted clock draws at once", aidenFrameDue(500, 0))
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
