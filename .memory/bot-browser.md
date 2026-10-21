# Bot browser and credential boundary — 2026-10-21

Plan: `docs/plans/bot-handoffs-rules-computers-plan.md` §5.1 (package P6). Branch `wp/p6-browser`, on top of P1 (hand-offs), P3 (rules) and P4. User doc: `docs/environment-browser.md` "A Bot's own browser".

## Profile and workspace
- `main/services/browser/bot-profile.ts`: profile id `bot:<botId>` (a real id gives `bot:bot:<uuid>`), partition `persist:aiden-bot-<botDirectoryName>`. `botDirectoryName` validates the id.
- `bot-workspaces.ts`: main-only registry from a Bot's managed workspace to its Bot. Registered by `bot-browser-tools.ts` `candidates()` and by `botBrowserWorkspace()` (the panel's `bots:browser:workspace`). Renderer input never registers one.
- `service.ts`:
  - `create` forces the Bot profile for a Bot workspace; any other workspace asking for a `bot:` profile is refused. `close()` never resolves `this.profile()` for Bot ids.
  - `runCommand` admits registered Bot workspaces. An agent command on a Bot workspace must carry `credentialBoundary`, and a boundary command must be an agent command on a Bot workspace.
  - Boundary refusals: `evaluate`, `record_*`, `open_file`, annotation actions, `screenshot`, `devtools`; any `selector`/`locator` probing `value` (`assertBoundarySelector`). `import_cookies` into a Bot profile is refused for everyone.
  - `hold` / `release` (by hold id) set `BrowserTab.heldForPerson {reason}`; agent commands on a held tab throw `BROWSER_HELD_TAB_REFUSED`.
  - `transferOwner`, `hasOwner`, `probeAgentTarget`, `closeBotTabs`, `clearBotProfile`, `agentAccessDefaultAllowed`. `BrowserCommandContext` is exported.
- `files.ts` refuses Bot workspaces (403).
- `main/handlers/browser.ts` `browser:get-state`: a Bot workspace moves ownership to the asking document (`transferOwner`), so the window showing the Bot owns its browser.

