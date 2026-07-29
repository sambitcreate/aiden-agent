# Provider logo assets

These SVGs are the compact provider marks used by `ProviderIcon`. They were
selected from the user-provided `aiden-provider-logos` bundle and are bundled
by Vite through explicit static URLs.

- Root Simple Icons assets remain monochrome and render through a CSS mask so
  they follow Aiden's semantic text colors in light and dark appearances.
- Multicolor or opaque-square assets render as images so their negative space
  and brand colors are preserved.
- Fireworks, Together, and Grok retain their original official vector paths
  with the viewBox cropped to the logomark portion of the supplied wordmark.
- The supplied `cerebras.svg` was an OpenAI wordmark. It was replaced with the
  compact Cerebras mark from `@lobehub/icons-static-svg`.
- Radius intentionally has no asset. Unknown, custom, Radius, and future Pi
  providers use the neutral initial fallback in `ProviderIcon`.

## Provenance

- Simple Icons via jsDelivr: OpenAI, Anthropic/Claude, Google Gemini, DeepSeek,
  NVIDIA, OpenRouter, Hugging Face, Mistral, Cloudflare, Vercel, Amazon, Azure,
  GitHub Copilot, MiniMax, Xiaomi, LM Studio, Ollama, and their provider aliases.
- Official provider sites: Ant Ling, Fireworks, Groq, Together, Z.AI, OpenCode,
  Kimi/Moonshot, and their regional or product aliases.
- Wikimedia Commons: xAI and Grok.
- Lobe Icons static SVG package: Cerebras, replacing an incorrect OpenAI asset
  in the supplied folder.

The complete acquisition notes remain in the original bundle's `README.md`.
All marks remain the property of their respective owners.
