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

val AidenShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(32.dp)
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
                window.statusBarColor = android.graphics.Color.TRANSPARENT
                window.navigationBarColor = android.graphics.Color.TRANSPARENT
                window.decorView.setBackgroundColor(palette.canvas.toArgb())

                val insetsController = WindowCompat.getInsetsController(window, view)
                insetsController.isAppearanceLightStatusBars = !isDark
                insetsController.isAppearanceLightNavigationBars = !isDark
            }
        }
    }

    val tones = aidenTonalSurfaces(palette, isDark)
    val colorScheme = if (isDark) {
        darkColorScheme(
            primary = palette.accent,
            onPrimary = Color.White,
            primaryContainer = palette.accent.copy(alpha = 0.22f),
            onPrimaryContainer = palette.accent,
            secondary = palette.secondary,
            onSecondary = palette.foreground,
            secondaryContainer = palette.raised,
            onSecondaryContainer = palette.foreground,
            background = palette.canvas,
            onBackground = palette.foreground,
            surface = palette.sidebar,
            onSurface = palette.foreground,
            surfaceVariant = palette.raised,
            onSurfaceVariant = palette.secondary,
            surfaceContainerLowest = tones.lowest,
            surfaceContainerLow = tones.low,
            surfaceContainer = tones.container,
            surfaceContainerHigh = tones.high,
            surfaceContainerHighest = tones.highest,
            outline = Color.Transparent,
            outlineVariant = Color.Transparent,
            error = palette.danger,
            onError = Color.White,
            errorContainer = palette.danger.copy(alpha = 0.2f),
            onErrorContainer = palette.danger
        )
    } else {
        lightColorScheme(
            primary = palette.accent,
            onPrimary = Color.White,
            primaryContainer = palette.accent.copy(alpha = 0.14f),
            onPrimaryContainer = palette.accent,
            secondary = palette.secondary,
            onSecondary = palette.foreground,
            secondaryContainer = palette.raised,
            onSecondaryContainer = palette.foreground,
            background = palette.canvas,
            onBackground = palette.foreground,
            surface = palette.sidebar,
            onSurface = palette.foreground,
            surfaceVariant = palette.raised,
            onSurfaceVariant = palette.secondary,
            surfaceContainerLowest = tones.lowest,
            surfaceContainerLow = tones.low,
            surfaceContainer = tones.container,
            surfaceContainerHigh = tones.high,
            surfaceContainerHighest = tones.highest,
            outline = Color.Transparent,
            outlineVariant = Color.Transparent,
            error = palette.danger,
            onError = Color.White,
            errorContainer = palette.danger.copy(alpha = 0.12f),
            onErrorContainer = palette.danger
        )
    }

    val typography = aidenTypography(palette, config.fontSize.scaleFactor)

    CompositionLocalProvider(
        LocalAidenPalette provides palette,
        LocalAidenAppearanceConfig provides config
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = typography,
            shapes = AidenShapes,
            content = content
        )
    }
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
 * label roles open up slightly. Every role trims font padding and centers glyphs inside
 * the line box so icon-and-label rows align on the cap height.
 */
fun aidenTypography(palette: AidenPalette, scale: Float): Typography {
    val optical = LineHeightStyle(
        alignment = LineHeightStyle.Alignment.Center,
        trim = LineHeightStyle.Trim.Both
    )
    fun style(
        weight: FontWeight,
        size: Float,
        lineHeight: Float,
        tracking: Double,
        color: Color
    ) = TextStyle(
        fontWeight = weight,
        fontSize = (size * scale).sp,
        lineHeight = (lineHeight * scale).sp,
        letterSpacing = tracking.sp,
        color = color,
        lineHeightStyle = optical,
        platformStyle = PlatformTextStyle(includeFontPadding = false)
    )
    return Typography(
        displayLarge = style(FontWeight.SemiBold, 44f, 50f, -0.9, palette.foreground),
        displayMedium = style(FontWeight.SemiBold, 36f, 42f, -0.7, palette.foreground),
        displaySmall = style(FontWeight.SemiBold, 32f, 38f, -0.6, palette.foreground),
        headlineLarge = style(FontWeight.SemiBold, 28f, 34f, -0.45, palette.foreground),
        headlineMedium = style(FontWeight.SemiBold, 24f, 30f, -0.25, palette.foreground),
        headlineSmall = style(FontWeight.Medium, 20f, 26f, -0.1, palette.foreground),
        titleLarge = style(FontWeight.Medium, 20f, 26f, -0.1, palette.foreground),
        titleMedium = style(FontWeight.SemiBold, 16f, 22f, 0.1, palette.foreground),
        titleSmall = style(FontWeight.Medium, 14f, 20f, 0.1, palette.secondary),
        bodyLarge = style(FontWeight.Normal, 16f, 25f, 0.1, palette.foreground),
        bodyMedium = style(FontWeight.Normal, 14f, 20f, 0.25, palette.foreground),
        bodySmall = style(FontWeight.Normal, 12f, 16f, 0.3, palette.secondary),
        labelLarge = style(FontWeight.SemiBold, 14f, 20f, 0.1, palette.foreground),
        labelMedium = style(FontWeight.SemiBold, 12f, 16f, 0.4, palette.foreground),
        labelSmall = style(FontWeight.Medium, 11f, 14f, 0.5, palette.secondary)
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
