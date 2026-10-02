# Pi 1.0 upgrade (2026-10-02)

Baseline Aiden origin/main `d2197dfef`; upstream pi pulled to `581e7ba78`, stable release v1.0.0 `a13d35a742`. Published 1.0 is the target, not Unreleased HEAD. See `docs/plans/pi-1-parity-plan.md` for the complete inventory, merge sequence and evidence.

Eight open PRs form a normal-merge stack: #299 → #302 → #301 → #304 → #303 → #306 → #305 → #307. Only three task worktrees were used. No PR is merged. The superseded separate CLI PR #300 was closed after CI showed root/CLI pins must change atomically.

Live Agent/Models and CLI are pinned to 1.0. Pi removed experimental journal helpers; the named frozen 0.87.1 compatibility dependency preserves Aiden journals without replacing remote/security contracts. CLI migration separates Aiden array MCP config from native Pi object config and preserves revocation readers, worker permissions and WASM packaging.

Desktop adds approved codemode and bounded discovery, stable private OpenAI login identity, MCP metadata/OAuth/result parity, model-specific compaction budgets, off-default foreground cache warming, approved image/classifier operations with current-chat references, and explicit custom-local llama.cpp classifier opt-in. Provider-backed MCP requires a separate encrypted device-local exact-endpoint grant; per-operation isolated clients revoke authority before closing and cannot serve background/Bot/child/Remote runs. MCP pagination is bounded and validates all pages' output schemas/task requirements. Raster resource reads reuse bounded result validation without writing arbitrary binary files.

Shared activity IDs remain public call-N/tool-N; nested raw IDs stay internal. Chat pickers exclude image/classifier records; models.dev and benchmarks retain manual/release-only policy. Native protocols remain unchanged.

Validation: combined full Node 22 suite passed 8,521 TAP cases (8,516 pass, 5 skip) plus 41 Rust tests. Root types/lint/build, CI policy, native iOS230/Android62, actual Electron worker and synthetic unsigned ASAR smoke passed. Later focused acceptance covers resource images, server-description search, platform onboarding disclosures and keyboard/gallery layout at three widths. No signed package, physical device or live paid-provider test is claimed.

Final CI corrections: narrow runtime/subagent lane needed its own VCC worker build prerequisite (full npm test had masked it); a device E2E assertion matched adb inside a random hexadecimal session ID and now uses word boundaries with the exact fixture. A renderer CI job failed during npm ci with esbuild EBADMACHO before tests. Updated hosted checks remain separate from green local evidence.

Deliberate desktop differences: fixed codemode budgets and sequential admitted host effects, no Pi-specific models.* sandbox API/options, no dynamic direct-tool activation/per-tool exposure editor, no idle warming or full llama.cpp router manager, no arbitrary binary-resource temp writes. These stable capabilities remain available in the upgraded CLI. Experimental durable/virtual-model/protocol replacements and post-release features are excluded.
