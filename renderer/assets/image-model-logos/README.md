# Image model logo assets

Compact monochrome marks for image-generation providers (Replicate, fal) and
the makers of the image models they host. They are used only by the Image
Generation settings page and the Create Images model picker, render through the
same CSS-mask treatment as `ProviderIcon` so they follow Aiden's semantic text
colors, and are bundled by Vite through explicit static URLs.

Makers that already have a mark in `../provider-logos/` (OpenAI, Google, xAI,
NVIDIA, MiniMax, DeepSeek, OpenRouter) reuse that file instead of duplicating it.
These files are desktop-only and are not part of the iOS/Android provider-logo
parity set.

## Provenance

All files come from `@lobehub/icons-static-svg@1.95.1` (MIT, Copyright 2023
LobeHub), `https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/<name>.svg`.
Each was checked to be a plain `<svg>` with no scripts, event handlers, external
references, embedded images or `foreignObject`.

Makers without an openly licensed mark (Sourceful/Riverflow, HiDream, QuiverAI,
inclusionAI, Leonardo, Higgsfield, Playground, Wan) intentionally have no asset
and use the neutral initial fallback.

All marks remain the property of their respective owners and are used only to
identify the provider or model maker.
