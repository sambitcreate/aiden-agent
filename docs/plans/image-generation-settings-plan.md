# Image Generation settings, providers and conversation-mode images

Status: in progress (2026-10-12) on `feature/image-gen-tool-conversation-cb306a`.

## Goal

Give image generation its own Settings page, its own API keys and its own model
inventory, separate from chat/workspace providers, with three providers
(OpenRouter, Replicate, fal) and maker logos. The chat `generate_image` tool,
the Create Images canvas, and plain conversations with no workspace folder all
draw from it.

## Owner decisions (2026-10-12)

1. **Fully separate keys.** Image generation uses only keys entered on the new
   page. An OpenRouter key in Settings → Providers never authorizes image
   generation, and an image key never authorizes chat. No fallback, no reuse
   toggle.
2. **Curated + manual fetch.** Each provider ships a bundled, offline curated
   list. A user-pressed **Fetch latest models** per provider caches a
   device-local list. Users can add a custom model id.
3. **Consumers.** Chat `generate_image`, Create Images, and folderless
   conversations.
4. **Logos** match `ProviderIcon` (monochrome CSS-mask marks, neutral initial
   fallback).
5. **Architecture A.** A dedicated image-only Pi `Models` instance with its own
   credential namespace (not the shared `providerRegistry.models`).

## Architecture

### Image registry (main)

`main/services/image-generation/` owns a second Pi registry:

- `imageModels = createModels({ credentials: imageCredentialStore })`.
- `imageCredentialStore` is a namespaced `CredentialStore` view over the
  existing encrypted `piCredentialStore`. Provider id `p` maps to stored id
  `aiden-internal:image-gen:<p>`. `list()` returns only the image namespace. The
  view must never read or write an id outside its namespace. This is what makes
  the separation structural: the image registry cannot see `openrouter`.
- Three providers are built with `createProvider`, each with auth that reads
  **only** the stored credential. The only ambient fallback is a dedicated env
  var: `AIDEN_IMAGE_OPENROUTER_API_KEY`, `AIDEN_IMAGE_REPLICATE_API_TOKEN` or
  `AIDEN_IMAGE_FAL_KEY`. Never `OPENROUTER_API_KEY`.
  - `openrouter`: models are Pi's bundled OpenRouter image models (the
    `type: "image"` models of the built-in openrouter provider, minus
    `openrouter/auto*`). Implementation: `openrouterImagesApi()` from
    `@earendil-works/pi-ai/api/openrouter-images.lazy`.
  - `replicate`: Aiden image API `replicate-images`.
  - `fal`: Aiden image API `fal-images`.
- Model inventory per provider is the curated list plus the cached fetched list
  (deduped by id, curated wins), plus user custom ids. Disabled models are
  filtered out of `getAvailableOfType("image")` for consumers.

### Provider adapters (never reject; return `stopReason: "error"`)

**Replicate** (`Authorization: Bearer`, `https://api.replicate.com/v1`):

- Create: `POST /models/{owner}/{name}/predictions` with `Prefer: wait=60`.
- Poll: `GET /predictions/{id}` about every 1.5 s until `succeeded`, `failed` or
  `canceled`.
- Abort: `POST /predictions/{id}/cancel`.
- Output is a string or an array of HTTPS URLs. Download them immediately, since
  prediction data is removed after about an hour. Only `replicate.delivery` and
  its subdomains are allowed, with `redirect: "error"`.
- Reference images go in as data URIs when they are 256 KB or smaller. Larger
  ones are uploaded through `POST /files`.
- The reference-image input field differs by model (`image_input`, `images`,
  `image`, `input_images`). It comes from curated metadata or, for fetched
  models, from the OpenAPI input schema.

**fal** (`Authorization: Key`):

- Queue submit: `POST https://queue.fal.run/{endpoint}` with
  `{prompt, num_images:1, sync_mode:true, ...}` and the header
  `X-Fal-Store-IO: 0`.
- Poll `status_url` until `COMPLETED`, then `GET response_url`.
- Abort: `PUT cancel_url`.
- Images arrive as data URIs or fal CDN HTTPS URLs. Download those only from
  `fal.media` and its subdomains.
- A logical model maps to a text endpoint and an optional edit endpoint. The
  edit endpoint is used when reference images are present. References go in as
  `image_urls` (data URIs) or `image_url`, according to metadata.

Shared rules:

- Output is validated with the existing `parseGeneratedImages`.
- All bodies are bounded (`readBoundedBody`). Errors are redacted (never echo
  keys).
- The overall time limit is 5 minutes.
- Cost is reported as unpriced (zeros), as Concentrate does.

### Catalogs

- **Curated data** lives in a renderer-safe module
  (`renderer/shared/image-generation/catalog.ts`). Each entry has id, name,
  maker slug, `acceptsReferenceImages` and adapter metadata. There are about 25
  entries for Replicate and about 20 logical models for fal (see the research
  list in the PR description). OpenRouter comes from Pi's bundled data.
