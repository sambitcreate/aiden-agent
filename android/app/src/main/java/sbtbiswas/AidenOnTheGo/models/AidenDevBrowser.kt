package sbtbiswas.AidenOnTheGo.models

import java.net.URI

/** Only user-entered web URLs reach WebView; paired API credentials never enter this path. */
object AidenDevBrowser {
    fun url(input: String): String? = runCatching {
        val value = input.trim()
        if (value.length > 8192 || value.any { it.code < 32 }) return null
        val uri = URI(value)
        if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.port !in -1..65535 || uri.port == 0) return null
        uri.toASCIIString()
    }.getOrNull()

    /** User-tapped HTTP dev-port links to canonical tailnet hosts open in the workspace pane. */
    fun chatPreviewUrl(input: String): String? {
        val validated = url(input) ?: return null
        val uri = URI(validated)
        return validated.takeIf { uri.scheme.equals("http", true) && uri.port in 1..65535 && validatedHost(uri.host) != null }
    }

    fun resolveForMac(input: String, developmentHost: String?): String? {
        val candidate = if (Regex("^(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):[0-9]+").containsMatchIn(input)) "http://$input" else input
        val validated = url(candidate) ?: return null
        val uri = URI(validated)
        if (uri.host.lowercase() !in setOf("localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1")) return validated
        val host = validatedHost(developmentHost) ?: return null
        return uri.toString().replaceRange(uri.scheme.length + 3, uri.scheme.length + 3 + uri.rawAuthority.length,
            host + if (uri.port > 0) ":${uri.port}" else "")
    }

    fun validatedHost(value: String?): String? = value?.takeIf { it == host("https://$it") && !it.contains('/') && !it.contains(':') }

    fun host(endpoint: String?): String? = runCatching { URI(endpoint ?: return null).host }.getOrNull()
        ?.takeIf { it.endsWith(".ts.net", ignoreCase = true) || tailnetIPv4(it) }

    fun defaultUrl(endpoint: String?, port: Int = 3000): String? = host(endpoint)?.takeIf { port in 1..65535 }?.let { "http://$it:$port" }

    private fun tailnetIPv4(value: String): Boolean {
        val parts = value.split('.').map { raw -> val number = raw.toIntOrNull() ?: return false; if (number.toString() != raw) return false; number }
        return parts.size == 4 && parts[0] == 100 && parts[1] in 64..127 && parts[2] in 0..255 && parts[3] in 0..255
    }
}
