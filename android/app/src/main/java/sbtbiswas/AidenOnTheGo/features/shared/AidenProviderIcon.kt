package sbtbiswas.AidenOnTheGo.features.shared

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sbtbiswas.AidenOnTheGo.models.AidenProviderArtwork
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

object AidenProviderIconResolver {
    val supportedSlugs = setOf(
        "amazon-bedrock", "ant-ling", "anthropic", "apple-foundation-models",
        "azure-openai-responses", "cerebras", "claude", "cloudflare-ai-gateway",
        "cloudflare-workers-ai", "concentrate", "deepseek", "fireworks",
        "github-copilot", "google", "google-vertex", "grok", "groq",
        "huggingface", "kimi-coding", "lmstudio", "minimax", "minimax-cn",
        "mistral", "moonshotai", "moonshotai-cn", "nvidia", "ollama",
        "openai", "openai-codex", "opencode", "opencode-go", "openrouter",
        "together", "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams",
        "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn"
    )

    private val aliases = mapOf(
        "gemini" to "google",
        "lm-studio" to "lmstudio",
        "moonshot" to "moonshotai"
    )

    fun slug(providerId: String, modelId: String? = null): String? {
        val provider = providerId.trim().lowercase()
        val model = modelId?.trim()?.lowercase() ?: ""

        if (provider == "anthropic" && model.contains("claude")) return "claude"
        if (provider == "xai" && model.contains("grok")) return "grok"
        if (matchesNumberedCustomProvider(provider, "custom:lmstudio")) return "lmstudio"
        if (matchesNumberedCustomProvider(provider, "custom:ollama")) return "ollama"
        if (aliases.containsKey(provider)) return aliases[provider]
        return if (supportedSlugs.contains(provider)) provider else null
    }

    private fun matchesNumberedCustomProvider(provider: String, base: String): Boolean {
        if (provider == base) return true
        if (!provider.startsWith("$base-")) return false
        val suffix = provider.drop(base.length + 1)
        val number = suffix.toIntOrNull() ?: return false
        return number >= 2 && !suffix.startsWith("0")
    }
}

@Composable
fun AidenProviderIcon(
    providerId: String,
    providerLabel: String,
    modifier: Modifier = Modifier,
    modelId: String? = null,
    artwork: AidenProviderArtwork? = null,
    size: Dp = 24.dp,
    tint: Color? = null
) {
    val palette = AidenTheme.palette
    val slug = AidenProviderIconResolver.slug(providerId, modelId)

    // Bounded custom PNG artwork if supplied
    val customBitmap = remember(artwork) {
        artwork?.boundedPNGData?.let { data ->
            try {
                BitmapFactory.decodeByteArray(data, 0, data.size)?.asImageBitmap()
            } catch (_: Exception) { null }
        }
    }

    if (customBitmap != null) {
        Image(
            bitmap = customBitmap,
            contentDescription = providerLabel,
            modifier = modifier
                .size(size)
                .clip(RoundedCornerShape(size * 0.2f))
        )
    } else {
        // Semantic Monogram or Icon Badge
        val initial = providerLabel.trim().firstOrNull()?.uppercaseChar() ?: 'A'
        val badgeColor = when (slug) {
            "openai", "openai-codex" -> Color(0xFF10A37F)
            "claude", "anthropic" -> Color(0xFFD97706)
            "google", "google-vertex" -> Color(0xFF4285F4)
            "deepseek" -> Color(0xFF0066FF)
            "grok", "xai" -> Color(0xFF1D1D1D)
            "mistral" -> Color(0xFFFF7000)
            "ollama" -> Color(0xFF24292E)
            else -> palette.accent
        }

        Box(
            modifier = modifier
                .size(size)
                .clip(RoundedCornerShape(size * 0.25f))
                .background(badgeColor),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = initial.toString(),
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.Bold,
                fontSize = (size.value * 0.55f).sp,
                color = Color.White
            )
        }
    }
}
