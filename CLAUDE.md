# Aiden Agent

Aiden Agent is a privately owned Electron application. Its only source repository is `https://github.com/sambitcreate/aiden-agent`.

## Project memory

The `.memory/` folder contains context and history from previous work on this project. Read the relevant files there before making changes, and keep them updated when work changes the implementation, architecture, decisions, or status.

## UI design references

Before adding or materially restyling any UI element or component, always review both `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` for interaction, styling, state, motion, and accessibility inspiration. Adapt the references to Aiden's existing visual language rather than copying them blindly, and use the semantic design tokens in `renderer/styles.css` and `renderer/shared/appearance.ts` instead of introducing one-off colors.

## Release model metadata

models.dev may be contacted only by `npm run models:refresh`, the release refresh invoked by `npm run dist`, the scoped post-merge catalog workflow, or the user-initiated foreground **Update model catalogs** action in Settings → Providers. The live action may request only the fixed `https://models.dev/api.json` endpoint without credentials, cookies, prompts, chats, selections, custom endpoints, or a device identifier; its validated device-local cache is display-only and must never change runtime limits, routing, or selectable inventory. Never add a models.dev call to startup, normal development, unpacked builds, ordinary live-app reads, onboarding navigation, or background polling. Artificial Analysis data and credentials must never be bundled: the live Electron app may contact its fixed Free endpoint only after the user explicitly chooses Connect & fetch or Fetch latest with their own key, then reads the normalized device-local cache offline.

## Papercuts

For complex workflows, record concise implementation friction in `.papercuts/troubleshooting.md` as it occurs.

## Tests

When adding a feature or changing behavior, layout, configuration, or contracts, always check whether existing tests need updating and add or extend tests when coverage is missing. Run the relevant suites before finishing (`npm run test`, or the narrower scripts in `package.json` when the change is scoped). If a new test file is added, register it in the appropriate `package.json` test script so CI picks it up.

"Contracts" means behavioral or API contracts: function outputs, IPC register-and-invoke, and rendered UI (including Playwright). It does not mean grepping production source text.

Changes to shared server contracts or transcript/activity UI must also be checked against both native clients. Inspect iOS and Android consumers, update their implementations and focused tests when behavior is shared, and run the applicable mobile suites even when the originating change is on desktop or server.

When writing or extending tests (TDD or otherwise): tautological tests are harmful. Do not assert the same expression or logic as the system under test, loop an exported constant list through a guard defined from that list and only expect true, or assert that a mock was called with exactly the object the test just constructed with no independent invariant.

Change-detector tests are harmful. Do not lock incidental implementation: exact Tailwind or `className` strings, full JSX snippets, CSS keyframe bodies, private setter call text, rename-sensitive helper spellings, or large snapshots of strings or DOM with no behavioral claim.

Do not create regression tests for bug fixes without a genuine gap in behavior testing. A test must reproduce the user-visible or API-visible failure mode, or provide an independent oracle for the fixed invariant. `doesNotThrow`, "still works", and ticket-ID-only stubs are not enough. Prefer extending an existing behavioral suite over a one-off that only locks the fix's source shape.

Do not add or extend tests that `readFileSync` production `.ts` / `.tsx` / `.css` (or handler sources) and `assert.match` / `assert.doesNotMatch` / substring counts against that source as the primary oracle. Prefer calling the real function with fixtures; rendering (`renderToStaticMarkup` / Testing Library) and asserting structure or behavior; Playwright e2e for user-visible flows; and, for IPC, register-and-invoke or AST-based channel inventory rather than grepping channel string literals out of handler files. Existing `*contract*.test.ts` files that already grep source may stay until a follow-up cleanup. Do not grow them. When you change a surface that is only covered by a source-grep contract, replace or supplement that coverage with a behavioral test in the same PR rather than adding more `assert.match` lines.

House-style examples to emulate (do not rewrite these files as part of instruction-only work): `renderer/lib/chat-message-queue.test.ts`, `main/services/portable-config-core.test.ts`, `main/services/data-store.resilience.test.ts`, and focused parse/validate handler tests that call parsers.
