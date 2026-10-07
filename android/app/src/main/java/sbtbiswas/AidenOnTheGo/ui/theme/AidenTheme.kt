package sbtbiswas.AidenOnTheGo.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import sbtbiswas.AidenOnTheGo.config.*

val LocalAidenPalette = staticCompositionLocalOf {
    AidenThemeCatalog.palette(AidenThemePresetID.AIDEN, false)
}

val LocalAidenAppearanceConfig = staticCompositionLocalOf {
    AidenAppearanceConfig()
}

/**
 * Material 3 corner scale. Screens take radii from `MaterialTheme.shapes` (or the
 * `AidenShape` component tokens built on it) instead of literal `RoundedCornerShape`s.
 */
val AidenShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(28.dp)
)

object AidenTheme {
    val palette: AidenPalette
        @Composable
        @ReadOnlyComposable
        get() = LocalAidenPalette.current

    val config: AidenAppearanceConfig
        @Composable
        @ReadOnlyComposable
        get() = LocalAidenAppearanceConfig.current
}

@Composable
fun AidenTheme(
    config: AidenAppearanceConfig = AidenAppearanceConfig(),
    content: @Composable () -> Unit
) {
    val isDark = when (config.mode) {
        AidenAppearanceMode.SYSTEM -> isSystemInDarkTheme()
        AidenAppearanceMode.LIGHT -> false
        AidenAppearanceMode.DARK -> true
    }

    val basePalette = AidenThemeCatalog.palette(config.preset, isDark)
    val palette = basePalette.applyingContrast(config.contrast)

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window
            if (window != null) {
                window.decorView.setBackgroundColor(palette.canvas.toArgb())

                val insetsController = WindowCompat.getInsetsController(window, view)
                insetsController.isAppearanceLightStatusBars = !isDark
                insetsController.isAppearanceLightNavigationBars = !isDark
            }
        }
    }

    val colorScheme = aidenColorScheme(palette, isDark)

    val typography = aidenTypography(config.fontSize.scaleFactor)

    CompositionLocalProvider(
        LocalAidenPalette provides palette,
        LocalAidenAppearanceConfig provides config
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = typography,
            shapes = AidenShapes
        ) {
            // Typography carries no color, so text and icons outside a Material container
            // read the theme foreground; containers still supply their own content color.
            CompositionLocalProvider(LocalContentColor provides palette.foreground, content = content)
        }
    }
}

/**
 * Maps an Aiden palette onto every Material color role. Container roles are opaque tones
 * composited over the surface they sit on, so pairs such as `primaryContainer` /
 * `onPrimaryContainer` keep their contrast on any background, and `outline` /
 * `outlineVariant` give switches, dividers, and checkboxes a visible boundary.
 */
fun aidenColorScheme(palette: AidenPalette, isDark: Boolean): ColorScheme {
    val tones = aidenTonalSurfaces(palette, isDark)
    val base = palette.sidebar
    fun tint(color: Color, alpha: Float) = color.copy(alpha = alpha).compositeOver(base)
    val primaryContainer = tint(palette.accent, if (isDark) 0.24f else 0.14f)
    val secondary = palette.accent.copy(alpha = 0.72f).compositeOver(palette.secondary)
    val secondaryContainer = tint(palette.accent, if (isDark) 0.18f else 0.10f)
    val tertiaryContainer = tint(palette.success, if (isDark) 0.22f else 0.12f)
    val errorContainer = tint(palette.danger, if (isDark) 0.22f else 0.12f)
    val outline = palette.foreground.copy(alpha = if (isDark) 0.50f else 0.55f).compositeOver(base)
    val outlineVariant = palette.foreground.copy(alpha = if (isDark) 0.16f else 0.12f).compositeOver(base)
    val seed = if (isDark) darkColorScheme() else lightColorScheme()
    return seed.copy(
        primary = palette.accent,
        onPrimary = palette.onAccent,
        primaryContainer = primaryContainer,
        onPrimaryContainer = palette.foreground,
        inversePrimary = palette.accent,
        secondary = secondary,
        onSecondary = AidenPalette.readableOn(secondary),
        secondaryContainer = secondaryContainer,
        onSecondaryContainer = palette.foreground,
        tertiary = palette.success,
        onTertiary = AidenPalette.readableOn(palette.success),
        tertiaryContainer = tertiaryContainer,
        onTertiaryContainer = palette.foreground,
        background = palette.canvas,
        onBackground = palette.foreground,
        surface = palette.sidebar,
        onSurface = palette.foreground,
        // Distinct from every container tier so contentColorFor never maps a container to grey text.
        surfaceVariant = palette.foreground.copy(alpha = if (isDark) 0.10f else 0.07f).compositeOver(base),
        onSurfaceVariant = palette.secondary,
        surfaceTint = palette.accent,
        inverseSurface = palette.foreground,
        inverseOnSurface = palette.canvas,
        error = palette.danger,
        onError = AidenPalette.readableOn(palette.danger),
        errorContainer = errorContainer,
        onErrorContainer = palette.foreground,
        outline = outline,
        outlineVariant = outlineVariant,
        scrim = Color.Black.copy(alpha = 0.32f),
        surfaceBright = if (isDark) tones.highest else palette.raised,
        surfaceContainer = tones.container,
        surfaceContainerHigh = tones.high,
        surfaceContainerHighest = tones.highest,
        surfaceContainerLow = tones.low,
        surfaceContainerLowest = tones.lowest,
        surfaceDim = if (isDark) palette.canvas else tones.high
    )
}