## Credential boundary (`credential-fields.ts`, `credential-mask.ts`, `credential-boundary.ts`)
- Sensitive: `input[type=password]`, autocomplete `current-password`, `new-password`, `one-time-code`, `cc-*` (section-, shipping, billing, home, work … prefixes ignored). The walker reads `DOM.getDocument({depth:-1, pierce:true})` through `CdpPort.call` (renamed from `send` so the IPC contract test doesn't read `port.send("DOM.…")` as a notification).
- Text: `scrubBrowserSnapshot` drops a sensitive field's AX value and its subtree; the element entry keeps label and placeholder.
- Image: boxes read before and after capture, union painted gray (0x8a) in main, then `redactBrowserData`. The image is dropped with a `BROWSER_IMAGE_OMITTED` note when a **visible** opaque frame (cross-site iframe; OOPIF masking is not supported), pinch zoom, a navigation or a scroll change happened.
- Selectors: `assertBoundarySelector` refuses CSS/Playwright `[value…]` (checked as written and with CSS comments removed), any XPath attribute step that isn't one plain non-`value` name (`@*`, `attribute::*`, `@node()`, namespaced), and backslash escapes, in main and in `bot-browser-approval.ts` before the probe runs the selector. The Chromium oracle test in `credential-fields.test.ts` proves each refused form really distinguishes a value.
- `scrubBrowserSnapshot` also replaces a sensitive element's text-engine selector (`internal:text="…"`, which Playwright generates for a textarea with content) with a structural one.
- Held tabs: `Network.responseReceived` and `console-message` are not recorded while `tab.hold` is set, so a released tab's snapshot never replays the person's sign-in (e2e `heldTraces`).
- Typing guard: `browserTypingGuardSource` refuses a sensitive named target and a sensitive or opaque focused target (through shadow roots and same-origin frames); `browser_press` of a printable key (`browserKeyInsertsText`) runs the same guard. Page-world errors come back with the page stack; `boundaryRefusalOf` turns them into the bare sentence.
- The probe role uses Playwright's `getAriaRole`, falling back to `textbox` for contenteditable.

## Runtime (`main/services/bot-runtime/`)
- `bot-browser-tools.ts` `createBotBrowser`: per-refresh tools from `createBrowserAgentTools({profile:"bot"})` (11 tools: no `browser_evaluate`, no recording, web URLs only), plus the `browser` gateway (safe replay; lists tabs with `usedByThePerson`). Safe replay only for `browser`, `browser_status`, `browser_snapshot`.
  - Per Bot: selection, `Map<callId, approval>`, abort controller, kept across refreshes.
  - `bound()` pins the approved `tabId` and re-asserts; the port re-asserts in `beforeEffect` right before input. Click/type/press without an approval throw.
  - Owner: `hasOwner` or `mintOwner()` (`currentMainWindow` in `bot-connection-setup.ts`), else `botBrowserOwnerMissing(name)`.
- `bot-browser-approval.ts`: `prepareBrowserToolApproval` on tab/page/control revision + args; probe → `BotClassifiableAction {surface:"browser"}`; summary hides typed text when the probe failed or a locked class (credentials, money) matched.
- `bot-images.ts` `withNewestToolImages(messages, "browser_snapshot", 3)` in `bot-extension.ts` `beforeRequest` (own line after the disclosure filter): older snapshot images become `BOT_OLDER_SCREENSHOT_NOTE` for that request only; the journal keeps them. P10's `computer` image cap (G23) can reuse it.
- `bot-tool-disclosure.ts` `withheldUntilDisclosed(messages)`: `browser_*` stays out of each request until a successful `browser` toolResult is in that request's messages. Applied in `bot-extension.ts` `beforeRequest`.
- `bot-tool-policy.ts`: browser verdict needs `hasCapability("browser")`, never Telegram or routine; omitted tools always refused; all browser names in `UNATTENDED_WITHHELD`. `botToolApprovalSummary` returns undefined for them (the live approval asks).
- `bot-tool-sources-main.ts`: candidates when `has("browser")` on attended turns; `approvalFor` default branch; `forgetBot` closes tabs.
- Inventory: `bot-capability-inventory-ports.ts` `browserAgentAccess` (Browser settings' global agent access) makes Browser available; Full access then includes it.
- Delete: `deleteBotBrowserProfile` dep of `finishDeleteBot` (after the photo, before the home), wired in `bot-application-service-main.ts` to `clearBotProfile`. Not a journal step; a failure leaves the Bot listed and rolls forward on retry or restart (`bot-delete.test.ts`).
- Hand-offs: `bot-browser-handoff.ts` `createBotBrowserHandoffOpener` (the `botBrowser` opener; wired as `openInBotBrowser` in `bot-browser-main.ts`) creates a shown tab with `source:"user"`, holds it (`sign_in` or `handoff`, hold id = `waitId`), remembers which workspace holds it and releases it on `botHandoffs.onSettled` (answer or withdraw), or at once when the card settled while the tab opened. Action links open there only for a Bot with the Browser capability. `openBotHandoffById` takes an optional owner. P7 needs no separate `bot-sign-in-holds-main.ts`: sign-in holds already release here.
- `windowDocumentOwner` (minted owner) has the same `id`/`documentId` as an IPC request from that window, so the panel's later read doesn't re-transfer (`renderer-document-owner.test.ts`).
- Legacy `llm-client.ts` path: `canUseBrowserTools({bot:true})` stays false.

## Classifier
- `classify.ts` `browserSendKey` (only `browser_press`): Enter/NumpadEnter with no modifier but Control/Meta, an editable non-search field, and composer words in the name or a messaging host; on mail hosts only Control/Command-Enter. Hosts and words in `words.ts`. 14 corpus rows `br-*`.

## Renderer
- `renderer/main/bots/bot-browser-tab.tsx`: `useBotBrowserPresence` (workspace via `botsApi.browser.workspace`, then `browserApi.getState`, events, re-read on window focus) and `BotBrowserTab` (`BrowserPanel variant="bot"`).
- `browser-panel.tsx` Bot variant hides profile menu, Annotate/⌘., DevTools, capture, record, float, PiP, clear cookies/cache, Browser settings; `browserHoldNotice` (role=status); empty state never lists history.
- `bot-panel-context.tsx`: `"browser"` tab and a `reveal(tab)` action that opens the panel without moving focus. `bot-workbench.tsx` shows Browser once a tab exists and keeps it once seen.

## Tests
- `npm run test:bot-browser`: `bot-browser-tools.test.ts`, `bot-browser-handoff.test.ts` and `main/services/renderer-document-owner.test.ts` (runtime-subagents), `main/handlers/bot-browser.test.ts` and `bot-browser-tab.test.tsx` (renderer-other). New `main/services/browser/*.test.ts` run under `test:browser`'s glob (no lane entry).
- Credential tests launch Playwright Chromium. Locally (no `npm install`): `PLAYWRIGHT_BROWSERS_PATH=/tmp/p6-browser/pw` with symlinks to `/opt/pw-browsers`.
- `tests/e2e/bot-browser.spec.ts` bundles `bot-browser-native.ts` with esbuild and runs it as a standalone Electron main (`--no-sandbox` only as root). Fixture fields need `position:absolute` or one covers another.

## Not yet / risks
- `clearBotProfile` clears storage, cache and auth but leaves the empty partition directory on disk.
- No setter for the `takeover` hold reason yet.
- Contenteditable secrets in `innerText` are not scrubbed (only form fields are sensitive).
- Ownership follows the last window that read the Bot's browser state.
- (Fixed in P7) held tabs are listed with no URL or title; see Sign-in below.
- Sensitivity is by `type`/`autocomplete` only: a "show password" toggle that turns a field into `type=text` without a credential `autocomplete` unmasks it.
- `sign-in-origin.ts` is used by the `sign_in` tool (P7).
- Real-site sign-in and visual masking in a real window are owner-Mac checks.

## Sign-in (P7, branch wp/p7-signin)
- Tool: `main/services/bot-runtime/bot-sign-in-tool.ts` `signInCandidate(botId, handoffs, { botName?, hasComputer? })`, memo `aiden.sign_in` holds the `waitId`; `replay: "safe"`, `interactive`, `sequential`. Params `site` (<=253, `normalizeSignInOrigin`), `why?` (shared `handoffWhyOf` in `bot-handoff-tool.ts`), `where?: browser|computer` (computer is an error result until Bot computers wire `hasComputer`). Card: `kind:"sign_in"`, `action:"Sign in to <host>"`, `open:{url:origin}`, `origin`, `target`. Results: `signInDoneText` / `handoffSkippedText`; details `{kind:"sign_in", outcome, action, origin, note?}`.
- Policy: `bot-tool-policy.ts` sign_in needs `hasCapability("browser")`, never tg/routine; in `UNATTENDED_WITHHELD`. Wired in `bot-tool-sources-main.ts` after the hand-off candidate.
- Opener (`bot-browser-handoff.ts`): sign_in -> `create {url, show:true}`; action -> `open_link {url}` (reuses the Bot's tab already on that page). Re-Open on the same card `select`s the tab it opened (falls back to opening again when the person closed it). Holds keyed by botId+waitId, released on `onSettled`.
- `bot-handoff-open.ts`: action card whose Bot-browser open throws falls back to the system browser (`onOpenerError` logs); sign_in desktop errors propagate (renderer toasts "Aiden couldn’t open the sign-in page."), phone path focuses the chat and swallows the opener error -> "focused".
- Rule hand-offs of Bot browser calls carry `open` = the approval target's page (`bot-browser-approval.ts` -> `BotLiveApproval.open` -> `bot-tool-assembly.ts` decision -> `BotRuleHandoff.open` -> `ruleHandoffRequest`).
- Held tabs hidden from the Bot: `botVisibleBrowserState` (url "", title `BOT_BROWSER_HELD_TAB_TITLE` "In use by the person", no favicon/error/back/forward) in the gateway, the tools' `port.getState` and command results.
- Card text (`renderer/shared/bot-handoffs.ts` `withoutBotHandoffControls`): C0/C1 controls and bidi marks are stripped from action/why.
- Desktop UI: `handoff-card.tsx` `handoffCardTitle` -> "Sign in to <host> for <Bot>" (host from origin, then open url, then action), Open sign-in / Skip / I’m signed in, password line; `finishOn` peer variant unchanged. Chat pane holds the composer while a sign-in waits (`handoffSignInComposerText`), and `panel.show("browser")` after `opened === "browser"`. `useBotBrowserPresence` reveals the Browser tab once per newly held tab (phone path, where the "show" event fired before the chat mounted).
- Phones (P5) still title a sign-in "Your turn: Sign in to <host>" with Finish on your Mac / Skip; only the desktop title changed.
- Tests: `npm run test:bot-sign-in` (runtime-subagents lane); `tests/e2e/bot-sign-in.spec.ts` + `bot-sign-in-native.ts` intercept https with `session.protocol.handle("https")` on the Bot and person partitions (sign-in origins can't be loopback); call `browserService.shutdown()` before `app.exit` or the process doesn't exit. `bots-starter.spec.ts` answers a sign-in card in the shipped renderer.
