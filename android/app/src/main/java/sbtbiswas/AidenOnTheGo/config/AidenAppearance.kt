package sbtbiswas.AidenOnTheGo.config

import android.content.Context
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

@Serializable
enum class AidenThemePresetID(val title: String) {
    AIDEN("Aiden"),
    SLATE("Slate"),
    BERRY("Berry"),
    MOSS("Moss"),
    PAPER("Paper"),
    CALM("Calm"),
    GRAPHITE("Graphite"),
    DUSK("Dusk"),
    MIDNIGHT("Midnight"),
    MONOCHROME("Monochrome"),

    /** Material You: the palette follows the device wallpaper colors (Android 12+). */
    DYNAMIC("System");

    val isDynamic: Boolean get() = this == DYNAMIC

    companion object {
        const val DYNAMIC_MIN_SDK = 31

        /** Presets offered on a device running [sdkInt]; dynamic color needs Android 12. */
        fun available(sdkInt: Int): List<AidenThemePresetID> =
            entries.filter { !it.isDynamic || sdkInt >= DYNAMIC_MIN_SDK }
    }
}

@Serializable
enum class AidenAppearanceMode(val title: String) {
    SYSTEM("System"),
    LIGHT("Light"),
    DARK("Dark")
}

@Serializable
enum class AidenFontSize(val title: String, val scaleFactor: Float) {
    SMALL("Small", 0.9f),
    MEDIUM("Default", 1.0f),
    LARGE("Large", 1.15f),
    EXTRA_LARGE("Extra Large", 1.3f)
}

@Serializable
enum class AidenDiffMarkerOption(val title: String) {
    SYMBOLS("Symbols and color"),
    COLOR_ONLY("Color only")
}

