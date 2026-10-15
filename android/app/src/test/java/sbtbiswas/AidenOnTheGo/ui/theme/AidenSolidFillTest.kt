package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.config.AidenSolidFill
import sbtbiswas.AidenOnTheGo.config.AidenThemeCatalog
import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Labelled solid fills (filled buttons, send/stop, bubbles, FABs, checked controls) must
 * carry readable content in every theme. Contrast and hue are measured here with an
 * independent WCAG 2.x implementation on 8-bit sRGB, not the palette's own helpers.
 */
class AidenSolidFillTest {
    private val fixedPresets = AidenThemePresetID.entries.filterNot { it.isDynamic }

    private fun fills(palette: AidenPalette) = listOf("accent" to palette.accentFill, "danger" to palette.dangerFill)
    private fun base(palette: AidenPalette, role: String) = if (role == "accent") palette.accent else palette.danger

    @Test
    fun everyFixedPresetKeepsFillAndPressedContentAtAaContrast() {
        for (preset in fixedPresets) {
            for (dark in listOf(false, true)) {
                val palette = AidenThemeCatalog.palette(preset, dark)
                for ((role, fill) in fills(palette)) {
                    val label = "$preset dark=$dark $role"
                    assertReadable(label, fill)
                    assertTrue("$label pressed must differ from the fill", hex(fill.pressed) != hex(fill.fill))
                }
            }
        }
    }

    @Test
    fun fillsThatCanReachWhiteWithinTheDeepeningCapCarryWhiteContentAndKeepTheirHue() {
        for (preset in fixedPresets) {
            for (dark in listOf(false, true)) {
                val palette = AidenThemeCatalog.palette(preset, dark)
                for ((role, fill) in fills(palette)) {
                    val raw = base(palette, role)
                    val label = "$preset dark=$dark $role ${hex(raw)} -> ${hex(fill.fill)}"
                    // Independent oracle: the most a fill may deepen is 45% toward black.
                    val deepest = scaled(raw, 0.55)
                    if (contrast(deepest, Color.White) < 4.5) continue // Fallback: covered below.
                    assertEquals("$label content", Color.White, fill.content)
                    assertTrue("$label must not lighten", luminance(fill.fill) <= luminance(raw) + 1e-6)
                    if (contrast(raw, Color.White) >= 4.5) {
                        assertEquals("$label already passes with white, so it stays", hex(raw), hex(fill.fill))
                    }
                    if (saturation(raw) >= 0.15) {
                        assertTrue("$label hue drift", hueDistance(raw, fill.fill) < 3.0)
                    }
                    for ((before, after) in channels(raw).zip(channels(fill.fill))) {
                        assertTrue("$label deepened past 45%", after >= before * 0.55 - 1)
                    }
                }
            }
        }
    }

    @Test
    fun lightAccentAndRedsThatFailWhiteDeepenInsteadOfTakingBlackInk() {
        val aiden = AidenThemeCatalog.palette(AidenThemePresetID.AIDEN, isDark = false)
        // #0B7DE5 reads only ~4.1:1 with white, so it deepens rather than carrying black.
        assertTrue(contrast(aiden.accent, Color.White) < 4.5)
        assertEquals(Color.White, aiden.accentFill.content)
        assertTrue(luminance(aiden.accentFill.fill) < luminance(aiden.accent))
        for (preset in listOf(AidenThemePresetID.MOSS, AidenThemePresetID.PAPER, AidenThemePresetID.CALM, AidenThemePresetID.SLATE, AidenThemePresetID.BERRY)) {
            val palette = AidenThemeCatalog.palette(preset, isDark = false)
            assertTrue("$preset light danger starts below 4.5:1", contrast(palette.danger, Color.White) < 4.5)
            assertEquals("$preset light danger ink", Color.White, palette.dangerFill.content)
        }
    }

    @Test
    fun darkFillsMatchTheDesktopSolidFillsForSharedAndAndroidPalettes() {
        // Values produced by renderer/shared/appearance.ts solidFill() for the same inputs.
        val expected = mapOf(
            Triple(AidenThemePresetID.AIDEN, "accent", true) to "#3A78BA",
            Triple(AidenThemePresetID.AIDEN, "danger", true) to "#C94D47",
            Triple(AidenThemePresetID.BERRY, "accent", true) to "#BE5082",
            Triple(AidenThemePresetID.BERRY, "danger", true) to "#B9575E",
            Triple(AidenThemePresetID.PAPER, "accent", true) to "#897354",
            Triple(AidenThemePresetID.PAPER, "danger", true) to "#BC5656",
            Triple(AidenThemePresetID.MONOCHROME, "accent", true) to "#FFFFFF",
            Triple(AidenThemePresetID.MONOCHROME, "danger", true) to "#D4404E"
        )
        for ((key, hex) in expected) {
            val (preset, role, dark) = key
            val palette = AidenThemeCatalog.palette(preset, dark)
            val fill = if (role == "accent") palette.accentFill else palette.dangerFill
            assertEquals("$preset $role", hex, hex(fill.fill))
        }
    }

