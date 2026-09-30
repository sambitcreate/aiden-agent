package sbtbiswas.AidenOnTheGo.notifications

import java.net.URI
import java.net.URLDecoder

sealed class AidenNavigationDestination {
    object NewChat : AidenNavigationDestination()
    data class Chat(val chatId: String) : AidenNavigationDestination()
    /** A Bot's conversation, addressed by the Bot's stable ID; the app resolves its chat. */
    data class BotChat(val botId: String) : AidenNavigationDestination()
}

data class AidenNavigationRequest(
    val destination: AidenNavigationDestination,
    val instanceId: String? = null,
    val workspaceId: String? = null,
    val startsVoice: Boolean = false
)

object AidenDeepLink {
    const val SCHEME = "aiden-otg"

    fun newChatUrl(instanceId: String? = null, workspaceId: String? = null, startsVoice: Boolean = false): String {
        val host = if (startsVoice) "new-chat-voice" else "new-chat"
        val params = mutableListOf<String>()
        instanceId?.let { params.add("instance=$it") }
        workspaceId?.let { params.add("workspace=$it") }
        return if (params.isEmpty()) {
            "$SCHEME://$host"
        } else {
            "$SCHEME://$host?${params.joinToString("&")}"
        }
    }

    fun chatUrl(instanceId: String, chatId: String): String {
        return "$SCHEME://chat?instance=$instanceId&chat=$chatId"
    }

    /** `aiden-otg://bot/{botId}/chat[?instance=…]`, matching the iOS link shape. */
    fun botChatUrl(botId: String, instanceId: String? = null): String? {
        if (!isSafeId(botId) || (instanceId != null && !isSafeId(instanceId))) return null
        val base = "$SCHEME://bot/$botId/chat"
        return if (instanceId == null) base else "$base?instance=$instanceId"
    }

    fun parse(uriString: String): AidenNavigationRequest? {
        return try {
            val uri = URI(uriString)
            if (uri.scheme?.lowercase() != SCHEME) return null
            val host = uri.host?.lowercase() ?: return null
            if (host == "bot") return parseBotChat(uri)

            val query = uri.query ?: ""
            val queryMap = query.split("&").filter { it.contains("=") }.associate {
                val parts = it.split("=", limit = 2)
                URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts[1], "UTF-8")
            }

            val instanceId = queryMap["instance"]
            val workspaceId = queryMap["workspace"]
            val chatId = queryMap["chat"]

            when (host) {
                "new-chat" -> AidenNavigationRequest(AidenNavigationDestination.NewChat, instanceId, workspaceId, false)
                "new-chat-voice" -> AidenNavigationRequest(AidenNavigationDestination.NewChat, instanceId, workspaceId, true)
                "chat" -> {
                    if (chatId != null && instanceId != null) {
                        AidenNavigationRequest(AidenNavigationDestination.Chat(chatId), instanceId, null, false)
                    } else null
                }
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun parseBotChat(uri: URI): AidenNavigationRequest? {
        if (uri.rawUserInfo != null || uri.port != -1 || uri.rawFragment != null) return null
        // Use the raw path so a percent-encoded separator can never decode into a different Bot ID.
        val segments = (uri.rawPath ?: return null).split("/")
        if (segments.size != 3 || segments[0].isNotEmpty() || segments[2] != "chat") return null
        val botId = segments[1]
        if (!isSafeId(botId)) return null
        val rawQuery = uri.rawQuery
        val instanceId = if (rawQuery.isNullOrEmpty()) {
            null
        } else {
            val parts = rawQuery.split("=", limit = 2)
            if (rawQuery.contains("&") || parts.size != 2 || parts[0] != "instance") return null
            parts[1].takeIf { isSafeId(it) } ?: return null
        }
        return AidenNavigationRequest(AidenNavigationDestination.BotChat(botId), instanceId, null, false)
    }

    private val safeIdPattern = Regex("^[A-Za-z0-9._:-]{1,160}$")

    private fun isSafeId(value: String): Boolean = safeIdPattern.matches(value)
}