/** The five Material container tiers Aiden derives from a palette. */
data class AidenTonalSurfaces(
    val lowest: Color,
    val low: Color,
    val container: Color,
    val high: Color,
    val highest: Color
)

/**
 * Builds a container hierarchy whose High and Highest tiers stay distinguishable from
 * raised cards in both modes. Dark mode lifts the raised tone with elevation luminosity;
 * light mode deepens the sidebar tone toward the foreground so tonal chips, selected
 * rows, and pressed fills remain visible on white cards.
 */
fun aidenTonalSurfaces(palette: AidenPalette, isDark: Boolean): AidenTonalSurfaces =
    if (isDark) {
        AidenTonalSurfaces(
            lowest = palette.canvas,
            low = palette.sidebar,
            container = palette.raised.withElevationLuminosity(2.dp, true),
            high = palette.raised.withElevationLuminosity(4.dp, true),
            highest = palette.raised.withElevationLuminosity(8.dp, true)
        )
    } else {
        AidenTonalSurfaces(
            lowest = palette.canvas,
            low = palette.sidebar,
            container = palette.raised,
            high = palette.foreground.copy(alpha = 0.045f).compositeOver(palette.sidebar),
            highest = palette.foreground.copy(alpha = 0.085f).compositeOver(palette.sidebar)
        )
    }

/**
 * Aiden's type scale. Display and headline roles use tighter optical tracking; body and
 * label roles open up slightly. Styles carry no color: Material components and
 * `LocalContentColor` decide it, so labels on filled buttons and chips stay readable. Every role trims font padding and centers glyphs inside
 * the line box so icon-and-label rows align on the cap height.
 */
fun aidenTypography(scale: Float): Typography {
    val optical = LineHeightStyle(
        alignment = LineHeightStyle.Alignment.Center,
        trim = LineHeightStyle.Trim.Both
    )
    fun style(
        weight: FontWeight,
        size: Float,
        lineHeight: Float,
        tracking: Double
    ) = TextStyle(
        fontWeight = weight,
        fontSize = (size * scale).sp,
        lineHeight = (lineHeight * scale).sp,
        letterSpacing = tracking.sp,
        lineHeightStyle = optical,
        platformStyle = PlatformTextStyle(includeFontPadding = false)
    )
    return Typography(
        displayLarge = style(FontWeight.SemiBold, 44f, 50f, -0.9),
        displayMedium = style(FontWeight.SemiBold, 36f, 42f, -0.7),
        displaySmall = style(FontWeight.SemiBold, 32f, 38f, -0.6),
        headlineLarge = style(FontWeight.SemiBold, 28f, 34f, -0.45),
        headlineMedium = style(FontWeight.SemiBold, 24f, 30f, -0.25),
        headlineSmall = style(FontWeight.Medium, 20f, 26f, -0.1),
        titleLarge = style(FontWeight.Medium, 20f, 26f, -0.1),
        titleMedium = style(FontWeight.SemiBold, 16f, 22f, 0.1),
        titleSmall = style(FontWeight.Medium, 14f, 20f, 0.1),
        bodyLarge = style(FontWeight.Normal, 16f, 25f, 0.1),
        bodyMedium = style(FontWeight.Normal, 14f, 20f, 0.25),
        bodySmall = style(FontWeight.Normal, 12f, 16f, 0.3),
        labelLarge = style(FontWeight.SemiBold, 14f, 20f, 0.1),
        labelMedium = style(FontWeight.SemiBold, 12f, 16f, 0.4),
        labelSmall = style(FontWeight.Medium, 11f, 14f, 0.5)
    )
}

/**
 * Calculates logarithmic elevation luminosity for OLED dark mode surfaces.
 */
fun Color.withElevationLuminosity(elevation: androidx.compose.ui.unit.Dp, isDark: Boolean): Color {
    if (!isDark || elevation <= 0.dp) return this
    val alpha = ((4.5f * kotlin.math.ln(elevation.value + 1f)) + 2f) / 100f
    return Color.White.copy(alpha = alpha).compositeOver(this)
}

internal fun Color.compositeOver(background: Color): Color {
    val fg = this
    val bg = background
    val a = fg.alpha + bg.alpha * (1f - fg.alpha)
    if (a == 0f) return Color.Transparent
    val r = (fg.red * fg.alpha + bg.red * bg.alpha * (1f - fg.alpha)) / a
    val g = (fg.green * fg.alpha + bg.green * bg.alpha * (1f - fg.alpha)) / a
    val b = (fg.blue * fg.alpha + bg.blue * bg.alpha * (1f - fg.alpha)) / a
    return Color(r, g, b, a)
}
