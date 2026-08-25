package sbtbiswas.AidenOnTheGo.notifications

import java.net.URI
import java.net.URLDecoder

sealed class AidenNavigationDestination {
    object NewChat : AidenNavigationDestination()
    data class Chat(val chatId: String) : AidenNavigationDestination()
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

    fun parse(uriString: String): AidenNavigationRequest? {
        return try {
            val uri = URI(uriString)
            if (uri.scheme?.lowercase() != SCHEME) return null
            val host = uri.host?.lowercase() ?: return null

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
}
