# Durable tool output and produced files

Status: Implemented — local checks and independent reviews passed; physical iOS execution and hosted PR checks pending.

## Confirmed scope

Baseline `c8c09e0d`, September 22, 2026. The September 15 Notion DeepSeek audit
predates MCP result bounding already shipped on main. Current gaps are recoverable
oversized command/MCP text and host-confirmed file mutation provenance.
Primary source verified: `deepseek-ai/deepseek-harness`,
`packages/client/ui-deliverables/README.md`; use successful mutations as provenance,
never assistant closing prose. No upstream code or plugin architecture is copied.

## Delivery

- Private atomic `0600` store: at most 64 outputs, two million UTF-16 characters per
  output, four million total. Preview windows stay at existing command/MCP limits;
  recovery windows are at most 8,000 characters. MCP non-text resources are never fetched.
- Opaque handles require the original chat, workspace/root identity, permission,
  available producing tool, connector configuration and encrypted credential-store
  fingerprints. Conservative invalidation includes credential refreshes and unrelated
  connector/key edits. No handle grants access by itself, and copied chats cannot read it.
- Ordinary workspace generations only. Bot, child, Assistant and specialized positive
  allowlists remain unchanged. File reads/searches retain existing bounds; command output
  and normalized MCP text are the spill sources in this slice.
- Expired output is unreadable after seven days and removed on startup, hourly local
  cleanup, or subsequent store mutation; chat deletion and restart roll-forward remove matching outputs.
- Successful first-party writes/edits emit relative path, operation and byte count;
  desktop and both native Activity views display this provenance. It is a historical
  mutation receipt, not a file snapshot or permission to open a Mac path.
- Existing Files onboarding tile explains output recovery; reuse its existing optimized
  illustration. No new setup action, network request, attachment lifecycle or browser route.

## Acceptance

Focused storage/isolation/expiry, command, MCP, timeline, deletion, protocol, desktop
and onboarding suites; full TypeScript check; Android chat tests; iOS app/test build
and physical AidenChatTests; independent Sol regression and adversarial reviews;
PR checks and actionable review closure. No merge, release or deployment.

## Local evidence

- `npm run test:tool-outputs`: 125/125 passed. Inventory publication fence: 10/10 passed.
- TypeScript, ESLint and diff checks pass. React Doctor: 90/100, no issues.
- Android AidenChatTest + AidenBotContractTest: 38/38 passed.
- Xcode generic iOS `build-for-testing`, unsigned: passed. Physical iPhone XCTest is queued through the coordinator but blocked by device lock (`deviceprep Code=-3`, Unlock Sambit’s iPhone to Continue); no simulator used.
- Independent GPT-5.6 Sol medium regression and adversarial reviews are clear after fixes, including credential publication races, optional-store availability, cleanup, and Windows/macOS path normalization.
