# Provider logo assets

These SVGs are the compact provider marks shared with Aiden Agent's
`ProviderIcon` system. Aiden On The Go copies the reviewed vector sources into
its Xcode asset catalog so native provider surfaces use the same identity map.

- Root Simple Icons assets remain monochrome template images so they follow
  Aiden's semantic palette in light, dark, and custom appearances.
- Multicolor or opaque-square assets preserve their original rendering so
  their negative space and brand colors remain intact.
- Fireworks, Together, and Grok retain their original official vector paths
  with the viewBox cropped to the logomark portion of the supplied wordmark.
- The supplied `cerebras.svg` was an OpenAI wordmark. It was replaced with the
  compact Cerebras mark from `@lobehub/icons-static-svg`.
- Radius intentionally has no asset. Unknown, custom, Radius, and future Pi
  providers use the native neutral-initial fallback in `AidenProviderIcon`.

## Provenance

- Simple Icons via jsDelivr: OpenAI, Anthropic/Claude, Google Gemini, DeepSeek,
  NVIDIA, OpenRouter, Hugging Face, Mistral, Cloudflare, Vercel, Amazon, Azure,
  GitHub Copilot, MiniMax, Xiaomi, LM Studio, Ollama, and their provider aliases.
- Official provider sites: Ant Ling, Fireworks, Groq, Together, Z.AI, OpenCode,
  Kimi/Moonshot, and their regional or product aliases.
- Wikimedia Commons: xAI and Grok.
- Lobe Icons static SVG package: Cerebras, replacing an incorrect OpenAI asset
  in the supplied folder.

The corresponding acquisition notes remain with Aiden Agent's canonical
`renderer/assets/provider-logos/README.md` inventory.
All marks remain the property of their respective owners.
