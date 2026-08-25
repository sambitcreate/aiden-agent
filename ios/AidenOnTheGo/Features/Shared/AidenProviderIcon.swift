import SwiftUI
import UIKit

enum AidenProviderIconResolver {
    static let supportedSlugs: Set<String> = [
        "amazon-bedrock",
        "ant-ling",
        "anthropic",
        "apple-foundation-models",
        "azure-openai-responses",
        "cerebras",
        "claude",
        "cloudflare-ai-gateway",
        "cloudflare-workers-ai",
        "concentrate",
        "deepseek",
        "fireworks",
        "github-copilot",
        "google",
        "google-vertex",
        "grok",
        "groq",
        "huggingface",
        "kimi-coding",
        "lmstudio",
        "minimax",
        "minimax-cn",
        "mistral",
        "moonshotai",
        "moonshotai-cn",
        "nvidia",
        "ollama",
        "openai",
        "openai-codex",
        "opencode",
        "opencode-go",
        "openrouter",
        "together",
        "vercel-ai-gateway",
        "xai",
        "xiaomi",
        "xiaomi-token-plan-ams",
        "xiaomi-token-plan-cn",
        "xiaomi-token-plan-sgp",
        "zai",
        "zai-coding-cn",
    ]

    static let multicolorSlugs: Set<String> = [
        "fireworks",
        "groq",
        "opencode",
        "opencode-go",
        "together",
        "zai",
        "zai-coding-cn",
    ]

    private static let aliases = [
        "gemini": "google",
        "lm-studio": "lmstudio",
        "moonshot": "moonshotai",
    ]

    static func slug(providerID: String, modelID: String? = nil) -> String? {
        let provider = providerID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let model = modelID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""

        if provider == "anthropic", model.contains("claude") { return "claude" }
        if provider == "xai", model.contains("grok") { return "grok" }
        if matchesNumberedCustomProvider(provider, base: "custom:lmstudio") { return "lmstudio" }
        if matchesNumberedCustomProvider(provider, base: "custom:ollama") { return "ollama" }
        if let alias = aliases[provider] { return alias }
        return supportedSlugs.contains(provider) ? provider : nil
    }

    private static func matchesNumberedCustomProvider(_ provider: String, base: String) -> Bool {
        if provider == base { return true }
        guard provider.hasPrefix(base + "-") else { return false }
        let suffix = provider.dropFirst(base.count + 1)
        guard !suffix.isEmpty,
              suffix.first != "0",
              let number = Int(suffix)
        else { return false }
        return number >= 2
    }
}

struct AidenProviderIcon: View {
    @Environment(\.aidenPalette) private var palette

    let providerID: String
    let providerLabel: String
    var modelID: String? = nil
    var artwork: AidenProviderArtwork? = nil
    var size: CGFloat = 20
    var color: Color? = nil

    private var slug: String? {
        AidenProviderIconResolver.slug(providerID: providerID, modelID: modelID)
    }

    var body: some View {
        Group {
            if let customImage {
                Image(uiImage: customImage)
                    .resizable()
                    .renderingMode(.original)
                    .scaledToFit()
            } else if let slug {
                Image("ProviderLogo-\(slug)")
                    .resizable()
                    .renderingMode(
                        AidenProviderIconResolver.multicolorSlugs.contains(slug)
                            ? .original
                            : .template
                    )
                    .foregroundStyle(color ?? palette.foreground)
                    .scaledToFit()
            } else {
                Text(providerInitial)
                    .font(.system(size: size * 0.48, weight: .semibold, design: .rounded))
                    .foregroundStyle(color ?? palette.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(palette.sidebar)
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var providerInitial: String {
        providerLabel.trimmingCharacters(in: .whitespacesAndNewlines).first
            .map { String($0).uppercased() } ?? "?"
    }

    private var customImage: UIImage? {
        guard let data = artwork?.boundedPNGData else { return nil }
        return UIImage(data: data)
    }
}