data class AidenPalette(
    val canvasHex: String,
    val sidebarHex: String,
    val raisedHex: String,
    val foregroundHex: String,
    val secondaryHex: String,
    val accentHex: String,
    val successHex: String,
    val warningHex: String,
    val dangerHex: String,
    /** True for a dark-scheme palette; it sets the pressed step of a black-content solid fill. */
    val isDark: Boolean = false
) {
    // Parsed once per palette: these are read on every recomposition across the app.
    val canvas: Color = hexToColor(canvasHex)
    val sidebar: Color = hexToColor(sidebarHex)
    val raised: Color = hexToColor(raisedHex)
    val foreground: Color = hexToColor(foregroundHex)
    val secondary: Color = hexToColor(secondaryHex)
    val accent: Color = hexToColor(accentHex)
    val success: Color = hexToColor(successHex)
    val warning: Color = hexToColor(warningHex)
    val danger: Color = hexToColor(dangerHex)

    /**
     * Readable text and icon color on an accent fill: white or black, whichever has the
     * higher WCAG contrast, matching the desktop's `accentForeground`.
     */
    val onAccent: Color = readableOn(accent)

    /**
     * Labelled solid fills: any filled control that carries a label or glyph (primary and
     * destructive buttons, send/stop actions, accent bubbles, FABs, checked switches and
     * checkboxes). Paint the [AidenSolidFill.fill] with [AidenSolidFill.content] on top.
     * The raw [accent] and [danger] stay the bright ink for text, icons, links, tints and
     * indicators; only labelled fills use these deepened tones. Same rule as iOS.
     */
    val accentFill: AidenSolidFill = solidFill(accent, isDark)
    val dangerFill: AidenSolidFill = solidFill(danger, isDark)

    fun applyingContrast(contrast: Int, baseline: Int = 50): AidenPalette {
        if (contrast == baseline) return this
        val delta = contrast - baseline
        val secondaryTarget = if (delta > 0) foregroundHex else canvasHex
        val fraction = min(abs(delta).toFloat() / 100f * (if (delta > 0) 0.7f else 0.25f), 0.7f)
        return copy(
            secondaryHex = mixHex(secondaryHex, secondaryTarget, fraction)
        )
    }

    companion object {
        fun hexToColor(hex: String): Color {
            val cleanHex = hex.removePrefix("#")
            val colorInt = cleanHex.toLong(16)
            return if (cleanHex.length == 6) {
                Color(0xFF000000 or colorInt)
            } else {
                Color(colorInt)
            }
        }

        /** WCAG 2.x contrast ratio between two opaque colors. */
        fun contrastRatio(a: Color, b: Color): Float {
            val la = a.luminance()
            val lb = b.luminance()
            return (maxOf(la, lb) + 0.05f) / (minOf(la, lb) + 0.05f)
        }

        /** White or black, whichever reads better on [fill]. */
        fun readableOn(fill: Color): Color =
            if (contrastRatio(fill, Color.White) >= contrastRatio(fill, Color.Black)) Color.White else Color.Black

        /** How far a solid fill may deepen toward black before giving up on white content. */
        const val MaxFillDeepening = 0.45f

        /** WCAG AA for normal text. */
        const val SolidFillMinimumContrast = 4.5f

        /**
         * Derives the solid fill for [base] (the same rule as iOS and desktop `solidFill()`).
         *
         * In both schemes, mix [base] toward black in 1% steps, at most [MaxFillDeepening], until
         * white content reaches 4.5:1; a color that already passes stays unchanged. Pressed goes a
         * further 10% toward black. If 45% is not enough (Monochrome's white dark accent), keep
         * [base] with whichever of black or white reads better; pressed then moves 14% (dark) or
         * 7% (light) away from the content color. Pressed always differs from the fill: when the
         * mix would leave it unchanged (pure black or white), it moves the other way instead.
         */
        fun solidFill(base: Color, isDark: Boolean): AidenSolidFill {
            val color = base.copy(alpha = 1f)
            val maxStep = (MaxFillDeepening * 100).roundToInt()
            for (step in 0..maxStep) {
                val fill = mixColor(color, Color.Black, step / 100f)
                if (contrastRatio(fill, Color.White) >= SolidFillMinimumContrast) {
                    return AidenSolidFill(fill = fill, content = Color.White, pressed = pressedFill(fill, Color.Black, 0.10f))
                }
            }
            val content = readableOn(color)
            val toward = if (content == Color.White) Color.Black else Color.White
            return AidenSolidFill(
                fill = color,
                content = content,
                pressed = pressedFill(color, toward, if (isDark) 0.14f else 0.07f)
            )
        }

        /** [fill] mixed [amount] toward [toward], or the opposite way when that changes nothing. */
        private fun pressedFill(fill: Color, toward: Color, amount: Float): Color {
            val pressed = mixColor(fill, toward, amount)
            if (pressed != fill) return pressed
            return mixColor(fill, if (toward == Color.Black) Color.White else Color.Black, amount)
        }

        /** Mixes two opaque colors in sRGB and rounds each channel to 8 bits, like `mixHex`. */
        fun mixColor(a: Color, b: Color, fraction: Float): Color {
            val t = fraction.coerceIn(0f, 1f)
            fun channel(x: Float, y: Float) = ((x + (y - x) * t) * 255f).roundToInt().coerceIn(0, 255)
            return Color(channel(a.red, b.red), channel(a.green, b.green), channel(a.blue, b.blue))
        }

        fun mixHex(hexA: String, hexB: String, fraction: Float): String {
            val a = hexToColor(hexA)
            val b = hexToColor(hexB)
            val r = (a.red + (b.red - a.red) * fraction).coerceIn(0f, 1f)
            val g = (a.green + (b.green - a.green) * fraction).coerceIn(0f, 1f)
            val bl = (a.blue + (b.blue - a.blue) * fraction).coerceIn(0f, 1f)
            val rInt = (r * 255).roundToInt()
            val gInt = (g * 255).roundToInt()
            val bInt = (bl * 255).roundToInt()
            return String.format("#%02X%02X%02X", rInt, gInt, bInt)
        }
    }
}

/** A labelled solid fill: the container, its text/icon color, and its pressed container. */
data class AidenSolidFill(
    val fill: Color,
    val content: Color,
    val pressed: Color
)

