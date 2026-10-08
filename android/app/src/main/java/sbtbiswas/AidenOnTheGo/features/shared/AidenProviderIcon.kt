package sbtbiswas.AidenOnTheGo.features.shared

import android.graphics.BitmapFactory
import androidx.annotation.DrawableRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenProviderArtwork

object AidenProviderIconResolver {
    val supportedSlugs = setOf(
        "amazon-bedrock", "ant-ling", "anthropic", "apple-foundation-models",
        "azure-openai-responses", "cerebras", "claude", "cloudflare-ai-gateway",
        "cloudflare-workers-ai", "concentrate", "deepseek", "fireworks",
        "github-copilot", "google", "google-vertex", "grok", "groq",
        "huggingface", "kimi-coding", "lmstudio", "minimax", "minimax-cn",
        "mistral", "moonshotai", "moonshotai-cn", "nvidia", "ollama",
        "openai", "openai-codex", "opencode", "opencode-go", "openrouter",
        "tailscale", "together", "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams",
        "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn"
    )

    /** Marks drawn in their brand colors; every other logo is tinted like text. */
    val multicolorSlugs = setOf(
        "fireworks", "groq", "opencode", "opencode-go", "together", "zai", "zai-coding-cn"
    )

    // The drawables are generated from renderer/assets/provider-logos by
    // android/scripts/generate-provider-logos.py; rerun it when a logo changes.
    private val logos: Map<String, Int> = mapOf(
        "amazon-bedrock" to R.drawable.ic_provider_amazon_bedrock,
        "ant-ling" to R.drawable.ic_provider_ant_ling,
        "anthropic" to R.drawable.ic_provider_anthropic,
        "apple-foundation-models" to R.drawable.ic_provider_apple_foundation_models,
        "azure-openai-responses" to R.drawable.ic_provider_azure_openai_responses,
        "cerebras" to R.drawable.ic_provider_cerebras,
        "claude" to R.drawable.ic_provider_claude,
        "cloudflare-ai-gateway" to R.drawable.ic_provider_cloudflare_ai_gateway,
        "cloudflare-workers-ai" to R.drawable.ic_provider_cloudflare_workers_ai,
        "concentrate" to R.drawable.ic_provider_concentrate,
        "deepseek" to R.drawable.ic_provider_deepseek,
        "fireworks" to R.drawable.ic_provider_fireworks,
        "github-copilot" to R.drawable.ic_provider_github_copilot,
        "google" to R.drawable.ic_provider_google,
        "google-vertex" to R.drawable.ic_provider_google_vertex,
        "grok" to R.drawable.ic_provider_grok,
        "groq" to R.drawable.ic_provider_groq,
        "huggingface" to R.drawable.ic_provider_huggingface,
        "kimi-coding" to R.drawable.ic_provider_kimi_coding,
        "lmstudio" to R.drawable.ic_provider_lmstudio,
        "minimax" to R.drawable.ic_provider_minimax,
        "minimax-cn" to R.drawable.ic_provider_minimax_cn,
        "mistral" to R.drawable.ic_provider_mistral,
        "moonshotai" to R.drawable.ic_provider_moonshotai,
        "moonshotai-cn" to R.drawable.ic_provider_moonshotai_cn,
        "nvidia" to R.drawable.ic_provider_nvidia,
        "ollama" to R.drawable.ic_provider_ollama,
        "openai" to R.drawable.ic_provider_openai,
        "openai-codex" to R.drawable.ic_provider_openai_codex,
        "opencode" to R.drawable.ic_provider_opencode,
        "opencode-go" to R.drawable.ic_provider_opencode_go,
        "openrouter" to R.drawable.ic_provider_openrouter,
        "tailscale" to R.drawable.ic_provider_tailscale,
        "together" to R.drawable.ic_provider_together,
        "vercel-ai-gateway" to R.drawable.ic_provider_vercel_ai_gateway,
        "xai" to R.drawable.ic_provider_xai,
        "xiaomi" to R.drawable.ic_provider_xiaomi,
        "xiaomi-token-plan-ams" to R.drawable.ic_provider_xiaomi_token_plan_ams,
        "xiaomi-token-plan-cn" to R.drawable.ic_provider_xiaomi_token_plan_cn,
        "xiaomi-token-plan-sgp" to R.drawable.ic_provider_xiaomi_token_plan_sgp,
        "zai" to R.drawable.ic_provider_zai,
        "zai-coding-cn" to R.drawable.ic_provider_zai_coding_cn
    )

    private val aliases = mapOf(
        "azure" to "azure-openai-responses",
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

    /** The bundled logo for a resolved slug, or null when the provider has none. */
    @DrawableRes
    fun logoRes(slug: String): Int? = logos[slug]

    private fun matchesNumberedCustomProvider(provider: String, base: String): Boolean {
        if (provider == base) return true
        if (!provider.startsWith("$base-")) return false
        val suffix = provider.drop(base.length + 1)
        val number = suffix.toIntOrNull() ?: return false
        return number >= 2 && !suffix.startsWith("0")
    }
}

/**
 * A provider's mark: custom artwork when the host supplies it, otherwise the bundled logo
 * shared with desktop and iOS, otherwise a neutral initial. Mono logos take [tint] (or the
 * surface's content color) so they follow the theme; multicolor logos keep their brand
 * colors. The mark is decorative because every caller sets the provider name beside it,
 * so it stays out of TalkBack.
 */
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
    val slug = AidenProviderIconResolver.slug(providerId, modelId)
    val logo = slug?.let(AidenProviderIconResolver::logoRes)
    val markModifier = modifier
        .size(size)
        .semantics { hideFromAccessibility() }

    // Bounded custom PNG artwork if supplied
    val customBitmap = remember(artwork) {
        artwork?.boundedPNGData?.let { data ->
            try {
                BitmapFactory.decodeByteArray(data, 0, data.size)?.asImageBitmap()
            } catch (_: Exception) { null }
        }
    }

    when {
        customBitmap != null -> Image(
            bitmap = customBitmap,
            contentDescription = null,
            modifier = markModifier.clip(RoundedCornerShape(size * 0.2f))
        )
        logo != null && slug in AidenProviderIconResolver.multicolorSlugs -> Image(
            painter = painterResource(logo),
            contentDescription = null,
            modifier = markModifier
        )
        logo != null -> Icon(
            painter = painterResource(logo),
            contentDescription = null,
            modifier = markModifier,
            tint = tint ?: MaterialTheme.colorScheme.onSurface
        )
        else -> {
            // Unknown, custom, and future providers get a quiet initial rather than a
            // brand color Aiden does not know, matching desktop and iOS.
            val initial = providerLabel.trim().firstOrNull()?.uppercaseChar() ?: '?'
            Box(
                modifier = markModifier
                    .clip(RoundedCornerShape(size * 0.28f))
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = initial.toString(),
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = (size.value * 0.48f).sp,
                    color = tint ?: MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