- **Fetch latest** runs only when the user presses the button, against a fixed
  endpoint, with bounded size and page count, and the result is saved
  device-local:
  - OpenRouter: `GET https://openrouter.ai/api/v1/models?output_modalities=image`
    (no credentials).
  - fal: `GET https://api.fal.ai/v1/models?category=text-to-image&status=active`.
    `image-to-image` is also fetched to pair edit endpoints. The fal key is sent
    if one is set.
  - Replicate: `GET /v1/collections/text-to-image` with the key. If no key is
    set, the button is disabled with an explanation.
- Nothing fetches on startup, in the background, or during onboarding. AGENTS.md
  gains a paragraph that says so.

### Settings store and IPC

- A `DataStore` file `image-generation-settings.json` (mode 0600) holds the
  enabled/disabled model ids per provider, the default model, custom ids, and
  the fetched cache with `fetchedAt`. Keys never go in this file.
- IPC channels, prefix `imageGeneration:`, allowlisted in preload, with a
  `imageGenerationApi` client in `renderer/lib/ipc.ts`:
  - `imageGeneration:state` returns providers with redacted status,
    `{connected, source: "stored"|"env"|null}`, models with enabled flag and
    maker, the default model, and `fetchedAt`.
  - `imageGeneration:setKey`, `imageGeneration:removeKey`.
  - `imageGeneration:setModelEnabled`, `imageGeneration:setDefaultModel`.
  - `imageGeneration:addCustomModel`, `imageGeneration:removeCustomModel`.
  - `imageGeneration:fetchModels` (per provider, user-initiated).
- Keys go in only and are never returned. Input is parsed at the handler
  boundary.
- Onboarding reset clears the image keys and the settings file.

### Consumers

- **Chat.** `createPiModelTools` receives the image registry for image
  operations. `classify` keeps using the shared registry and its local
  classifier models. `list_operation_models` lists only enabled image models.
  `generate_image` refuses a disabled or unknown model. The extension system
  prompt names the default image model.
- **Conversation mode.** A new gate, `shouldEnableImageGeneration`, has the same
  scope as display-image minus the workspace requirement. In a folderless chat
  the model-operations extension and generated-image presentation are enabled
  without `display_image`, which still needs a workspace. The display-image
  runtime accepts a missing workspace root and then omits only `display_image`.
  Approval is unchanged (disclosure approval always).
- **Create Images.** `create-images/main.ts` wires the port to the image
  registry. The model picker shows maker logos and the empty state "Add an image
  key in Settings → Image Generation." The E2E spec switches to
  `AIDEN_IMAGE_OPENROUTER_API_KEY`.

### Renderer

- **Settings section** `imageGeneration`, titled "Image Generation", group
  "Agent", with an ImageIcon nav icon. Its keywords include image, replicate,
  fal, openrouter, flux, nano banana, keys.
- **The page** follows `docs/settings-design-system.md`:
  - Intro with the privacy line: keys are encrypted on this Mac and used only
    for image generation.
  - **Providers** card: one row per provider with logo, status badge and key
    actions (add, replace, remove, with a confirm dialog), plus **Fetch latest
    models** and a "last fetched" line.
  - **Default model** select, with logos.
  - **Models** card: search field and provider filter. Each row shows the maker
    logo, the name, the id as secondary text, a "Reference images" tag when
    supported, and an enable switch. There is also an "Add model by ID" form.
- **`ImageModelLogo`** maps the maker slug to `renderer/assets/image-model-logos/`
  or reuses `provider-logos/`, with the same mask treatment as `ProviderIcon`
  and the initial fallback. The maker is inferred from the model id prefix or
  owner, with curated entries stating it explicitly.
- **Onboarding.** The provider step gets a one-line note that image generation
  keys live in Settings → Image Generation.

## Tasks

1. **Core (main).** Credential view, providers and adapters, catalogs, settings
   store, IPC, preload, `ipc.ts` client, onboarding reset, AGENTS.md network
   paragraph, tests. Done 2026-10-12 (see `.memory/image-generation.md`).
2. **Consumers (main).** Chat wiring, conversation mode, Create Images port,
   E2E env, tests. Done 2026-10-12 (see `.memory/image-generation.md`).
3. **Renderer.** Settings page, registration, logos component, Create Images
   picker logos and copy, onboarding note, tests.
4. **Review.** Two independent Opus reviews (correctness/edge cases/blast
   radius; efficiency), then fixes.
5. **Verify.** Narrow suites, typecheck, lint, then launch the app.

## Out of scope

- Size and aspect-ratio controls on `generate_image`.
- Pricing display.
- Mobile clients. The transcript contract is unchanged, and conversation images
  use the existing attachment path.
- Direct OpenAI or Google image APIs.