    @Test
    fun monochromeDarkAccentStaysWhiteWithBlackContent() {
        val fill = AidenThemeCatalog.palette(AidenThemePresetID.MONOCHROME, isDark = true).accentFill

        assertEquals(Color.White, fill.fill)
        assertEquals(Color.Black, fill.content)
        assertTrue("pressed must visibly darken the white fill", luminance(fill.pressed) < luminance(fill.fill))
        assertTrue(contrast(fill.pressed, fill.content) >= 4.5)
    }

    @Test
    fun monochromeLightBlackAccentPressesTowardWhite() {
        val fill = AidenThemeCatalog.palette(AidenThemePresetID.MONOCHROME, isDark = false).accentFill

        assertEquals(Color.Black, fill.fill)
        assertEquals(Color.White, fill.content)
        assertTrue("pressed must visibly lift the black fill", luminance(fill.pressed) > luminance(fill.fill))
        assertTrue(contrast(fill.pressed, fill.content) >= 4.5)
    }

    @Test
    fun accentInkStaysTheBrightPaletteColorInDarkSchemes() {
        // Text buttons, the caret, radios and progress draw with Material's primary; it must
        // not pick up the deepened fill, which would drop text contrast on the dark canvas.
        for (preset in fixedPresets) {
            val palette = AidenThemeCatalog.palette(preset, isDark = true)
            val scheme = aidenColorScheme(palette, isDark = true)
            assertEquals("$preset primary", hex(palette.accent), hex(scheme.primary))
            assertEquals("$preset error", hex(palette.danger), hex(scheme.error))
            assertTrue(
                "$preset accent ink must read at least as well as the fill on the canvas",
                contrast(scheme.primary, palette.canvas) >= contrast(palette.accentFill.fill, palette.canvas)
            )
        }
    }

    @Test
    fun materialYouAccentAndErrorFollowTheSameRule() {
        val dark = aidenDynamicPalette(
            darkColorScheme(
                primary = Color(0xFFA4C9FE),
                error = Color(0xFFFFB4AB),
                surface = Color(0xFF111318),
                onSurface = Color(0xFFE2E2E9)
            ),
            isDark = true
        )
        for ((role, fill) in fills(dark)) {
            val raw = base(dark, role)
            assertReadable("dynamic dark $role", fill)
            assertEquals("dynamic dark $role content", Color.White, fill.content)
            assertTrue("dynamic dark $role hue", hueDistance(raw, fill.fill) < 3.0)
        }

        val light = aidenDynamicPalette(
            lightColorScheme(primary = Color(0xFF3A5F8A), error = Color(0xFFBA1A1A)),
            isDark = false
        )
        for ((role, fill) in fills(light)) {
            assertReadable("dynamic light $role", fill)
            // Both sample tones already read at 4.5:1 with white, so they stay as they are.
            assertEquals("dynamic light $role keeps color", hex(base(light, role)), hex(fill.fill))
            assertEquals("dynamic light $role content", Color.White, fill.content)
        }
    }

    private fun assertReadable(label: String, fill: AidenSolidFill) {
        val rest = contrast(fill.fill, fill.content)
        val pressed = contrast(fill.pressed, fill.content)
        assertTrue("$label fill ${hex(fill.fill)} on ${hex(fill.content)} = $rest", rest >= 4.5)
        assertTrue("$label pressed ${hex(fill.pressed)} on ${hex(fill.content)} = $pressed", pressed >= 4.5)
    }

    // --- Independent WCAG 2.x and HSL helpers on 8-bit sRGB ---

    private fun channels(color: Color): List<Int> {
        val argb = color.toArgb()
        return listOf((argb shr 16) and 0xFF, (argb shr 8) and 0xFF, argb and 0xFF)
    }

    private fun scaled(color: Color, factor: Double): Color {
        val (r, g, b) = channels(color).map { Math.round(it * factor).toInt() }
        return Color(r, g, b)
    }

    private fun hex(color: Color): String = channels(color).joinToString("", prefix = "#") { "%02X".format(it) }

    private fun luminance(color: Color): Double {
        val (r, g, b) = channels(color).map { value ->
            val c = value / 255.0
            if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    private fun contrast(a: Color, b: Color): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private fun saturation(color: Color): Double {
        val (r, g, b) = channels(color).map { it / 255.0 }
        val hi = maxOf(r, g, b)
        val lo = minOf(r, g, b)
        val l = (hi + lo) / 2
        if (hi == lo) return 0.0
        return (hi - lo) / (1 - abs(2 * l - 1))
    }

    private fun hue(color: Color): Double {
        val (r, g, b) = channels(color).map { it / 255.0 }
        val hi = maxOf(r, g, b)
        val lo = minOf(r, g, b)
        val d = hi - lo
        if (d == 0.0) return 0.0
        val h = when (hi) {
            r -> ((g - b) / d).mod(6.0)
            g -> (b - r) / d + 2
            else -> (r - g) / d + 4
        }
        return h * 60
    }

    private fun hueDistance(a: Color, b: Color): Double {
        val d = abs(hue(a) - hue(b)) % 360
        return min(d, 360 - d)
    }
}
