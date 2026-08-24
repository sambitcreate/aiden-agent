package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.config.AidenThemeCatalog
import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID
import sbtbiswas.AidenOnTheGo.features.bots.prototype.AidenBotFirstPrototypeConfiguration
import sbtbiswas.AidenOnTheGo.features.bots.prototype.AidenBotPrototypeFixtures
import sbtbiswas.AidenOnTheGo.features.bots.prototype.AidenBotPrototypeScreen
import sbtbiswas.AidenOnTheGo.features.bots.prototype.AidenBotPrototypeState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import androidx.compose.ui.unit.dp

class AidenBotPrototypeSnapshotTest {
    @Test
    fun testAllPresetThemePalettesAreDefined() {
        assertEquals(4, AidenThemePresetID.values().size)

        for (preset in AidenThemePresetID.values()) {
            val lightPalette = AidenThemeCatalog.palette(preset, false)
            val darkPalette = AidenThemeCatalog.palette(preset, true)

            // Verify Light Palette
            assertTrue(lightPalette.canvasHex.startsWith("#"))
            assertTrue(lightPalette.sidebarHex.startsWith("#"))
            assertTrue(lightPalette.raisedHex.startsWith("#"))
            assertTrue(lightPalette.foregroundHex.startsWith("#"))
            assertTrue(lightPalette.secondaryHex.startsWith("#"))
            assertTrue(lightPalette.accentHex.startsWith("#"))
            assertTrue(lightPalette.successHex.startsWith("#"))
            assertTrue(lightPalette.warningHex.startsWith("#"))
            assertTrue(lightPalette.dangerHex.startsWith("#"))

            assertNotNull(lightPalette.canvas)
            assertNotNull(lightPalette.sidebar)
            assertNotNull(lightPalette.raised)
            assertNotNull(lightPalette.foreground)
            assertNotNull(lightPalette.secondary)
            assertNotNull(lightPalette.accent)
            assertNotNull(lightPalette.success)
            assertNotNull(lightPalette.warning)
            assertNotNull(lightPalette.danger)

            // Verify Dark Palette
            assertTrue(darkPalette.canvasHex.startsWith("#"))
            assertTrue(darkPalette.sidebarHex.startsWith("#"))
            assertTrue(darkPalette.raisedHex.startsWith("#"))
            assertTrue(darkPalette.foregroundHex.startsWith("#"))
            assertTrue(darkPalette.secondaryHex.startsWith("#"))
            assertTrue(darkPalette.accentHex.startsWith("#"))
            assertTrue(darkPalette.successHex.startsWith("#"))
            assertTrue(darkPalette.warningHex.startsWith("#"))
            assertTrue(darkPalette.dangerHex.startsWith("#"))

            assertNotNull(darkPalette.canvas)
            assertNotNull(darkPalette.sidebar)
            assertNotNull(darkPalette.raised)
            assertNotNull(darkPalette.foreground)
            assertNotNull(darkPalette.secondary)
            assertNotNull(darkPalette.accent)
            assertNotNull(darkPalette.success)
            assertNotNull(darkPalette.warning)
            assertNotNull(darkPalette.danger)
        }
    }

    @Test
    fun testContrastCalculationsAndHexMixing() {
        val lightAiden = AidenThemeCatalog.palette(AidenThemePresetID.AIDEN, false)

        // Baseline (50) returns exact same palette
        val baseline = lightAiden.applyingContrast(50)
        assertEquals(lightAiden.secondaryHex, baseline.secondaryHex)

        // Higher contrast (75, 100) shifts secondary towards foreground
        val higherContrast = lightAiden.applyingContrast(75)
        assertNotEquals(lightAiden.secondaryHex, higherContrast.secondaryHex)

        val maxContrast = lightAiden.applyingContrast(100)
        assertNotEquals(higherContrast.secondaryHex, maxContrast.secondaryHex)

        // Lower contrast (25, 0) shifts secondary towards canvas
        val lowerContrast = lightAiden.applyingContrast(25)
        assertNotEquals(lightAiden.secondaryHex, lowerContrast.secondaryHex)

        val minContrast = lightAiden.applyingContrast(0)
        assertNotEquals(lowerContrast.secondaryHex, minContrast.secondaryHex)

        // Hex mixing utility
        val white = "#FFFFFF"
        val black = "#000000"
        val midGrey = AidenPalette.mixHex(white, black, 0.5f)
        assertEquals("#808080", midGrey.uppercase())

        val pureWhite = AidenPalette.mixHex(white, black, 0.0f)
        assertEquals("#FFFFFF", pureWhite.uppercase())

        val pureBlack = AidenPalette.mixHex(white, black, 1.0f)
        assertEquals("#000000", pureBlack.uppercase())
    }

    @Test
    fun testAndroidVisualFoundationContract() {
        val light = AidenThemeCatalog.palette(AidenThemePresetID.AIDEN, false)
        val dark = AidenThemeCatalog.palette(AidenThemePresetID.AIDEN, true)

        assertEquals("#FBFBFA", light.canvasHex)
        assertEquals("#181817", light.foregroundHex)
        assertEquals("#111110", dark.canvasHex)
        assertEquals("#F5F5F3", dark.foregroundHex)

        assertTrue(AidenUi.MinimumTouchTarget >= 48.dp)
        assertEquals(20.dp, AidenUi.ScreenGutter)
        assertEquals(30.dp, AidenUi.ComposerRadius)
    }

    @Test
    fun testPrototypeConfigurationInitialization() {
        val config = AidenBotFirstPrototypeConfiguration(
            theme = AidenThemePresetID.BERRY,
            state = AidenBotPrototypeState.READY,
            screen = AidenBotPrototypeScreen.INBOX,
            noticeAcknowledged = true
        )

        assertEquals(AidenThemePresetID.BERRY, config.theme)
        assertEquals(AidenBotPrototypeState.READY, config.state)
        assertEquals(AidenBotPrototypeScreen.INBOX, config.screen)
        assertTrue(config.noticeAcknowledged)

        val sampleBot = AidenBotPrototypeFixtures.sampleBotSummary()
        assertEquals("bot_sample", sampleBot.id)

        val sampleConversation = AidenBotPrototypeFixtures.sampleConversation()
        assertEquals("chat_sample", sampleConversation.chatId)
    }
}
