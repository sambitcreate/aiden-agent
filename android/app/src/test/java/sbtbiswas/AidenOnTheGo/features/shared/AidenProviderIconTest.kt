package sbtbiswas.AidenOnTheGo.features.shared

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.config.AidenThemeCatalog
import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTonalSurfaces

class AidenProviderIconTest {
    private fun contrast(a: Color, b: Color): Float {
        val hi = maxOf(a.luminance(), b.luminance())
        val lo = minOf(a.luminance(), b.luminance())
        return (hi + 0.05f) / (lo + 0.05f)
    }

    private fun monogramFor(slug: String, preset: AidenThemePresetID, isDark: Boolean): AidenMonogramColors {
        val palette = AidenThemeCatalog.palette(preset, isDark)
        return aidenProviderMonogramColors(
            brandFill = aidenProviderBrandFill(slug)!!,
            surface = palette.raised,
            liftedFill = aidenTonalSurfaces(palette, isDark).highest,
            liftedInk = palette.foreground
        )
    }

    @Test
    fun nearBlackBrandBadgesLiftOffEveryDarkCard() {
        AidenThemePresetID.entries.forEach { preset ->
            val raised = AidenThemeCatalog.palette(preset, true).raised
            listOf("xai", "grok", "ollama").forEach { slug ->
                val brand = aidenProviderBrandFill(slug)!!
                val badge = monogramFor(slug, preset, isDark = true)
                assertTrue("$slug on $preset dark should swap", badge.fill != brand)
                assertTrue(
                    "$slug badge on $preset dark must separate from the card more than the brand fill",
                    contrast(badge.fill, raised) > contrast(brand, raised)
                )
            }
        }
    }

    @Test
    fun nearBlackBrandBadgesKeepTheirBrandFillOnLightCards() {
        AidenThemePresetID.entries.forEach { preset ->
            listOf("xai", "ollama").forEach { slug ->
                val badge = monogramFor(slug, preset, isDark = false)
                assertEquals(aidenProviderBrandFill(slug), badge.fill)
                assertEquals(Color.White, badge.ink)
            }
        }
    }

    @Test
    fun monogramInkStaysLegibleOnNearBlackProvidersInBothModes() {
        AidenThemePresetID.entries.forEach { preset ->
            listOf(true, false).forEach { isDark ->
                listOf("xai", "ollama").forEach { slug ->
                    val badge = monogramFor(slug, preset, isDark)
                    assertTrue(
                        "$slug monogram on $preset (dark=$isDark) needs 4.5:1",
                        contrast(badge.ink, badge.fill) >= 4.5f
                    )
                }
            }
        }
    }

    @Test
    fun saturatedBrandFillsAreNeverSwapped() {
        val darkRaised = AidenThemeCatalog.palette(AidenThemePresetID.AIDEN, true).raised
        listOf("openai", "anthropic", "google", "deepseek", "mistral").forEach { slug ->
            assertFalse(slug, aidenMonogramBlendsIntoSurface(aidenProviderBrandFill(slug)!!, darkRaised))
        }
    }

    @Test
    fun unknownProvidersFallBackToTheThemeAccent() {
        assertEquals(null, aidenProviderBrandFill("custom:my-server"))
        assertEquals(null, aidenProviderBrandFill(null))
    }
}