object AidenThemeCatalog {
    val palettes: Map<AidenThemePresetID, List<AidenPalette>> = mapOf(
        AidenThemePresetID.AIDEN to listOf(
            AidenPalette(canvasHex = "#FBFBFA", sidebarHex = "#F3F3F1", raisedHex = "#FFFFFF", foregroundHex = "#181817", secondaryHex = "#686866", accentHex = "#0B7DE5", successHex = "#087C58", warningHex = "#9A6700", dangerHex = "#C3322B"),
            AidenPalette(canvasHex = "#111110", sidebarHex = "#171716", raisedHex = "#1B1B1A", foregroundHex = "#F5F5F3", secondaryHex = "#A7A7A2", accentHex = "#4B9CF2", successHex = "#55C99B", warningHex = "#E6B750", dangerHex = "#E25750", isDark = true)
        ),
        AidenThemePresetID.SLATE to listOf(
            AidenPalette(canvasHex = "#F2F5F9", sidebarHex = "#E6EBF2", raisedHex = "#FFFFFF", foregroundHex = "#3A434E", secondaryHex = "#637083", accentHex = "#087581", successHex = "#2DB67D", warningHex = "#E0A72E", dangerHex = "#E24D5B"),
            AidenPalette(canvasHex = "#181E26", sidebarHex = "#202833", raisedHex = "#29323E", foregroundHex = "#D1D6DE", secondaryHex = "#94A3BB", accentHex = "#21A9BE", successHex = "#35C08A", warningHex = "#D4A72C", dangerHex = "#F87171", isDark = true)
        ),
        AidenThemePresetID.BERRY to listOf(
            AidenPalette(canvasHex = "#FBF4F7", sidebarHex = "#F1E8EE", raisedHex = "#FFFFFF", foregroundHex = "#443F4A", secondaryHex = "#6E6470", accentHex = "#B42C70", successHex = "#22C7A8", warningHex = "#E3A23C", dangerHex = "#E24C5A"),
            AidenPalette(canvasHex = "#1D1822", sidebarHex = "#251D2B", raisedHex = "#2E2435", foregroundHex = "#D5CFD6", secondaryHex = "#A39AA6", accentHex = "#E8629F", successHex = "#32D1B2", warningHex = "#D9A441", dangerHex = "#F0717A", isDark = true)
        ),
        AidenThemePresetID.MOSS to listOf(
            AidenPalette(canvasHex = "#F3F6F4", sidebarHex = "#E7ECE8", raisedHex = "#FFFFFF", foregroundHex = "#3F4943", secondaryHex = "#65736B", accentHex = "#157862", successHex = "#3DBF7D", warningHex = "#D4A22A", dangerHex = "#E05353"),
            AidenPalette(canvasHex = "#18201C", sidebarHex = "#202A25", raisedHex = "#29342E", foregroundHex = "#D1D6D3", secondaryHex = "#95A39B", accentHex = "#42B596", successHex = "#47D18C", warningHex = "#D9B43A", dangerHex = "#EB6B6B", isDark = true)
        ),
        AidenThemePresetID.PAPER to listOf(
            AidenPalette(canvasHex = "#FBFBFA", sidebarHex = "#F5F4F1", raisedHex = "#FFFFFF", foregroundHex = "#373329", secondaryHex = "#5A554A", accentHex = "#7E5E2A", successHex = "#3DBF7D", warningHex = "#D4A22A", dangerHex = "#E05353"),
            AidenPalette(canvasHex = "#242016", sidebarHex = "#2F2B21", raisedHex = "#413D33", foregroundHex = "#F5F4F1", secondaryHex = "#B0AB9F", accentHex = "#C9A97C", successHex = "#47D18C", warningHex = "#D9B43A", dangerHex = "#EB6B6B", isDark = true)
        ),
        AidenThemePresetID.CALM to listOf(
            AidenPalette(canvasHex = "#F5F4F1", sidebarHex = "#EAE7E1", raisedHex = "#FBFBFA", foregroundHex = "#373329", secondaryHex = "#5A554A", accentHex = "#7E5B2C", successHex = "#3DBF7D", warningHex = "#D4A22A", dangerHex = "#E05353"),
            AidenPalette(canvasHex = "#2F2B21", sidebarHex = "#242016", raisedHex = "#413D33", foregroundHex = "#F5F4F1", secondaryHex = "#B0AB9F", accentHex = "#D9A86C", successHex = "#47D18C", warningHex = "#D9B43A", dangerHex = "#EB6B6B", isDark = true)
        ),
        AidenThemePresetID.GRAPHITE to listOf(
            AidenPalette(canvasHex = "#F4F4F5", sidebarHex = "#E9E9EB", raisedHex = "#FFFFFF", foregroundHex = "#38383B", secondaryHex = "#64646A", accentHex = "#52525B", successHex = "#30D158", warningHex = "#FF9F0A", dangerHex = "#FF453A"),
            AidenPalette(canvasHex = "#151517", sidebarHex = "#1D1D20", raisedHex = "#26262A", foregroundHex = "#D4D4D8", secondaryHex = "#9C9CA3", accentHex = "#A1A1AA", successHex = "#32D17A", warningHex = "#FFB020", dangerHex = "#FF5E57", isDark = true)
        ),
        AidenThemePresetID.DUSK to listOf(
            AidenPalette(canvasHex = "#EEF4F3", sidebarHex = "#E2EBEA", raisedHex = "#FFFFFF", foregroundHex = "#37423F", secondaryHex = "#5F6E6A", accentHex = "#0F766E", successHex = "#2DB67D", warningHex = "#E0A72E", dangerHex = "#E24D5B"),
            AidenPalette(canvasHex = "#12201F", sidebarHex = "#18292A", raisedHex = "#213335", foregroundHex = "#CFE0DD", secondaryHex = "#93ABA6", accentHex = "#2DD4BF", successHex = "#35C08A", warningHex = "#D4A72C", dangerHex = "#F87171", isDark = true)
        ),
        AidenThemePresetID.MIDNIGHT to listOf(
            AidenPalette(canvasHex = "#EFF2F8", sidebarHex = "#E3E8F2", raisedHex = "#FFFFFF", foregroundHex = "#38405A", secondaryHex = "#5F6880", accentHex = "#3B5BA9", successHex = "#30D158", warningHex = "#FF9F0A", dangerHex = "#FF453A"),
            AidenPalette(canvasHex = "#141826", sidebarHex = "#1B2133", raisedHex = "#262D42", foregroundHex = "#D2D8E6", secondaryHex = "#94A0BC", accentHex = "#7FA0F0", successHex = "#32D17A", warningHex = "#FFB020", dangerHex = "#FF5E57", isDark = true)
        ),
        AidenThemePresetID.MONOCHROME to listOf(
            AidenPalette(canvasHex = "#FFFFFF", sidebarHex = "#F5F5F5", raisedHex = "#FFFFFF", foregroundHex = "#000000", secondaryHex = "#525252", accentHex = "#000000", successHex = "#00906C", warningHex = "#B58A00", dangerHex = "#D70022"),
            AidenPalette(canvasHex = "#0A0A0A", sidebarHex = "#141414", raisedHex = "#1F1F1F", foregroundHex = "#FFFFFF", secondaryHex = "#A3A3A3", accentHex = "#FFFFFF", successHex = "#2FBF8F", warningHex = "#FFD60A", dangerHex = "#FF4D5E", isDark = true)
        )
    )

