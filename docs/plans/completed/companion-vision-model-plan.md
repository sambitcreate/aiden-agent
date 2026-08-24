# Companion Vision Models

**Status:** Complete  
**Owner:** Aiden Agent  
**Scope:** macOS runtime and Bot editor, Aiden Remote API, iOS Bot editor and chat

## Outcome

Images are a first-class input even when a Bot's chosen conversational model is text-only. A Bot keeps one primary model for its replies and may bind one explicit companion vision model that is used only to inspect attachments. Vision-capable primary models continue to receive images natively.

## Product contract

- The primary model remains the Bot's identity and response model. Aiden never silently swaps it.
- Selecting a text-only primary model in New/Edit Bot reveals a required **Image understanding** choice. Aiden may suggest the first available vision-capable model, but the person sees and confirms the provider and model before saving.
- Selecting a vision-capable primary model hides and clears the companion because images use the native path.
- Existing text-only Bots without a companion remain usable for text. Choosing or sending an image presents an actionable prompt that opens Edit Bot; no attachment is consumed until admission succeeds.
- Bot details and review surfaces say whether images are read by the primary model or the named companion model. Provider credentials remain on the Mac.
- The same image-analysis implementation belongs to the base agent tool layer. Bot runtime authority decides whether it is admitted for a particular turn.

## Security and privacy invariants

1. The image tool accepts only an opaque attachment ID from the current authoritative chat snapshot. It never accepts a URL, client filesystem path, or arbitrary Mac path.
2. The Mac resolves the attachment, MIME type, size limits, and exact bytes. The iOS client cannot name provider credentials or runtime bindings.
3. A companion call is tool-free, bounded, cancellable, and pinned to the saved provider/model/credential incarnation. It cannot use shell, files, connections, skills, or subagents.
4. A policy lease is revalidated immediately before the provider effect. Editing either model or its credentials invalidates stale turns.
5. Raw image bytes go only to the explicitly selected image-capable model. The text-only primary receives only the bounded textual analysis returned by the tool.
6. There is no automatic cross-provider fallback. Errors are classified without exposing credentials, paths, headers, or raw provider payloads.
7. Native image routing remains the fast path when the primary model advertises image input. Capability decisions use Aiden's normalized model metadata, never model-name guesses.

## Phases

### Phase 1 — Capability and persistence contract

- Add explicit image capability to Bot catalog model options.
- Add an optional companion vision selection to Bot create/update/detail contracts.
- Persist an exact main-owned companion binding alongside primary Bot authority and include it in revision/epoch comparisons.
- Read previous Bot capability documents additively without inventing companion authority for existing Bots.

### Phase 2 — Runtime routing and image tool

- Introduce a reusable base-agent `inspect_image` tool implementation.
- Build its allowlist from current main-owned message attachments and expose it only when the primary model is text-only and companion authority is valid.
- Invoke the companion through the existing provider runtime with no tools, conservative output/token/time bounds, usage accounting, cancellation, and sanitized failures.
- Preserve native multimodal messages for vision-capable primary models.

### Phase 3 — Remote admission and projections

- Extend Bot details and catalog projections additively.
- Let Bot image sends pass only for `native` or `companion` routing computed by the Mac at admission time.
- Return a stable setup-required error for text-only legacy Bots with no companion, before one-shot upload consumption.
- Keep protocol fixtures, OpenAPI, TypeScript parsers, Swift decoders, and compatibility tests aligned.

### Phase 4 — macOS affordances

- In New/Edit Bot, show image capability next to the primary model.
- For a text-only primary, reveal provider/model controls under **Image understanding**, preselect a valid suggestion, explain when it is used, and require a valid vision model before save.
- Show native/companion image routing in Review without exposing private bindings.
- Use existing semantic tokens, controls, focus behavior, and reduced-motion rules.

### Phase 5 — iOS affordances

- Mirror the Mac editor contract and explanation in New/Edit Bot.
- Keep Photo Library available when the Bot has native or companion image support.
- For an unconfigured legacy Bot, present a setup prompt with **Edit Bot** and **Not Now**, preserving the draft and attachment.
- Reuse the shared chat composer and existing image cache; do not add a per-message model selector.

### Phase 6 — Verification and release

- Cover storage migration, binding drift, lease invalidation, attachment-ID confinement, native and companion routing, provider failures, output bounds, and pre-consumption admission.
- Cover Mac and Swift editor selection/rebase/save rules plus iOS setup prompting.
- Run focused TypeScript and Swift tests, release/source gates, and a physical iPhone 13 Pro build.
- Obtain two independent post-implementation reviews, remediate findings, commit scoped files, and upload a new internal TestFlight build.

## Rollout and observability

- Record companion calls under a distinct local usage source so cost and failures are diagnosable without retaining image bytes.
- Existing Bots migrate as text-capable only; no provider is selected on their behalf in durable state. The editor can suggest a companion when the person next edits the Bot.
- If companion resolution fails, the primary turn receives a concise tool failure and may explain that image inspection is unavailable; Aiden does not loop or retry across models.
- Rollback removes the UI selection and tool admission while leaving the optional stored binding inert and parseable.

## Acceptance criteria

- A text-only Bot with a saved companion can answer a question about an iOS photo without changing its primary model.
- A vision-capable Bot receives the original image natively and does not make a companion call.
- A text-only Bot without a companion cannot consume an uploaded image and offers a direct route to configure one.
- A model/credential change during a turn prevents the stale companion call.
- Neither the primary model nor a remote client can make the tool read an image outside the current chat.
- Mac and iOS present the same saved primary/companion pair and survive conflict refresh/rebase.
