package sbtbiswas.AidenOnTheGo.models

import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol

/** The light or dark scheme a visual viewer document is drawn in (contract revision 34). */
enum class AidenVisualDocumentScheme(val wire: String) {
    LIGHT("light"),
    DARK("dark");

    companion object {
        fun forDarkTheme(isDark: Boolean): AidenVisualDocumentScheme = if (isDark) DARK else LIGHT
    }
}

/**
 * Request bounds for `GET /chats/{chatId}/visuals/{visualId}/document` (revision 34).
 * Ids are sent as plain path segments, so only the unreserved characters ids carry
 * on the wire are accepted, and dot segments are refused so a URL never resolves
 * to another route.
 */
object AidenVisualDocumentRequest {
    /** Uncompressed body bound the Mac guarantees. */
    const val MAXIMUM_BYTES = 12 * 1_024 * 1_024
    /** The preset the Mac falls back to, and the one the dynamic (Material You) preset maps to. */
    const val DEFAULT_THEME = "aiden"

    private val IDENTIFIER = Regex("^[A-Za-z0-9._:-]{1,256}$")
    private val THEME = Regex("^[a-z0-9][a-z0-9-]{0,63}$")

    fun isValidIdentifier(value: String): Boolean =
        IDENTIFIER.matches(value) && value != "." && value != ".."

    fun isValidTheme(value: String): Boolean = THEME.matches(value)

    /**
     * The wire preset id from `protocol/aiden-appearance-v1.json`. Android's dynamic
     * preset has no shared palette, so it asks for Aiden's.
     */
    fun themeId(preset: AidenThemePresetID): String =
        if (preset.isDynamic) DEFAULT_THEME else preset.name.lowercase()
}

/**
 * Whether tapping a visual snapshot opens the interactive viewer. The live `/server`
 * features decide once they are known; before that, the features this pairing last
 * saw stand in (R21), so a cold offline start can still show a cached document.
 */
object AidenVisualViewerGate {
    fun isAvailable(liveFeatures: List<String>?, cachedFeatures: List<String>?): Boolean =
        (liveFeatures ?: cachedFeatures)?.contains(AidenRemoteProtocol.CHAT_VISUAL_VIEWER_FEATURE) == true
}
