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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
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
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
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
                window.statusBarColor = android.graphics.Color.TRANSPARENT
                window.navigationBarColor = android.graphics.Color.TRANSPARENT
                window.decorView.setBackgroundColor(palette.canvas.toArgb())

                val insetsController = WindowCompat.getInsetsController(window, view)
                insetsController.isAppearanceLightStatusBars = !isDark
                insetsController.isAppearanceLightNavigationBars = !isDark
            }
        }
    }

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
            surfaceContainerLowest = palette.canvas,
            surfaceContainerLow = palette.sidebar,
            surfaceContainer = palette.raised.withElevationLuminosity(2.dp, isDark),
            surfaceContainerHigh = palette.raised.withElevationLuminosity(4.dp, isDark),
            surfaceContainerHighest = palette.raised.withElevationLuminosity(8.dp, isDark),
            outline = palette.secondary.copy(alpha = 0.35f),
            outlineVariant = palette.secondary.copy(alpha = 0.15f),
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
            surfaceContainerLowest = palette.canvas,
            surfaceContainerLow = palette.sidebar,
            surfaceContainer = palette.raised,
            surfaceContainerHigh = palette.raised,
            surfaceContainerHighest = palette.raised,
            outline = palette.secondary.copy(alpha = 0.3f),
            outlineVariant = palette.secondary.copy(alpha = 0.12f),
            error = palette.danger,
            onError = Color.White,
            errorContainer = palette.danger.copy(alpha = 0.12f),
            onErrorContainer = palette.danger
        )
    }

    val scale = config.fontSize.scaleFactor
    val typography = Typography(
        headlineLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = (30 * scale).sp, lineHeight = (36 * scale).sp, letterSpacing = (-0.5).sp, color = palette.foreground),
        headlineMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = (24 * scale).sp, lineHeight = (30 * scale).sp, letterSpacing = (-0.25).sp, color = palette.foreground),
        headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = (20 * scale).sp, lineHeight = (26 * scale).sp, letterSpacing = 0.sp, color = palette.foreground),
        titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = (18 * scale).sp, lineHeight = (24 * scale).sp, letterSpacing = 0.sp, color = palette.foreground),
        titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = (16 * scale).sp, lineHeight = (22 * scale).sp, letterSpacing = 0.1.sp, color = palette.foreground),
        titleSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = (14 * scale).sp, lineHeight = (20 * scale).sp, letterSpacing = 0.1.sp, color = palette.secondary),
        bodyLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = (16 * scale).sp, lineHeight = (24 * scale).sp, letterSpacing = 0.2.sp, color = palette.foreground),
        bodyMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = (14 * scale).sp, lineHeight = (20 * scale).sp, letterSpacing = 0.25.sp, color = palette.foreground),
        bodySmall = TextStyle(fontWeight = FontWeight.Normal, fontSize = (12 * scale).sp, lineHeight = (16 * scale).sp, letterSpacing = 0.3.sp, color = palette.secondary),
        labelLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = (14 * scale).sp, lineHeight = (20 * scale).sp, letterSpacing = 0.1.sp, color = palette.foreground),
        labelMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = (12 * scale).sp, lineHeight = (16 * scale).sp, letterSpacing = 0.4.sp, color = palette.foreground),
        labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = (11 * scale).sp, lineHeight = (14 * scale).sp, letterSpacing = 0.5.sp, color = palette.secondary)
    )

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

/**
 * Calculates logarithmic elevation luminosity for OLED dark mode surfaces.
 */
fun Color.withElevationLuminosity(elevation: androidx.compose.ui.unit.Dp, isDark: Boolean): Color {
    if (!isDark || elevation <= 0.dp) return this
    val alpha = ((4.5f * kotlin.math.ln(elevation.value + 1f)) + 2f) / 100f
    return Color.White.copy(alpha = alpha).compositeOver(this)
}

private fun Color.compositeOver(background: Color): Color {
    val fg = this
    val bg = background
    val a = fg.alpha + bg.alpha * (1f - fg.alpha)
    if (a == 0f) return Color.Transparent
    val r = (fg.red * fg.alpha + bg.red * bg.alpha * (1f - fg.alpha)) / a
    val g = (fg.green * fg.alpha + bg.green * bg.alpha * (1f - fg.alpha)) / a
    val b = (fg.blue * fg.alpha + bg.blue * bg.alpha * (1f - fg.alpha)) / a
    return Color(r, g, b, a)
}
