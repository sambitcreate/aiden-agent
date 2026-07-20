# LM Studio and custom local-provider runtime — 2026-07-20

- Keyless providers use the in-memory, non-secret `aiden-local-no-auth` compatibility token only inside Pi's current OpenAI-compatible adapter. It is never persisted or sent: chat and generated-title streams add `Authorization: null` (and `x-api-key: null` for Anthropic-compatible endpoints), while Settings discovery sends no auth header at all.
- The Pi stream bridge reads terminal errors and assistant text per assistant turn. A terminal-only response is retained, cancelled turns remain non-errors, and terminal failures pass already-streamed text to the renderer so it is saved as an interrupted response.
- Saving a provider now treats an endpoint/protocol/auth-mode change as a credential boundary: the old key is removed before the new connection is persisted and is never restored on a later save failure. Test/model discovery can reuse a saved key only for the same connection.
- LM Studio and Ollama default to no authentication but expose the same explicit `No authentication` / `API key` selector as custom endpoints. The provider menu also creates a keyless-by-default Tailscale OpenAI-compatible connection; Tailscale reachability and application-layer authentication remain separate choices. Changing endpoint, protocol, auth mode, or key invalidates discovered models and requires another model discovery before saving. Zero-model providers can still be saved with clear recovery guidance.
- Workspace file tools canonicalize real paths before exposing or mutating files. They reject external and dangling symlink targets, and `.env` files remain excluded from model-visible read/glob/grep results.

Capability metadata is loaded from a static release-bundled snapshot, so local LM Studio, Ollama, and Tailscale chats never trigger a public catalog request. The release command alone refreshes that snapshot.

## Verification

- Focused runtime, provider-policy, model-discovery, and filesystem tests cover the repaired paths.
- Three independent post-implementation reviews found and closed key-rotation, streamed-partial, stale-discovery, custom-local-auth, and symlink-edge cases.
- Live Electron smoke: the development UI displayed LM Studio as local; an unsaved custom localhost connection began keyless and exposed the auth toggle correctly.
