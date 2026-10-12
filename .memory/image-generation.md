# Image Generation registry (Task 1 core, 2026-10-12)

Plan: `docs/plans/image-generation-settings-plan.md`.

- Main code: `main/services/image-generation/`. `runtime-main.ts` exports the app singleton `imageGeneration` (an `ImageGenerationRuntime`); `runtime.ts` is the injectable core.
- Consumers use `imageGeneration.models` (`Pick<Models, "getAvailableOfType" | "getModelOfType" | "getModelsOfType" | "generateImages">`). Disabled models are never registered with the Pi registry, so every lookup hides them. `generateImages` dispatches the registered model, never the caller's object. `getModelOfType` is sync: call `await imageGeneration.ready()` (or any async method) first.
- Keys: the credential view (`credential-view.ts`) maps provider `p` to `aiden-internal:image-gen:<p>` and has slots only for `openrouter`, `replicate`, `fal`. The only ambient fallbacks are `AIDEN_IMAGE_OPENROUTER_API_KEY`, `AIDEN_IMAGE_REPLICATE_API_TOKEN` and `AIDEN_IMAGE_FAL_KEY`. Keys are validated locally (trim, 8–512 printable ASCII, no spaces) with no network call.
- Catalog: curated Replicate and fal data plus `inferImageModelMaker` live in `renderer/shared/image-generation/catalog.ts`. OpenRouter's curated list is Pi's bundled `openrouter` image models minus `openrouter/auto*`. Precedence is curated, then custom, then fetched. Fetched models start disabled; curated and custom start enabled. Choosing a default turns that model on.
- Settings file: `image-generation-settings.json` (0600, validated on read, invalid file falls back to defaults with one logged warning). It never holds keys.
- Adapters: `replicate-images.ts` (`Prefer: wait=60`, polling, cancel, uploads refs over 256 KB via `/v1/files`, downloads only from `replicate.delivery`) and `fal-images.ts` (queue submit, status, response; cancel via PUT; follows only `https://queue.fal.run` URLs; downloads only from `fal.media`). Both never reject and scrub the key from echoed provider details. Overall 5-minute limit.
- Not verified against live APIs: fal `X-Fal-Store-IO` header and `cursor` query parameter, Replicate collection `latest_version.openapi_schema` presence, and the reference fields of some curated models (only listed where known). `recraft-ai/recraft-v4.1-svg` was left out because it returns SVG, which the output validator rejects.
- IPC: `imageGeneration:*` (state, setKey, removeKey, setModelEnabled, setDefaultModel, addCustomModel, removeCustomModel, fetchModels); parsers in `main/handlers/image-generation-parse.ts`; client `imageGenerationApi` in `renderer/lib/ipc.ts`; shared types in `renderer/shared/image-generation/types.ts`.
- Onboarding reset calls `imageGeneration.clearAll()` (keys plus settings).
- Tests: `npm run test:image-generation`.
