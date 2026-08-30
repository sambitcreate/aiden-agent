# Model Insights

Status: Partial

## Goal

Give Aiden's Personal Model Pad trustworthy, source-aware benchmark evidence without making a benchmark vendor the model catalog, adding hidden network activity, or letting public scores alter provider availability and runtime limits.

## Shipped in this milestone

- A manual-only OpenRouter Data API integration uses its own encrypted Model Pad credential. It never creates an inference provider, discovers OpenRouter's catalog, or adds OpenRouter models to the user's list.
- The fixed Artificial Analysis benchmark query is timeout-bound, response-size-bound, schema-validated, and published atomically to a device-local `0600` cache.
- Connect & fetch validates a candidate key before publishing it, failed fetches leave the last known good public cache untouched, and disconnect removes both the dedicated key and cache.
- Ordinary model reads remain offline and attach source-aware benchmark evidence separately from Pi/provider/models.dev capability metadata.
- Version-stamped and vendor-reordered benchmark identities normalize through the bundled models.dev provider ID/name authority. Catalog-backed gateways may inherit only a unique underlying identity; ambiguous aliases and unrecognized custom providers fail closed.
- Model Pad suggestions can use Intelligence, Coding, or Agentic score percentiles. Because this endpoint has no response-speed measure, OpenRouter suggestions set capability only and use deterministic, collision-free horizontal packing for readability while keeping pace explicitly unmeasured.
- Dense Pads use a wider marker-first surface with 24 px interaction targets and model details on hover, focus, or selection instead of permanently overlapping name pills. Personal and benchmark-assisted placements have distinct marker treatments, edge-aware labels, keyboard movement, and Escape dismissal.
- The settings view is canvas-first: browsing models and benchmark insights are mutually exclusive one-click disclosures, with interruptible reduced-motion-aware transitions, source-accurate OpenRouter branding, and quiet outline-free benchmark framing; destructive and unavailable-model management stays collapsed by default.
- Saved Pad layouts migrate from one provenance flag to independent X/Y provenance, so personal edits and benchmark-derived axes remain distinguishable.
- Hover details show the underlying scores and Artificial Analysis-via-OpenRouter attribution without attributing unrelated models.
- The legacy direct Artificial Analysis settings and renderer IPC surface are retired, and ordinary production model reads no longer load its historical cache. Its local runtime remains only for historical credential/cache cleanup during onboarding reset.

## Remaining

- Add an optional device-local pace signal based on the user's own observed sessions; do not infer speed from the capability-only benchmark endpoint.
- Consider additional benchmark sources only when they can preserve exact model identity, explicit provenance, licensing, and metric-specific semantics.
