# Model Insights

Status: Partial

## Goal

Give Aiden's Personal Model Pad trustworthy, source-aware benchmark evidence without making a benchmark vendor the model catalog, adding hidden network activity, or letting public scores alter provider availability and runtime limits.

## Shipped in this milestone

- A manual-only OpenRouter Data API integration uses its own encrypted Model Pad credential. It never creates an inference provider, discovers OpenRouter's catalog, or adds OpenRouter models to the user's list.
- The fixed Artificial Analysis benchmark query is timeout-bound, response-size-bound, schema-validated, and published atomically to a device-local `0600` cache.
- The fixed query is `/api/v1/benchmarks?source=artificial-analysis&max_results=500`. The cap was raised from 100 to 500 because the endpoint has no paging (no offset, page, or cursor parameter), so one request must return every row; the 2 MB response limit still leaves a realistic 500-row response at about 20% of the budget. Duplicate permaslugs in a response are dropped and counted; a stored cache that contains them is treated as invalid.
- Connect & fetch validates a candidate key before publishing it, failed fetches leave the last known good public cache untouched, and disconnect removes both the dedicated key and cache.
- Ordinary model reads remain offline and attach source-aware benchmark evidence separately from Pi/provider/models.dev capability metadata.
- Version-stamped and vendor-reordered benchmark identities normalize through the bundled models.dev provider ID/name authority. Catalog-backed gateways may inherit only a unique underlying identity; ambiguous aliases and unrecognized custom providers fail closed.
- Model Pad suggestions can use Intelligence, Coding, or Agentic score percentiles. Because this endpoint has no response-speed measure, OpenRouter suggestions set capability only and use deterministic, collision-free horizontal packing for readability while keeping pace explicitly unmeasured.
- Dense Pads use a wider marker-first surface with 24 px interaction targets and model details on hover, focus, or selection instead of permanently overlapping name pills. Personal and benchmark-assisted placements have distinct marker treatments, edge-aware labels, keyboard movement, and Escape dismissal.
- The settings view is canvas-first: browsing models and benchmark insights are mutually exclusive one-click disclosures, with interruptible reduced-motion-aware transitions, source-accurate OpenRouter branding, and quiet outline-free benchmark framing; destructive and unavailable-model management stays collapsed by default.
- Saved Pad layouts migrate from one provenance flag to independent X/Y provenance, so personal edits and benchmark-derived axes remain distinguishable.
- Hover details show the underlying scores and Artificial Analysis-via-OpenRouter attribution without attributing unrelated models, plus the models.dev list price (hosted, per-token, catalog-backed providers only), "Your speed" from device-local measured pace with its run count, and an "over 60 days old" flag on the benchmark date. The Settings benchmark connection likewise suggests Fetch latest once its snapshot is over 60 days old; nothing refetches automatically.
- A device-local pace signal is measured from the user's own chat responses: per model response, time to first text or thinking token (from the moment Pi issues that model request) and output tokens per second (from the first delta to the response end). Only completed responses with at least 16 output tokens and 250 ms of generation count; responses that stop at the length limit (or error or abort) don't count, hidden reasoning tokens are excluded from tokens per second when no thinking was streamed, and ACP harness agents (such as Google Antigravity) aren't timed because they run a full agent rather than one model request. The last 20 samples per `provider::model` (500 models at most) live in `userData/model-pace.json` (`0600`, invalid files read as empty, writes debounced and flushed on quit); medians are exposed over `modelPace:summaries` / `modelPace:clear`, onboarding reset deletes the file, and nothing is transmitted or used for routing. Shipped (Tasks 21-22 of the Model Pad overhaul): Settings can set a placed model's horizontal pace from its measured speed once it has three runs, and the composer's model detail card shows "Your speed" with its run count.
- The legacy direct Artificial Analysis settings, renderer IPC surface and model-read display path are retired: model info no longer carries an Artificial Analysis ranking or metadata source, and production reads never load its historical cache. Its local runtime remains only for historical credential/cache cleanup during onboarding reset and the CLI's explicit `aiden insights aa` command.

## Remaining

- Consider additional benchmark sources only when they can preserve exact model identity, explicit provenance, licensing, and metric-specific semantics.
