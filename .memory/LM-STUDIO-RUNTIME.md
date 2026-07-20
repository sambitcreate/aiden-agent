# LM Studio and custom local-provider runtime — 2026-07-20

- Keyless providers resolve to the in-memory, non-secret `aiden-local-no-auth` compatibility credential required by Pi's OpenAI-compatible adapter. It is never persisted and gives Settings discovery/testing, chat, and title generation the same request shape.
- The Pi stream bridge reads terminal errors and assistant text per assistant turn. A terminal-only response is retained, cancelled turns remain non-errors, and terminal failures pass already-streamed text to the renderer so it is saved as an interrupted response.
- Saving a provider now treats an endpoint/protocol/auth-mode change as a credential boundary: the old key is removed before the new connection is persisted and is never restored on a later save failure. Test/model discovery can reuse a saved key only for the same connection.
- Custom providers default to a keyless local connection and expose an explicit, accessible `API key required` toggle. Changing endpoint, protocol, auth mode, or key invalidates discovered models and requires another test/refresh before saving. Zero-model providers can still be saved with clear recovery guidance.
- Workspace file tools canonicalize real paths before exposing or mutating files. They reject external and dangling symlink targets, and `.env` files remain excluded from model-visible read/glob/grep results.

## Verification

- Focused runtime, provider-policy, model-discovery, and filesystem tests cover the repaired paths.
- Three independent post-implementation reviews found and closed key-rotation, streamed-partial, stale-discovery, custom-local-auth, and symlink-edge cases.
- Live Electron smoke: the development UI displayed LM Studio as local; an unsaved custom localhost connection began keyless and exposed the auth toggle correctly.
