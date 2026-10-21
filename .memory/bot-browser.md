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
- Typing guard: `browserTypingGuardSource` refuses a sensitive named target and a sensitive or opaque focused target (through shadow roots and same-origin frames); `browser_press` of a printable key (`browserKeyInsertsText`) runs the same guard. Page-world errors come back with the page stack; `boundaryRefusalOf` turns them into the bare sentence.
- The probe role uses Playwright's `getAriaRole`, falling back to `textbox` for contenteditable.

## Runtime (`main/services/bot-runtime/`)
- `bot-browser-tools.ts` `createBotBrowser`: per-refresh tools from `createBrowserAgentTools({profile:"bot"})` (11 tools: no `browser_evaluate`, no recording, web URLs only), plus the `browser` gateway (safe replay; lists tabs with `usedByThePerson`). Safe replay only for `browser`, `browser_status`, `browser_snapshot`.
  - Per Bot: selection, `Map<callId, approval>`, abort controller, kept across refreshes.
  - `bound()` pins the approved `tabId` and re-asserts; the port re-asserts in `beforeEffect` right before input. Click/type/press without an approval throw.
  - Owner: `hasOwner` or `mintOwner()` (`currentMainWindow` in `bot-connection-setup.ts`), else `botBrowserOwnerMissing(name)`.
- `bot-browser-approval.ts`: `prepareBrowserToolApproval` on tab/page/control revision + args; probe → `BotClassifiableAction {surface:"browser"}`; summary hides typed text when the probe failed or a locked class (credentials, money) matched.
- `bot-tool-disclosure.ts` `withheldUntilDisclosed(messages)`: `browser_*` stays out of each request until a successful `browser` toolResult is in that request's messages. Applied in `bot-extension.ts` `beforeRequest`.
- `bot-tool-policy.ts`: browser verdict needs `hasCapability("browser")`, never Telegram or routine; omitted tools always refused; all browser names in `UNATTENDED_WITHHELD`. `botToolApprovalSummary` returns undefined for them (the live approval asks).
- `bot-tool-sources-main.ts`: candidates when `has("browser")` on attended turns; `approvalFor` default branch; `forgetBot` closes tabs.
- Inventory: `bot-capability-inventory-ports.ts` `browserAgentAccess` (Browser settings' global agent access) makes Browser available; Full access then includes it.
- Delete: `deleteBotBrowserProfile` dep of `finishDeleteBot` (after the photo, before the home), wired in `bot-application-service-main.ts` to `clearBotProfile`. Not a journal step; a failure leaves the Bot listed and rolls forward on retry or restart (`bot-delete.test.ts`).
- Hand-offs: `bot-browser-main.ts` `openInBotBrowser` (the `botBrowser` opener) creates a shown tab with `source:"user"`, holds it (`sign_in` or `handoff`) and releases on `botHandoffs.onSettled`. Action links open there only for a Bot with the Browser capability. `openBotHandoffById` takes an optional owner.
- Legacy `llm-client.ts` path: `canUseBrowserTools({bot:true})` stays false.

## Classifier
- `classify.ts` `browserSendKey` (only `browser_press`): Enter/NumpadEnter with no modifier but Control/Meta, an editable non-search field, and composer words in the name or a messaging host; on mail hosts only Control/Command-Enter. Hosts and words in `words.ts`. 14 corpus rows `br-*`.

## Renderer
- `renderer/main/bots/bot-browser-tab.tsx`: `useBotBrowserPresence` (workspace via `botsApi.browser.workspace`, then `browserApi.getState`, events, re-read on window focus) and `BotBrowserTab` (`BrowserPanel variant="bot"`).
- `browser-panel.tsx` Bot variant hides profile menu, Annotate/⌘., DevTools, capture, record, float, PiP, clear cookies/cache, Browser settings; `browserHoldNotice` (role=status); empty state never lists history.
- `bot-panel-context.tsx`: `"browser"` tab and a `reveal(tab)` action that opens the panel without moving focus. `bot-workbench.tsx` shows Browser once a tab exists and keeps it once seen.

## Tests
- `npm run test:bot-browser`: `bot-browser-tools.test.ts` (runtime-subagents), `main/handlers/bot-browser.test.ts` and `bot-browser-tab.test.tsx` (renderer-other). New `main/services/browser/*.test.ts` run under `test:browser`'s glob (no lane entry).
- Credential tests launch Playwright Chromium. Locally (no `npm install`): `PLAYWRIGHT_BROWSERS_PATH=/tmp/p6-browser/pw` with symlinks to `/opt/pw-browsers`.
- `tests/e2e/bot-browser.spec.ts` bundles `bot-browser-native.ts` with esbuild and runs it as a standalone Electron main (`--no-sandbox` only as root). Fixture fields need `position:absolute` or one covers another.

## Not yet / risks
- `clearBotProfile` clears storage, cache and auth but leaves the empty partition directory on disk.
- No setter for the `takeover` hold reason yet.
- Contenteditable secrets in `innerText` are not scrubbed (only form fields are sensitive).
- Ownership follows the last window that read the Bot's browser state.
- `sign-in-origin.ts` is for P7; nothing uses it yet.
- Real-site sign-in and visual masking in a real window are owner-Mac checks.
