package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.config.AidenThemeCatalog
import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID

class AidenDynamicColorTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    // A wallpaper-derived scheme with distinct, recognisable tones per role.
    private val light = lightColorScheme(
        primary = Color(0xFF3A5F8A),
        surface = Color(0xFFF9F9FF),
        surfaceContainerLowest = Color(0xFFFFFFFF),
        surfaceContainer = Color(0xFFEDEDF4),
        onSurface = Color(0xFF191C20),
        onSurfaceVariant = Color(0xFF43474E),
        error = Color(0xFFBA1A1A)
    )
    private val dark = darkColorScheme(
        primary = Color(0xFFA4C9FE),
        surface = Color(0xFF111318),
        surfaceContainerLow = Color(0xFF191C20),
        surfaceContainer = Color(0xFF1D2024),
        onSurface = Color(0xFFE2E2E9),
        onSurfaceVariant = Color(0xFFC4C6CF),
        error = Color(0xFFFFB4AB)
    )

    @Test
    fun wallpaperSchemeDrivesEveryPaletteSlotTheAppPaintsWith() {
        val palette = aidenDynamicPalette(light, isDark = false)

        assertEquals(light.surface, palette.canvas)
        assertEquals(light.surfaceContainer, palette.sidebar)
        assertEquals(light.surfaceContainerLowest, palette.raised)
        assertEquals(light.onSurface, palette.foreground)
        assertEquals(light.onSurfaceVariant, palette.secondary)
        assertEquals(light.primary, palette.accent)
        assertEquals(light.error, palette.danger)
        // The derived palette feeds the same Material role mapping as the built-in themes.
        assertEquals(light.primary, aidenColorScheme(palette, isDark = false).primary)
    }

    @Test
    fun darkSchemeStepsUpFromTheCanvasLikeAidensOwnDarkPalettes() {
        val palette = aidenDynamicPalette(dark, isDark = true)

        assertEquals(dark.surface, palette.canvas)
        assertEquals(dark.surfaceContainerLow, palette.sidebar)
        assertEquals(dark.surfaceContainer, palette.raised)
        assertTrue(AidenPalette.contrastRatio(palette.foreground, palette.canvas) >= 4.5f)
    }

    @Test
    fun successAndWarningKeepAidensSemanticColorsBecauseMaterialHasNoSuchRoles() {
        val aidenDark = AidenThemeCatalog.palette(AidenThemePresetID.AIDEN, true)
        val palette = aidenDynamicPalette(dark, isDark = true)

        assertEquals(aidenDark.success, palette.success)
        assertEquals(aidenDark.warning, palette.warning)
    }

    @Test
    fun dynamicColorIsOfferedOnlyFromAndroid12() {
        assertFalse(AidenThemePresetID.DYNAMIC in AidenThemePresetID.available(30))
        assertTrue(AidenThemePresetID.DYNAMIC in AidenThemePresetID.available(31))
        assertEquals(AidenThemePresetID.entries.size - 1, AidenThemePresetID.available(26).size)
    }

    @Test
    fun theDynamicPresetPersistsAcrossLaunches() {
        AidenAppearanceStore(tempFolder.root).updatePreset(AidenThemePresetID.DYNAMIC)

        assertEquals(AidenThemePresetID.DYNAMIC, AidenAppearanceStore(tempFolder.root).config.value.preset)
    }

    @Test
    fun belowAndroid12TheDynamicPresetFallsBackToTheAidenPalette() {
        assertEquals(
            AidenThemeCatalog.palette(AidenThemePresetID.AIDEN, false),
            AidenThemeCatalog.palette(AidenThemePresetID.DYNAMIC, false)
        )
    }
}
