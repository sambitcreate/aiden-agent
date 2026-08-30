# rpiv-btw Integration

Status: Partial — the attended desktop backend, `/btw` entry point, ephemeral card, and focused tests ship. Packaged visual/accessibility acceptance remains open.

## Goal

Bring the useful interaction model from `rpiv-mono/packages/rpiv-btw` into Aiden without importing its host assumptions: a user can ask a quick question about the completed visible conversation, receive a streamed answer in an attended side surface, and continue with bounded follow-ups without changing the durable chat transcript.

## Product contract

- `/btw <question>` is available only for an idle ordinary desktop chat with at least one completed assistant response and a selected provider/model.
- Questions and answers live only in main- and renderer-process memory. They are never appended to `ChatStore`, the Pi compaction journal, exports, copies, or mobile projections.
- The current provider and model are resolved through Aiden's authoritative runtime path. Provider/model drift before dispatch fails closed and resets the ephemeral thread fingerprint.
- Context is read-only visible user/assistant prose. Thinking, images, tool calls, tool results, subagent state, and private journal records are excluded.
- The card streams deltas, supports cancellation, clear, close, and bounded follow-ups, and discloses both its ephemeral behavior and context trimming.
- A normal foreground send wins. Its admission aborts BTW before claiming the chat turn; a concurrently starting BTW request reserves its slot and then rechecks foreground busy state.
- Chat deletion waits only a 1.5-second abort grace. A provider that ignores abort is detached from the registry so late events cannot publish or mutate a replacement thread while its hard timeout drains.

## Implemented architecture

### Shared protocol and bounds

`renderer/shared/btw.ts` owns the strict versioned event parser and hard limits: 4,000 question code points / 16 KB, 24,000 answer code points, 8 follow-up turns / 192 KB, 128 context messages / 512 KB, two concurrent chats, and a two-minute timeout.

### Main process

- `main/services/rpiv-btw/context.ts` derives a newest-first bounded suffix from completed visible `ChatStore` messages, converts only visible prose, compacts against the selected model, and performs one smaller overflow retry.
- `main/services/rpiv-btw/operation-registry.ts` atomically fences one request per chat and the global limit, with owner-scoped cancellation and settlement.
- `main/services/rpiv-btw/service-core.ts` owns validation, exact runtime resolution, no-tools streaming, ordered notifications, ephemeral fingerprinted history, lifecycle cancellation, and content-free usage accounting under source `btw`.
- `main/services/rpiv-btw/service.ts` binds the core to Aiden's chat, model-runtime, and usage stores.
- `main/handlers/btw.ts` exposes attended, renderer-document-owned start/cancel/clear IPC. Handler registration is isolated from the existing chat handlers.
- `llmClient.beginChatTurn`, `cancelChat`, and `abortAll` provide the minimal foreground, deletion, and shutdown hooks.

### Renderer

- The slash catalog routes `/btw` as a composer instruction and rejects attachments or skill invocations.
- The BTW branch returns before `chatsApi.appendMessage`; only the composer draft is optimistically cleared.
- `BtwCard` is an Aiden-native, semantic-token side surface immediately above the composer. It maintains ordered request identity, resets a failed overflow attempt before retry deltas, and treats terminal events as authoritative.
- Cancel and Close are disabled during the sub-frame receipt window, then become owner-fenced actions once a cancellable request ID exists.

## Privacy and lifecycle notes

Ephemeral means no Aiden-controlled durable write. A provider still receives the bounded visible prose needed to answer, and transient process memory can exist in operating-system crash artifacts outside Aiden's storage contract. Logs, usage records, and errors contain identifiers/accounting metadata but not questions, answers, or context text.

Chat navigation cancels an attended request. Renderer invalidation, foreground generation, chat deletion, and app shutdown abort it. Successful follow-up history is cleared on explicit Clear, deletion, shutdown, or provider/model fingerprint change.

## Acceptance evidence

- `npm run test:btw`
- `npx tsx --test renderer/shared/slash-commands.test.ts renderer/lib/slash-command-actions.test.ts renderer/components/composer.test.tsx`
- `npm run type-check`

Focused coverage includes bounds and sanitization, tool-result privacy, atomic admission, foreground preemption, renderer invalidation, usage recording, ordered renderer reduction, receipt-window controls, strict event parsing, and proof that BTW returns before durable append.

## Remaining acceptance

- Exercise start, cancel, clear, provider failure, context trimming, foreground preemption, and chat navigation in a packaged macOS build.
- Run VoiceOver, keyboard-only, reduced-motion, narrow-window, light/dark, and high-contrast review of the side card.
- Confirm live provider usage totals and one real overflow retry across at least two provider families.

No onboarding tile is planned: BTW is an optional attended command, does not change first-run setup, permissions, credentials, or durable workspace capabilities, and is intentionally discoverable through the slash palette.
