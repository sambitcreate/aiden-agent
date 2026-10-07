package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.animation.core.SnapSpec
import androidx.compose.animation.core.SpringSpec
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.config.AidenThemeCatalog
import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID

class AidenExpressiveFoundationTest {
    private val density = Density(1f)
    private val size = Size(200f, 100f)

    private fun CornerSize.px() = toPx(size, density)

    @Test
    fun connectedGroupRoundsOnlyTheOutsideCornersOfTheFirstAndLastItems() {
        val first = aidenGroupItemShape(0, 3)
        val middle = aidenGroupItemShape(1, 3)
        val last = aidenGroupItemShape(2, 3)

        assertEquals(20f, first.topStart.px())
        assertEquals(20f, first.topEnd.px())
        assertEquals(6f, first.bottomStart.px())
        assertEquals(6f, middle.topStart.px())
        assertEquals(6f, middle.bottomEnd.px())
        assertEquals(6f, last.topEnd.px())
        assertEquals(20f, last.bottomStart.px())
        assertEquals(20f, last.bottomEnd.px())
    }

    @Test
    fun aSingleGroupItemIsFullyRounded() {
        val only = aidenGroupItemShape(0, 1)
        listOf(only.topStart, only.topEnd, only.bottomStart, only.bottomEnd).forEach {
            assertEquals(20f, it.px())
        }
    }

    @Test
    fun horizontalGroupsSeamOnTheLeftAndRightEdges() {
        val leading = aidenGroupItemShape(0, 2, outer = 16.dp, inner = 4.dp, orientation = AidenGroupOrientation.HORIZONTAL)
        val trailing = aidenGroupItemShape(1, 2, outer = 16.dp, inner = 4.dp, orientation = AidenGroupOrientation.HORIZONTAL)

        assertEquals(16f, leading.topStart.px())
        assertEquals(16f, leading.bottomStart.px())
        assertEquals(4f, leading.topEnd.px())
        assertEquals(4f, trailing.bottomStart.px())
        assertEquals(16f, trailing.topEnd.px())
    }

    @Test(expected = IllegalArgumentException::class)
    fun groupShapeRejectsAnIndexOutsideTheGroup() {
        aidenGroupItemShape(3, 3)
    }

    @Test
    fun lightModeContainerTiersDeepenAndStayVisibleOnRaisedCards() {
        AidenThemePresetID.entries.forEach { preset ->
            val palette = AidenThemeCatalog.palette(preset, isDark = false)
            val tones = aidenTonalSurfaces(palette, isDark = false)

            assertTrue("$preset high must be darker than low", tones.high.luminance() < tones.low.luminance())
            assertTrue("$preset highest must be darker than high", tones.highest.luminance() < tones.high.luminance())
            assertTrue(
                "$preset highest must separate from raised cards",
                contrast(tones.highest, palette.raised) >= 1.1f
            )
        }
    }

    @Test
    fun darkModeContainerTiersLiftAboveRaisedCards() {
        AidenThemePresetID.entries.forEach { preset ->
            val palette = AidenThemeCatalog.palette(preset, isDark = true)
            val tones = aidenTonalSurfaces(palette, isDark = true)

            assertTrue(tones.container.luminance() > palette.raised.luminance())
            assertTrue(tones.high.luminance() > tones.container.luminance())
            assertTrue(tones.highest.luminance() > tones.high.luminance())
        }
    }

    @Test
    fun reducedMotionCollapsesEverySpringToAnInstantChange() {
        assertTrue(AidenMotion.spatial<Float>(reduceMotion = true) is SnapSpec)
        assertTrue(AidenMotion.nonSpatial<Float>(reduceMotion = true) is SnapSpec)
        assertTrue(AidenMotion.snappy<Float>(reduceMotion = true) is SnapSpec)
        assertTrue(AidenMotion.bouncy<Float>(reduceMotion = true) is SnapSpec)

        assertTrue(AidenMotion.spatial<Float>(reduceMotion = false) is SpringSpec)
        assertTrue(AidenMotion.bouncy<Float>(reduceMotion = false) is SpringSpec)
    }

    @Test
    fun pressCompressionHoldsFullScaleWhenMotionIsReduced() {
        assertEquals(0.96f, AidenMotion.pressedScale(pressed = true, reduceMotion = false))
        assertEquals(1f, AidenMotion.pressedScale(pressed = true, reduceMotion = true))
        assertEquals(1f, AidenMotion.pressedScale(pressed = false, reduceMotion = false))
    }

    @Test
    fun exponentialScrimStartsTransparentAndEndsAtTheFullColor() {
        val color = Color.Black.copy(alpha = 0.8f)
        val stops = exponentialScrimColors(color, decay = 1.8f, numStops = 16)

        assertEquals(0f, stops.first().alpha, 0.001f)
        assertEquals(0.8f, stops.last().alpha, 0.001f)
        // The curve stays below a linear ramp so the scrim eases in instead of banding.
        assertTrue(stops[8].alpha < 0.8f * 8f / 15f)
        assertEquals(stops.reversed(), exponentialScrimColors(color, 1.8f, 16, ascending = false))
    }

    @Test
    fun typographyKeepsTighterTrackingOnLargerRoles() {
        val type = aidenTypography(scale = 1f)

        assertTrue(type.displayLarge.letterSpacing.value < type.headlineLarge.letterSpacing.value)
        assertTrue(type.headlineLarge.letterSpacing.value < type.bodyLarge.letterSpacing.value)
        assertTrue(type.bodyLarge.lineHeight.value > type.bodyLarge.fontSize.value)
        val scaled = aidenTypography(scale = 1.2f)
        assertEquals(type.bodyLarge.fontSize.value * 1.2f, scaled.bodyLarge.fontSize.value, 0.01f)
    }

    @Test
    fun typographyLeavesColorToContainers() {
        val type = aidenTypography(scale = 1f)
        listOf(type.bodyLarge, type.bodySmall, type.labelLarge, type.titleSmall, type.labelSmall).forEach {
            assertEquals(Color.Unspecified, it.color)
        }
    }

    @Test
    fun everyThemeKeepsReadableTextOnAccentAndVisibleBoundaries() {
        for (preset in AidenThemePresetID.entries) {
            for (dark in listOf(false, true)) {
                val palette = AidenThemeCatalog.palette(preset, dark)
                val scheme = aidenColorScheme(palette, dark)
                val label = "${preset.name} dark=$dark"
                assertTrue("$label onPrimary", contrast(scheme.primary, scheme.onPrimary) >= 4.5f)
                assertTrue("$label onError", contrast(scheme.error, scheme.onError) >= 3f)
                listOf(scheme.primaryContainer, scheme.secondaryContainer, scheme.errorContainer, scheme.outline, scheme.outlineVariant)
                    .forEach { assertEquals("$label opaque role", 1f, it.alpha, 0.001f) }
                // Unchecked switches draw their thumb in `outline`; it must stand off the track.
                assertTrue("$label outline", contrast(scheme.outline, scheme.surfaceContainerHighest) >= 1.8f)
                assertTrue("$label container text", contrast(scheme.primaryContainer, scheme.onPrimaryContainer) >= 4.5f)
            }
        }
    }

    private fun contrast(a: Color, b: Color): Float {
        val la = a.luminance() + 0.05f
        val lb = b.luminance() + 0.05f
        return maxOf(la, lb) / minOf(la, lb)
    }
}
