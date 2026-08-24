package sbtbiswas.AidenOnTheGo.config

import android.content.Context
import androidx.compose.ui.graphics.Color
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
    MOSS("Moss")
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
    val dangerHex: String
) {
    val canvas: Color get() = hexToColor(canvasHex)
    val sidebar: Color get() = hexToColor(sidebarHex)
    val raised: Color get() = hexToColor(raisedHex)
    val foreground: Color get() = hexToColor(foregroundHex)
    val secondary: Color get() = hexToColor(secondaryHex)
    val accent: Color get() = hexToColor(accentHex)
    val success: Color get() = hexToColor(successHex)
    val warning: Color get() = hexToColor(warningHex)
    val danger: Color get() = hexToColor(dangerHex)

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

object AidenThemeCatalog {
    val palettes: Map<AidenThemePresetID, List<AidenPalette>> = mapOf(
        AidenThemePresetID.AIDEN to listOf(
            AidenPalette(canvasHex = "#F6F7F9", sidebarHex = "#EEF0F3", raisedHex = "#FFFFFF", foregroundHex = "#3D3F41", secondaryHex = "#6B7280", accentHex = "#006AD6", successHex = "#30D158", warningHex = "#FF9F0A", dangerHex = "#FF453A"),
            AidenPalette(canvasHex = "#181B21", sidebarHex = "#20242C", raisedHex = "#292E37", foregroundHex = "#D1D4DA", secondaryHex = "#9AA3AE", accentHex = "#3E97F6", successHex = "#32D17A", warningHex = "#FFB020", dangerHex = "#FF5E57")
        ),
        AidenThemePresetID.SLATE to listOf(
            AidenPalette(canvasHex = "#F2F5F9", sidebarHex = "#E6EBF2", raisedHex = "#FFFFFF", foregroundHex = "#3A434E", secondaryHex = "#637083", accentHex = "#087581", successHex = "#2DB67D", warningHex = "#E0A72E", dangerHex = "#E24D5B"),
            AidenPalette(canvasHex = "#181E26", sidebarHex = "#202833", raisedHex = "#29323E", foregroundHex = "#D1D6DE", secondaryHex = "#94A3BB", accentHex = "#21A9BE", successHex = "#35C08A", warningHex = "#D4A72C", dangerHex = "#F87171")
        ),
        AidenThemePresetID.BERRY to listOf(
            AidenPalette(canvasHex = "#FBF4F7", sidebarHex = "#F1E8EE", raisedHex = "#FFFFFF", foregroundHex = "#443F4A", secondaryHex = "#6E6470", accentHex = "#B42C70", successHex = "#22C7A8", warningHex = "#E3A23C", dangerHex = "#E24C5A"),
            AidenPalette(canvasHex = "#1D1822", sidebarHex = "#251D2B", raisedHex = "#2E2435", foregroundHex = "#D5CFD6", secondaryHex = "#A39AA6", accentHex = "#E8629F", successHex = "#32D1B2", warningHex = "#D9A441", dangerHex = "#F0717A")
        ),
        AidenThemePresetID.MOSS to listOf(
            AidenPalette(canvasHex = "#F3F6F4", sidebarHex = "#E7ECE8", raisedHex = "#FFFFFF", foregroundHex = "#3F4943", secondaryHex = "#65736B", accentHex = "#157862", successHex = "#3DBF7D", warningHex = "#D4A22A", dangerHex = "#E05353"),
            AidenPalette(canvasHex = "#18201C", sidebarHex = "#202A25", raisedHex = "#29342E", foregroundHex = "#D1D6D3", secondaryHex = "#95A39B", accentHex = "#42B596", successHex = "#47D18C", warningHex = "#D9B43A", dangerHex = "#EB6B6B")
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
