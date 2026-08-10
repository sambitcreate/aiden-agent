use std::borrow::Cow;

use gpui::{AssetSource, Result, SharedString};

/// App-owned assets layered over gpui-component's icon bundle.
pub struct AppAssets;

const PROVIDER_ASSET_PATHS: &[&str] = &[
    "provider-logos/amazon-bedrock.svg",
    "provider-logos/ant-ling.svg",
    "provider-logos/anthropic.svg",
    "provider-logos/apple-foundation-models.svg",
    "provider-logos/azure-openai-responses.svg",
    "provider-logos/cerebras.svg",
    "provider-logos/claude.svg",
    "provider-logos/cloudflare-ai-gateway.svg",
    "provider-logos/cloudflare-workers-ai.svg",
    "provider-logos/deepseek.svg",
    "provider-logos/fireworks.svg",
    "provider-logos/github-copilot.svg",
    "provider-logos/google.svg",
    "provider-logos/google-vertex.svg",
    "provider-logos/grok.svg",
    "provider-logos/groq.svg",
    "provider-logos/huggingface.svg",
    "provider-logos/kimi-coding.svg",
    "provider-logos/lmstudio.svg",
    "provider-logos/mistral.svg",
    "provider-logos/minimax.svg",
    "provider-logos/minimax-cn.svg",
    "provider-logos/moonshotai.svg",
    "provider-logos/moonshotai-cn.svg",
    "provider-logos/nvidia.svg",
    "provider-logos/ollama.svg",
    "provider-logos/openai.svg",
    "provider-logos/openai-codex.svg",
    "provider-logos/openrouter.svg",
    "provider-logos/opencode.svg",
    "provider-logos/opencode-go.svg",
    "provider-logos/together.svg",
    "provider-logos/vercel-ai-gateway.svg",
    "provider-logos/xai.svg",
    "provider-logos/xiaomi.svg",
    "provider-logos/xiaomi-token-plan-ams.svg",
    "provider-logos/xiaomi-token-plan-cn.svg",
    "provider-logos/xiaomi-token-plan-sgp.svg",
    "provider-logos/zai.svg",
    "provider-logos/zai-coding-cn.svg",
];

fn provider_asset(path: &str) -> Option<&'static [u8]> {
    Some(match path {
        "provider-logos/amazon-bedrock.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/amazon-bedrock.svg")
        }
        "provider-logos/ant-ling.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/ant-ling.svg")
        }
        "provider-logos/anthropic.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/anthropic.svg")
        }
        "provider-logos/apple-foundation-models.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/apple-foundation-models.svg")
        }
        "provider-logos/azure-openai-responses.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/azure-openai-responses.svg")
        }
        "provider-logos/cerebras.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/cerebras.svg")
        }
        "provider-logos/claude.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/claude.svg")
        }
        "provider-logos/cloudflare-ai-gateway.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/cloudflare-ai-gateway.svg")
        }
        "provider-logos/cloudflare-workers-ai.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/cloudflare-workers-ai.svg")
        }
        "provider-logos/deepseek.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/deepseek.svg")
        }
        "provider-logos/fireworks.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/fireworks.svg")
        }
        "provider-logos/github-copilot.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/github-copilot.svg")
        }
        "provider-logos/google.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/google.svg")
        }
        "provider-logos/google-vertex.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/google-vertex.svg")
        }
        "provider-logos/grok.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/grok.svg")
        }
        "provider-logos/groq.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/groq.svg")
        }
        "provider-logos/huggingface.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/huggingface.svg")
        }
        "provider-logos/kimi-coding.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/kimi-coding.svg")
        }
        "provider-logos/lmstudio.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/lmstudio.svg")
        }
        "provider-logos/mistral.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/mistral.svg")
        }
        "provider-logos/minimax.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/minimax.svg")
        }
        "provider-logos/minimax-cn.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/minimax-cn.svg")
        }
        "provider-logos/moonshotai.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/moonshotai.svg")
        }
        "provider-logos/moonshotai-cn.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/moonshotai-cn.svg")
        }
        "provider-logos/nvidia.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/nvidia.svg")
        }
        "provider-logos/ollama.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/ollama.svg")
        }
        "provider-logos/openai.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/openai.svg")
        }
        "provider-logos/openai-codex.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/openai-codex.svg")
        }
        "provider-logos/openrouter.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/openrouter.svg")
        }
        "provider-logos/opencode.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/opencode.svg")
        }
        "provider-logos/opencode-go.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/opencode-go.svg")
        }
        "provider-logos/together.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/together.svg")
        }
        "provider-logos/vercel-ai-gateway.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/vercel-ai-gateway.svg")
        }
        "provider-logos/xai.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/xai.svg")
        }
        "provider-logos/xiaomi.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/xiaomi.svg")
        }
        "provider-logos/xiaomi-token-plan-ams.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/xiaomi-token-plan-ams.svg")
        }
        "provider-logos/xiaomi-token-plan-cn.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/xiaomi-token-plan-cn.svg")
        }
        "provider-logos/xiaomi-token-plan-sgp.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/xiaomi-token-plan-sgp.svg")
        }
        "provider-logos/zai.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/zai.svg")
        }
        "provider-logos/zai-coding-cn.svg" => {
            include_bytes!("../../../renderer/assets/provider-logos/zai-coding-cn.svg")
        }
        _ => return None,
    })
}

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(asset) = provider_asset(path) {
            return Ok(Some(Cow::Borrowed(asset)));
        }
        gpui_component_assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut assets = gpui_component_assets::Assets.list(path)?;
        assets.extend(
            PROVIDER_ASSET_PATHS
                .iter()
                .filter(|candidate| candidate.starts_with(path))
                .map(|candidate| SharedString::from(*candidate)),
        );
        Ok(assets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_assets_are_embedded_alongside_component_icons() {
        assert!(AppAssets
            .load("provider-logos/anthropic.svg")
            .unwrap()
            .is_some());
        assert!(AppAssets.load("icons/check.svg").unwrap().is_some());
    }
}