    fun palette(preset: AidenThemePresetID, isDark: Boolean): AidenPalette {
        val list = palettes[preset] ?: palettes[AidenThemePresetID.AIDEN]!!
        return list[if (isDark) 1 else 0]
    }
}

@Serializable
data class AidenAppearanceConfig(
    val mode: AidenAppearanceMode = AidenAppearanceMode.SYSTEM,
    val preset: AidenThemePresetID = AidenThemePresetID.AIDEN,
    val contrast: Int = 50,
    val fontSize: AidenFontSize = AidenFontSize.MEDIUM,
    val diffMarkers: AidenDiffMarkerOption = AidenDiffMarkerOption.SYMBOLS,
    val reduceMotion: Boolean = false,
    val privacyMaskExcerpts: Boolean = false
)

class AidenAppearanceStore(private val storageDir: File) {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val configFile = File(storageDir, "appearance_config.json")

    private val _config = MutableStateFlow(AidenAppearanceConfig())
    val config: StateFlow<AidenAppearanceConfig> = _config.asStateFlow()

    init {
        load()
    }

    @Synchronized
    private fun load() {
        if (!configFile.exists()) return
        try {
            _config.value = json.decodeFromString(configFile.readText(Charsets.UTF_8))
        } catch (_: Exception) {}
    }

    @Synchronized
    private fun save() {
        try {
            storageDir.mkdirs()
            configFile.writeText(json.encodeToString(_config.value), Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    fun updateMode(mode: AidenAppearanceMode) {
        _config.value = _config.value.copy(mode = mode)
        save()
    }

    fun updatePreset(preset: AidenThemePresetID) {
        _config.value = _config.value.copy(preset = preset)
        save()
    }

    fun updateContrast(contrast: Int) {
        _config.value = _config.value.copy(contrast = contrast.coerceIn(0, 100))
        save()
    }

    fun updateFontSize(fontSize: AidenFontSize) {
        _config.value = _config.value.copy(fontSize = fontSize)
        save()
    }

    fun updateDiffMarkers(option: AidenDiffMarkerOption) {
        _config.value = _config.value.copy(diffMarkers = option)
        save()
    }

    fun updateReduceMotion(reduce: Boolean) {
        _config.value = _config.value.copy(reduceMotion = reduce)
        save()
    }

    fun updatePrivacyMaskExcerpts(mask: Boolean) {
        _config.value = _config.value.copy(privacyMaskExcerpts = mask)
        save()
    }
}
