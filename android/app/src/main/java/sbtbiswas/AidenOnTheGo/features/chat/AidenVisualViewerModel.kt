package sbtbiswas.AidenOnTheGo.features.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URI

/**
 * One message the visual viewer page sends through `window.AidenVisualBridge.postMessage`
 * (contract revision 34). The set is closed: anything else is ignored.
 */
sealed interface AidenVisualBridgeMessage {
    /** The visual has drawn; the loading indicator can go. */
    data object Ready : AidenVisualBridgeMessage

    /** The visual asks for a follow-up. Native confirms before adding it to the composer. */
    data class Prompt(val text: String) : AidenVisualBridgeMessage

    /** A `render_ui` `openUrl` action. Native confirms before opening it in the browser. */
    data class OpenUrl(val url: String) : AidenVisualBridgeMessage

    companion object {
        /** The page bounds prompts to this many characters; native enforces it again. */
        const val MAXIMUM_PROMPT_LENGTH = 2_000
        const val MAXIMUM_URL_LENGTH = 2_048
        /** Upper bound on one raw bridge message, far above any valid one. */
        const val MAXIMUM_MESSAGE_LENGTH = 16 * 1_024

        private val json = Json { isLenient = false }

        /** The message [raw] carries, or null for anything outside the closed set. */
        fun parse(raw: String): AidenVisualBridgeMessage? {
            if (raw.length > MAXIMUM_MESSAGE_LENGTH) return null
            val root = try {
                json.parseToJsonElement(raw) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return null
            return when (root.stringValue("type")) {
                "ready" -> Ready
                "prompt" -> {
                    val text = root.stringValue("text")?.trim() ?: return null
                    if (text.isEmpty() || text.length > MAXIMUM_PROMPT_LENGTH) return null
                    Prompt(text)
                }
                "openUrl" -> {
                    val url = root.stringValue("url") ?: return null
                    if (!isOpenableUrl(url)) return null
                    OpenUrl(url)
                }
                else -> null
            }
        }

        /** Only an absolute `https:` URL with a host and no user info may be opened. */
        fun isOpenableUrl(url: String): Boolean {
            if (url.isEmpty() || url.length > MAXIMUM_URL_LENGTH) return false
            if (url.any { it.isWhitespace() || Character.isISOControl(it) }) return false
            val uri = try { URI(url) } catch (_: Exception) { return false }
            return uri.isAbsolute &&
                uri.scheme == "https" &&
                uri.rawUserInfo == null &&
                !uri.host.isNullOrEmpty()
        }

        private fun JsonObject.stringValue(key: String): String? {
            val primitive = this[key] as? JsonPrimitive ?: return null
            return if (primitive.isString) primitive.content else null
        }
    }
}

/** How a confirmed visual prompt joins the composer draft: appended, never sent. */
object AidenVisualPromptDraft {
    fun appended(existingDraft: String, prompt: String): String? {
        val text = prompt.trim()
        if (text.isEmpty()) return null
        val existing = existingDraft.trimEnd()
        return if (existing.isEmpty()) text else "$existing\n\n$text"
    }
}

/**
 * Native rate limit for prompts and links, matching the page's one per three
 * seconds. JavaScript interfaces are reachable from every frame of the page, so
 * native does not rely on the page's own bound.
 */
class AidenVisualBridgeThrottle(
    private val intervalMillis: Long = 3_000L,
    private val now: () -> Long
) {
    private var lastAccepted: Long? = null

    fun tryAcquire(): Boolean {
        val time = now()
        val last = lastAccepted
        if (last != null && time - last < intervalMillis && time >= last) return false
        lastAccepted = time
        return true
    }
}
