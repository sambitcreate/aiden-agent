# Studio Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task, with a fresh implementer subagent per task plus a spec-compliance and a code-quality reviewer before the next task starts. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the shared Studio Foundation that Design Studio and Create Images build on:
- **Flags.** `designStudio` and `createImages` capabilities, both default off.
- **Shell.** Lazy `/design` and `/images` routes under the chat shell, two sidebar rows and two palette commands.
- **Hidden chats.** One central classifier for feature-owned chats.
- **Assets.** A content-addressed, holder-retained studio asset store served through `aiden-asset:` with document-bound grants.
- **Canvas kit.** `renderer/canvas/` on pinned `@xyflow/react`.
- **Tests.** Test suites registered in the existing CI lanes.

With both flags off, the app behaves exactly like `main`.

**Architecture:** Two PRs.
- **PR A, `feature/studio-chat-visibility`** (tasks F-3.1 – F-3.5): adds `chat.owner` and the `chatSurface()` classifier, and applies them at every listing and Remote projection. `chatStore.list()` stays unfiltered so startup reconciliation keeps hidden chats' state.
- **PR B, `feature/studio-foundation`** (tasks F-1.1 – F-6): flags, routes, sidebar, commands, asset store and protocol, canvas kit, Playwright, docs.

PR A and PR B can be reviewed in parallel. Merge PR A first, because both touch `main/index.ts` and `package.json` `test:serial`. After PR A merges, merge `origin/main` into PR B; never rebase it. Pure logic stays in Electron-free `*-core.ts` modules. Electron touchpoints are thin (`*-main.ts`, `protocol.ts`, `custom-schemes.ts`).

**Tech Stack:** Electron 43, React 19, TanStack Router 1.131 (`lazyRouteComponent`), `@xyflow/react` 12.11.6 (exact), `node:sqlite` (`DatabaseSync`), `main/services/durable-fs.ts`, Electron `protocol.handle` + `nativeImage`, `node:test` via `tsx --test`, `react-dom/server` + `@xmldom/xmldom` render tests, and Playwright Electron (`tests/e2e/fixtures.ts`).

**Spec:**
- [ADR-F, Studio Foundation](studio-foundation-adr.md): every decision referenced here as F-D1 … F-D10.
- [Umbrella plan](design-studio-create-images-rebuild-plan.md) §2, §3, §6 ADR-F and §7 Track F.
- Consumers: [ADR-DS](design-studio-adr.md) and [ADR-CI](create-images-adr.md).

**Global constraints** (from umbrella §2 and AGENTS.md, as they apply to Track F):
- Port from the `ref-*` worktrees by reading them. Never merge or cherry-pick the old tips.
- Both capabilities default **off**. There is no onboarding tile and no Settings section in Track F.
- Every feature route uses `lazyRouteComponent`, and feature CSS is imported only by the lazy route. `npm run check:bundle-budget` stays ≤ 3,520,000 B raw / 1,075,000 B gzip.
- No new IPC channels in Track F. Feature tracks own their own handlers later.
- New persistence uses `durable-fs.ts` or `node:sqlite`. No base64 in JSON stores. Stores initialize in the `main/index.ts` reconcile chain before `openProcessStartupIpcAdmission()`.
- CSP: exactly one ADR-approved edit, `aiden-asset:` in `img-src` (F-D6). No global `webRequest` listeners. Exactly one `registerSchemesAsPrivileged` call.
- Hidden feature chats go through `chatSurface()` only. No sentinel workspace IDs.
- **Tests:**
  - Behavioral only: no `readFileSync` source-grep, no change-detector tests, no tautological tests.
  - Register every new test file in `package.json` (reachable from `test:serial`) **and** in `scripts/ci-test-registry.json`.
  - Playwright passes on Linux xvfb. Never weaken `--fail-on-flaky-tests`.
- No production file over ~800 lines, no React component over ~400 lines, and no golfed one-liners.
- **UI:**
  - Before any UI work, review `docs/design-guide.md`, `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`.
  - Use the shared squircle `Button` and semantic tokens.
  - No borders on selection controls.
  - Non-text controls keep the neutral focus ring. Text inputs get no focus ring.
  - No brain icons.
- Dependencies are pinned exactly. Renderer-only packages go in `devDependencies`. Update `THIRD_PARTY_NOTICES.md`.
- Update a branch that has a PR by merging `origin/main`. Run narrow suites locally before CI. Merge only on green CI at the exact head.

**Review focus (umbrella §3), and the test that pins each item:**

| # | Failure mode | Pinned by |
|---|---|---|
| 2 | A hidden chat leaks into the sidebar, search, Remote summaries, the host feed, peers, fork, BTW or native clients | F-3.2 `chat-store-core.test.ts` "feature-owned chats leave regular listings…" (sidebar, search, palette, Remote `list()`); F-3.3 `aiden-remote-chat-summaries.test.ts` "feature-owned chats never reach summaries or the host feed" (summaries, host feed, peers, native); F-3.3 `aiden-remote-chats.test.ts` "Remote classification refuses feature-owned chats" (every per-chat Remote route); F-3.3 progress test; F-3.4 fork, BTW and empty-chat tests; F-3.5 iOS/Android suites |
| 2b | Startup reconciliation drops a hidden chat's state | F-3.2 `startup-chat-reconciliation.test.ts` "hidden feature chats stay in the startup reconciliation set" |
| 3 | Flags off is not identical to main | F-1.2 `app-capabilities.test.ts`; F-2.3 `command-system-core.test.ts` "palette omits studio commands while their capability is off"; F-2.4 `sidebar-primary-nav.test.tsx` "with both flags off the nav is exactly New Agent, Scheduled, Bots"; F-2.2 `studio-capability-route.test.tsx`; F-4.1 `custom-schemes-core.test.ts` "only aiden-genui is privileged with both flags off"; F-5.4 Playwright "flags off: no studio rows, commands or routes"; F-6 `check:bundle-budget` before/after |
| 1, 4, 5 | Restart mid-run, consent/cost, scale | Owned by the DS and CI tracks. Track F only provides the primitives: the store's crash-window sweep is pinned by F-4.3 "a blob written without its row is swept on restart". |

**Conventions used below:**
- Worktree: `/Users/sambitbiswas/projects/aiden-macos/.claude/worktrees/studio-foundation` for PR B and `/Users/sambitbiswas/projects/aiden-macos/.claude/worktrees/studio-chat-visibility` for PR A. Both are created from `origin/main`.
- Run one test file: `npx tsx --test <file>`.
- Registry check after every registration: `npm run test:ci:registry`.
- Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

# PR A: Hidden feature chats (`feature/studio-chat-visibility`)

## Task F-3.1: Chat surface classifier and owner parser

**Files:**
- Create: `renderer/shared/chat-visibility.ts`
- Test: `renderer/shared/chat-visibility.test.ts`
- Modify: `package.json` (new `test:chat-visibility` script, appended to `test:serial`), `scripts/ci-test-registry.json` (`renderer-other`)

**Interfaces:**
- Consumes: `ASSISTANT_WORKSPACE_ID` (`renderer/shared/assistant.ts:6`), `persistedChatWorkspaceId(workspaceId: string | undefined): string` (`renderer/shared/chat-workspace.ts:4`).
- Produces:
  ```ts
  export interface ChatOwnerV1 { kind: "design-project"; projectId: string }
  export type ChatSurface = "regular" | "assistant" | "bot" | "feature";
  export interface ChatSurfaceInput { workspaceId?: string; botId?: string; owner?: ChatOwnerV1 }
  export function parseChatOwnerV1(value: unknown): ChatOwnerV1 | undefined;
  export function chatSurface(chat: ChatSurfaceInput): ChatSurface;
  export function isUserVisibleChat(chat: ChatSurfaceInput): boolean;
  ```

- [ ] **Step 1: Write the failing test** in `renderer/shared/chat-visibility.test.ts`.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { chatSurface, isUserVisibleChat, parseChatOwnerV1 } from "./chat-visibility.js";

const owner = { kind: "design-project", projectId: "project-1" } as const;

test("feature ownership wins over every other chat identity", () => {
  assert.equal(chatSurface({ workspaceId: "workspace-1", owner }), "feature");
  assert.equal(chatSurface({ workspaceId: "assistant", owner }), "feature");
  assert.equal(isUserVisibleChat({ workspaceId: "workspace-1", owner }), false);
});

test("bots, the Assistant workspace and legacy chats keep their existing surfaces", () => {
  assert.equal(chatSurface({ workspaceId: "workspace-1" }), "regular");
  // Legacy chats without a workspace belong to the default workspace.
  assert.equal(chatSurface({}), "regular");
  assert.equal(chatSurface({ workspaceId: "assistant" }), "assistant");
  assert.equal(chatSurface({ workspaceId: "workspace-1", botId: "bot-1" }), "bot");
  assert.equal(isUserVisibleChat({ workspaceId: "workspace-1" }), true);
  assert.equal(isUserVisibleChat({ workspaceId: "assistant" }), false);
  assert.equal(isUserVisibleChat({ workspaceId: "workspace-1", botId: "bot-1" }), false);
});

test("the owner parser accepts only the exact design-project shape", () => {
  assert.deepEqual(parseChatOwnerV1(owner), owner);
  for (const value of [
    undefined,
    null,
    "design-project",
    [],
    { kind: "design-project" },
    { kind: "bot", projectId: "project-1" },
    { kind: "design-project", projectId: "" },
    { kind: "design-project", projectId: "../escape" },
    { kind: "design-project", projectId: "x".repeat(129) },
    { ...owner, extra: true },
  ]) {
    assert.equal(parseChatOwnerV1(value), undefined, JSON.stringify(value));
  }
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run `npx tsx --test renderer/shared/chat-visibility.test.ts`. Expected: FAIL, `Cannot find module './chat-visibility.js'`.

- [ ] **Step 3: Implement** `renderer/shared/chat-visibility.ts`.

```ts
// One classifier decides what kind of chat a record is. Listing, Remote and
// copy surfaces admit chats by an explicit allow-list of surfaces, so a future
// owner kind stays hidden everywhere until a surface opts it in.
import { ASSISTANT_WORKSPACE_ID } from "./assistant.js";
import { persistedChatWorkspaceId } from "./chat-workspace.js";

/** Main-owned marker for a chat that belongs to another Aiden feature. Never renderer-authored. */
export interface ChatOwnerV1 {
  kind: "design-project";
  projectId: string;
}

export type ChatSurface = "regular" | "assistant" | "bot" | "feature";

export interface ChatSurfaceInput {
  workspaceId?: string;
  botId?: string;
  owner?: ChatOwnerV1;
}

const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Strict exact-shape parser; anything else is rejected, never repaired. */
export function parseChatOwnerV1(value: unknown): ChatOwnerV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("projectId")) {
    return undefined;
  }
  if (record.kind !== "design-project") return undefined;
  if (typeof record.projectId !== "string" || !OWNER_ID.test(record.projectId)) return undefined;
  return { kind: "design-project", projectId: record.projectId };
}

export function chatSurface(chat: ChatSurfaceInput): ChatSurface {
  // Any present owner hides the chat, even a malformed one: fail closed.
  if (chat.owner !== undefined) return "feature";
  if (chat.botId !== undefined) return "bot";
  if (persistedChatWorkspaceId(chat.workspaceId) === ASSISTANT_WORKSPACE_ID) return "assistant";
  return "regular";
}

/** An ordinary workspace chat: listed in the sidebar, search, Remote summaries and peers. */
export function isUserVisibleChat(chat: ChatSurfaceInput): boolean {
  return chatSurface(chat) === "regular";
}
```

- [ ] **Step 4: Run it and watch it pass.**
  Run `npx tsx --test renderer/shared/chat-visibility.test.ts`. Expected: 3 tests pass.

- [ ] **Step 5: Register the test.**
  1. In `package.json` `scripts`, add the line below. Then append ` && npm run test:chat-visibility` to the **end** of `test:serial`, and keep every existing segment.
     ```json
     "test:chat-visibility": "tsx --test renderer/shared/chat-visibility.test.ts",
     ```
  2. In `scripts/ci-test-registry.json`, add `"renderer/shared/chat-visibility.test.ts"` to the `files` array of the lane whose `name` is `renderer-other`.
  3. Run `npm run test:ci:registry`. Expected: pass.

- [ ] **Step 6: Commit.**

```bash
git add renderer/shared/chat-visibility.ts renderer/shared/chat-visibility.test.ts package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(chats): classify feature-owned chats with one surface predicate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-3.2: Persist `owner`, filter regular listings, extract startup reconciliation

**Files:**
- Modify: `main/services/types.ts` (`ChatMeta`, line 416), `renderer/lib/types.ts` (`ChatMeta`, line 628), `main/services/chat-store-core.ts` (`isValidMeta` :355, `metaOf` :924, `listRegular` :1076, `create` :1175, `copyVisibleHistory` :1219), `main/index.ts` (:1899-1905)
- Create: `main/services/startup-chat-reconciliation.ts`
- Test: `main/services/chat-store-core.test.ts` (extend), `main/services/startup-chat-reconciliation.test.ts` (new)
- Modify: `package.json` (`test:chat-visibility`), `scripts/ci-test-registry.json` (`core-git`)

**Interfaces:**
- Consumes: `ChatOwnerV1`, `parseChatOwnerV1` and `chatSurface` from F-3.1; `createChatStore(resolveDir)`; `ChatForkError` (`main/services/chat-fork-error.ts`).
- Produces:
  - `chatStore.create({ …, owner?: ChatOwnerV1 })`
  - `ChatMeta.owner?: ChatOwnerV1`
  - `listRegular()` excludes the `feature` and `bot` surfaces. Assistant chats are still included, as today.
  - `export async function reconcileChatScopedStores(chatStore: Pick<ReturnType<typeof createChatStore>, "list">, stores: readonly ChatScopedStore[]): Promise<ReadonlySet<string>>`, where `ChatScopedStore = { reconcileChats(validChatIds: ReadonlySet<string>): Promise<void> }`.

- [ ] **Step 1: Write the failing tests.** Append the tests below to `main/services/chat-store-core.test.ts`, and add `import { ChatForkError } from "./chat-fork-error.js";` to its imports.

```ts
test("feature-owned chats leave regular listings but stay in the full index across a restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-store-owner-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owner = { kind: "design-project" as const, projectId: "project-1" };
  const store = createChatStore(async () => directory);
  const regular = await store.create({ workspaceId: "default" });
  const assistant = await store.create({ workspaceId: "assistant" });
  // No workspace: an owned chat lands in "default", which is exactly where a leak would show.
  const owned = await store.create({ owner });

  assert.deepEqual(
    new Set((await store.listRegular()).map(({ id }) => id)),
    new Set([regular.id, assistant.id]),
  );
  assert.deepEqual((await store.listRegular("default")).map(({ id }) => id), [regular.id]);

  const restarted = createChatStore(async () => directory);
  assert.deepEqual(
    new Set((await restarted.list()).map(({ id }) => id)),
    new Set([regular.id, assistant.id, owned.id]),
  );
  assert.deepEqual(
    (await restarted.listSummaryMetadata()).find(({ id }) => id === owned.id)?.owner,
    owner,
  );
  assert.deepEqual((await restarted.get(owned.id))?.owner, owner);
  assert.deepEqual((await restarted.listRegular("default")).map(({ id }) => id), [regular.id]);
});

test("an owner is main-only, exclusive with Bots, and never copied", async (t) => {
  const store = await testStore(t);
  const owner = { kind: "design-project" as const, projectId: "project-1" };
  await assert.rejects(store.create({ botId: "bot-1", owner }), /Invalid chat owner/u);
  await assert.rejects(
    store.create({ owner: { kind: "design-project", projectId: "../escape" } }),
    /Invalid chat owner/u,
  );
  const owned = await store.create({ owner });
  await store.appendMessage(owned.id, { role: "user", content: "A pricing page" });
  await assert.rejects(
    store.copyVisibleHistory({ sourceChatId: owned.id }),
    (error: unknown) => error instanceof ChatForkError && error.code === "ineligible",
  );
  assert.equal((await store.list()).length, 1);
});
```

Create `main/services/startup-chat-reconciliation.test.ts`:

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createChatStore } from "./chat-store-core.js";
import { reconcileChatScopedStores } from "./startup-chat-reconciliation.js";

test("hidden feature chats stay in the startup reconciliation set", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-startup-reconcile-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const regular = await store.create({ workspaceId: "default" });
  const bot = await store.create({ workspaceId: "default", botId: "bot-1" });
  const owned = await store.create({ owner: { kind: "design-project", projectId: "project-1" } });

  const seen: string[][] = [];
  const recorder = {
    reconcileChats: async (ids: ReadonlySet<string>) => {
      seen.push([...ids].sort());
    },
  };
  const ids = await reconcileChatScopedStores(createChatStore(async () => directory), [recorder, recorder]);

  const expected = [regular.id, bot.id, owned.id].sort();
  assert.deepEqual([...ids].sort(), expected);
  // Every chat-scoped store (effects, compaction sessions) keeps state for hidden chats.
  assert.deepEqual(seen, [expected, expected]);
});
```

- [ ] **Step 2: Run them and watch them fail.**
  Run `npx tsx --test main/services/chat-store-core.test.ts main/services/startup-chat-reconciliation.test.ts`.
  Expected: FAIL.
  - `tsx` does not type-check, so `create` silently drops `owner`. As a result, `listRegular()` still returns the owned chat, and `create({ botId, owner })` does not reject.
  - `Cannot find module './startup-chat-reconciliation.js'`.

- [ ] **Step 3: Implement.**

`main/services/types.ts`: add the import at the top, then add the field to `ChatMeta` after `forkedFrom`.

```ts
import type { ChatOwnerV1 } from "../../renderer/shared/chat-visibility.js";
// …inside interface ChatMeta, after forkedFrom:
  /** Main-owned feature owner; owned chats never appear in chat listings or Remote. */
  owner?: ChatOwnerV1;
```

`renderer/lib/types.ts`: do the same with `import type { ChatOwnerV1 } from "../shared/chat-visibility";`, and add `owner?: ChatOwnerV1;` to `ChatMeta`.

`main/services/chat-store-core.ts`:

```ts
import { chatSurface, parseChatOwnerV1, type ChatOwnerV1 } from "../../renderer/shared/chat-visibility.js";
```

In `isValidMeta`, add one more conjunct before the `forkedFrom` check:

```ts
      (meta.owner === undefined ||
        (parseChatOwnerV1(meta.owner) !== undefined && meta.botId === undefined)) &&
```

In `metaOf`, add this after the `botId` spread:

```ts
      ...(chat.owner ? { owner: chat.owner } : {}),
```

Replace `listRegular`:

```ts
    /** Chats that may appear in chat listings: ordinary and Assistant chats, never Bot or feature-owned. */
    async listRegular(workspaceId?: string): Promise<ChatMeta[]> {
      return (await this.list(workspaceId)).filter((chat) => {
        const surface = chatSurface(chat);
        return surface === "regular" || surface === "assistant";
      });
    },
```

In `create`:
1. Add `owner?: ChatOwnerV1;` to the input type.
2. Right after `input.assertCurrent?.();`, add:
   ```ts
        const owner = input.owner === undefined ? undefined : parseChatOwnerV1(input.owner);
        if (input.owner !== undefined && (owner === undefined || input.botId !== undefined)) {
          throw new Error("Invalid chat owner.");
        }
   ```
3. In the `chat` literal, after the `botId` spread, add `...(owner ? { owner } : {}),`.

In `copyVisibleHistory`, right after the `if (!source) throw …` line, add:

```ts
        if (source.owner !== undefined) {
          throw new ChatForkError(
            "ineligible",
            "This chat belongs to another Aiden feature and cannot be copied.",
          );
        }
```

Create `main/services/startup-chat-reconciliation.ts`:

```ts
import type { createChatStore } from "./chat-store-core.js";

export interface ChatScopedStore {
  reconcileChats(validChatIds: ReadonlySet<string>): Promise<void>;
}

/**
 * Startup garbage collection for chat-scoped state. It must read the full,
 * unfiltered index: feature-owned chats are hidden from listings, not deleted,
 * and their effect and compaction state has to survive a restart.
 */
export async function reconcileChatScopedStores(
  chatStore: Pick<ReturnType<typeof createChatStore>, "list">,
  stores: readonly ChatScopedStore[],
): Promise<ReadonlySet<string>> {
  const chatIds = new Set((await chatStore.list()).map((chat) => chat.id));
  await Promise.all(stores.map((store) => store.reconcileChats(chatIds)));
  return chatIds;
}
```

In `main/index.ts`, replace lines 1899-1905 (the `visibleChatIds` set and its `Promise.all`):

```ts
      await reconcileChatScopedStores(chatStore, [
        piRuntimeEffectStore,
        piCompactionSessionStore,
      ]);
```

Then add `import { reconcileChatScopedStores } from "./services/startup-chat-reconciliation.js";` to the imports. `visibleChatIds` has no other use in `main/index.ts` (it appears only at :1899, :1903 and :1904).

- [ ] **Step 4: Run them and watch them pass.**
  Run `npx tsx --test main/services/chat-store-core.test.ts main/services/startup-chat-reconciliation.test.ts`. Expected: all pass, including every existing `chat-store-core` test. Then run `npm run type-check`. Expected: no errors.

- [ ] **Step 5: Register the tests.**
  1. In `package.json`, extend `test:chat-visibility` to:
     ```
     tsx --test renderer/shared/chat-visibility.test.ts main/services/startup-chat-reconciliation.test.ts main/services/chat-store-core.test.ts
     ```
  2. In `scripts/ci-test-registry.json`, add `"main/services/startup-chat-reconciliation.test.ts"` to the `core-git` lane. `chat-store-core.test.ts` is already assigned there.
  3. Run `npm run test:ci:registry`. Expected: pass.

- [ ] **Step 6: Commit.**

```bash
git add main/services/types.ts renderer/lib/types.ts main/services/chat-store-core.ts main/services/chat-store-core.test.ts main/services/startup-chat-reconciliation.ts main/services/startup-chat-reconciliation.test.ts main/index.ts package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(chats): persist feature owners and keep owned chats out of listings

Startup reconciliation still reads the full index so hidden chats keep
their effect and compaction state.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-3.3: Remote projections (summaries, host feed, per-chat routes, progress)

**Files:**
- Modify: `main/services/aiden-remote-chats.ts` (`safeSummaryMetadata` :460-466, `classify` :1431-1450), `main/services/aiden-remote-chat-progress-authorize.ts` (:76-85)
- Test (extend): `main/services/aiden-remote-chat-summaries.test.ts`, `main/services/aiden-remote-chats.test.ts`, `main/services/aiden-remote-chat-progress-authorize.test.ts`
- Modify: `package.json` (`test:chat-visibility`)

**Interfaces:**
- Consumes: `chatSurface` (F-3.1); the existing helpers `summaryService(initial, options)` and `metadata(id, updatedAt, overrides)` in the summaries test, `fixture(initial, options)` and `chat(overrides)` in `aiden-remote-chats.test.ts`, and `fixture({ metadata })` / `meta` in the progress test.
- Produces:
  - Summaries and `hostFeedChats().summaries` omit `feature` chats.
  - `classify(chatId)` rejects them with `AidenRemoteServiceError` code `not_found`.
  - Progress authorization rejects them with the existing "unavailable" 404.
  - There is no wire-shape change and `AIDEN_REMOTE_CONTRACT_REVISION` stays 24.

- [ ] **Step 1: Write the failing tests.**

Append to `main/services/aiden-remote-chat-summaries.test.ts`:

```ts
test("feature-owned chats never reach summaries or the host feed", async () => {
  const owner = { kind: "design-project" as const, projectId: "project-1" };
  const fixture = summaryService([
    metadata("chat-a", 3_000),
    metadata("design-chat", 4_000, { workspaceId: "default", owner }),
    metadata("assistant-chat", 5_000, { workspaceId: "assistant" }),
  ], { active: new Set(["design-chat"]) });

  const page = await fixture.service.listSummaries();
  assert.deepEqual(page.summaries.map(({ id }) => id), ["chat-a"]);
  assert.equal(JSON.stringify(page).includes("design-chat"), false);

  const feed = await fixture.service.hostFeedChats();
  assert.deepEqual(feed.summaries.map(({ id }) => id), ["chat-a"]);
  assert.equal(feed.botChatIds.has("design-chat"), false);
});
```

Append to `main/services/aiden-remote-chats.test.ts`:

```ts
test("Remote classification refuses feature-owned chats before any payload read", async () => {
  let payloadReads = 0;
  const { service } = fixture(
    chat({ owner: { kind: "design-project", projectId: "project-1" } }),
    { onPayloadGet: () => { payloadReads += 1; } },
  );

  await assert.rejects(
    service.classify("chat-1"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError &&
      (error as { code?: string; status?: number }).code === "not_found" &&
      (error as { status?: number }).status === 404,
  );
  assert.equal(payloadReads, 0);
});
```

> Remote `list()` delegates to `application.listRegular`. Its filtering is the store contract pinned in F-3.2, so this test does not re-assert it through the fixture. That would be tautological.

Append to `main/services/aiden-remote-chat-progress-authorize.test.ts`:

```ts
test("feature-owned chats report not found to progress readers", async () => {
  let chatsRead = 0;
  const owned = fixture({
    metadata: [{ ...meta, owner: { kind: "design-project", projectId: "project-1" } }],
    readChat: async () => { chatsRead += 1; return chat; },
  });
  await assert.rejects(owned.authorize("device-1", "chat-1", "tasks:read"), /unavailable/);
  await assert.rejects(owned.authorize("device-1", "chat-1", "agents:read"), /unavailable/);
  assert.equal(chatsRead, 0);
  assert.equal(owned.held(), 0);
});
```

- [ ] **Step 2: Run them and watch them fail.**
  First run `npm run build:worktree-file-io`, which the Remote suites need. Then run `npx tsx --test main/services/aiden-remote-chat-summaries.test.ts main/services/aiden-remote-chats.test.ts main/services/aiden-remote-chat-progress-authorize.test.ts`.
  Expected: the three new tests FAIL.
  - Summaries: `"design-chat"` is present.
  - `classify`: it resolves `{}`.
  - Progress: it resolves.

- [ ] **Step 3: Implement.**

`main/services/aiden-remote-chats.ts`:
1. Add `import { chatSurface } from "../../renderer/shared/chat-visibility.js";`.
2. In `safeSummaryMetadata`, replace the `meta.botId !== undefined || workspaceId === ASSISTANT_WORKSPACE_ID ||` pair with:
   ```ts
    chatSurface(meta) !== "regular" ||
   ```
3. In `classify`, right after the `if (!metadata) { throw … }` block, add:
   ```ts
    if (chatSurface(metadata) === "feature") {
      throw new AidenRemoteServiceError("not_found", "This Aiden chat no longer exists.", 404);
    }
   ```
4. `ASSISTANT_WORKSPACE_ID` is still used at `:1856`. Keep that import.

`main/services/aiden-remote-chat-progress-authorize.ts`:
1. Replace the `ASSISTANT_WORKSPACE_ID` / `persistedChatWorkspaceId` imports with `import { chatSurface } from "../../renderer/shared/chat-visibility.js";`.
2. Change the condition to:
   ```ts
      const surface = metadata ? chatSurface(metadata) : undefined;
      if (!metadata || (surface !== "regular" && surface !== "bot")) {
   ```

- [ ] **Step 4: Run them and watch them pass.**
  Run the same command. Expected: all pass, including "summary pages are transcript-free, deterministic, and exclude reserved chats" and "missing chats and the Assistant workspace report not found" (Assistant behavior is unchanged). Then run `npm run test:aiden-remote`. Expected: pass.

- [ ] **Step 5: Register the tests.**
  1. Append `main/services/aiden-remote-chat-summaries.test.ts main/services/aiden-remote-chats.test.ts main/services/aiden-remote-chat-progress-authorize.test.ts` to `test:chat-visibility`.
  2. No registry change is needed: these files are already in `runtime-subagents`.
  3. Run `npm run test:ci:registry`. Expected: pass.

- [ ] **Step 6: Commit.**

```bash
git add main/services/aiden-remote-chats.ts main/services/aiden-remote-chat-progress-authorize.ts main/services/aiden-remote-chat-summaries.test.ts main/services/aiden-remote-chats.test.ts main/services/aiden-remote-chat-progress-authorize.test.ts package.json
git commit -F - <<'EOF'
feat(remote): hide feature-owned chats from summaries, feed and chat routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-3.4: Desktop projections (fork, BTW, empty-chat migration)

**Files:**
- Modify: `main/services/chat-fork-service.ts` (:130-135), `main/services/rpiv-btw/service-core.ts` (:108), `main/services/empty-chat-migration.ts` (:38-47)
- Test (extend): `main/services/chat-fork-service.test.ts`, `main/services/rpiv-btw/service.test.ts`, `main/services/empty-chat-migration.test.ts`
- Modify: `package.json` (`test:chat-visibility`)

**Interfaces:**
- Consumes: `chatSurface` (F-3.1); `createChatForkService`, `ChatForkError`, `BtwService`, `isLegacyEmptyWorkspaceChat`.
- Produces:
  - Fork of a feature chat → `ChatForkError("ineligible")` with no published copy.
  - BTW refuses feature chats.
  - The empty-chat sweep never selects them.

- [ ] **Step 1: Write the failing tests.**

Append to `main/services/chat-fork-service.test.ts`:

```ts
test("feature-owned chats are ineligible for copy and fork", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-fork-owned-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const owned = await store.create({ owner: { kind: "design-project", projectId: "project-1" } });
  await store.appendMessage(owned.id, { role: "user", content: "A pricing page" });
  const reply = await store.appendMessage(owned.id, { role: "assistant", content: "Here it is." });
  const published: Chat[] = [];
  const admitted: string[] = [];
  const recordingCaller: ChatForkCaller = {
    admitWorkspace: (workspaceId) => {
      admitted.push(workspaceId);
      return { isAborted: () => false, release: () => undefined };
    },
  };
  const forks = service(store, { published: (chat) => published.push(chat), startSummary: () => undefined });

  await rejectsWith(forks.fork({ chatId: owned.id }, recordingCaller), "ineligible");
  await rejectsWith(
    forks.fork(
      { chatId: owned.id, forkAt: { messageId: reply.messages[1]!.id, position: "after" } },
      recordingCaller,
    ),
    "ineligible",
  );
  // Refused before any workspace admission: an owned chat never borrows the
  // default workspace's mutation gate.
  assert.deepEqual(admitted, []);
  assert.deepEqual(published, []);
  assert.equal((await store.list()).length, 1);
});
```

In `main/services/rpiv-btw/service.test.ts`:
1. Change the `fixture` signature to `fixture(options: { busy?: boolean; streamDelayMs?: number; chat?: Partial<Chat> } = {})`.
2. Spread `...options.chat` at the end of the `getChat` result object, and add `import type { Chat } from "../types.js";`.
3. Append:

```ts
test("BTW refuses feature-owned chats before provider dispatch", async () => {
  const app = fixture({ chat: { owner: { kind: "design-project", projectId: "project-1" } } });
  await assert.rejects(
    app.service.start("chat-a", "Question", app.owner),
    /only in ordinary desktop chats/u,
  );
  assert.deepEqual(app.events, []);
  assert.deepEqual(app.usage, []);
});
```

Append to `main/services/empty-chat-migration.test.ts`:

```ts
test("the empty-chat sweep never deletes a feature-owned chat", async () => {
  const h = harness([
    empty("blank"),
    empty("design", { owner: { kind: "design-project", projectId: "project-1" } }),
  ]);
  assert.equal(await migrateEmptyWorkspaceChats(h.deps), 1);
  assert.deepEqual(h.removed, ["blank"]);
  assert.ok(h.records.has("design"));
});
```

- [ ] **Step 2: Run them and watch them fail.**
  Run `npx tsx --test main/services/chat-fork-service.test.ts main/services/rpiv-btw/service.test.ts main/services/empty-chat-migration.test.ts`.
  Expected: the three new tests FAIL.
  - Fork: the F-3.2 store guard makes the `ineligible` assertions pass, but `admitted` equals `["default", "default"]`, because the service admits the workspace before copying.
  - BTW: it resolves.
  - Migration: `"design"` is removed.

- [ ] **Step 3: Implement.**

`main/services/chat-fork-service.ts`: add `import { chatSurface } from "../../renderer/shared/chat-visibility.js";`. Then insert the following **before** the `if (source.botId)` branch, so a feature chat is refused before any Bot copy path:

```ts
        if (chatSurface(source) === "feature") {
          throw new ChatForkError(
            "ineligible",
            "This chat belongs to another Aiden feature and cannot be copied.",
          );
        }
```

The Assistant check below it stays as it is.

`main/services/rpiv-btw/service-core.ts`: replace line 108's condition with `if (chatSurface(chat) !== "regular") {`. Then import `chatSurface` from `../../../renderer/shared/chat-visibility.js`, and drop the now-unused `ASSISTANT_WORKSPACE_ID` import.

`main/services/empty-chat-migration.ts`:

```ts
export function isLegacyEmptyWorkspaceChat(
  chat: Chat,
  workspaceIds: ReadonlySet<string>,
  reservedChatIds: ReadonlySet<string>,
): boolean {
  const workspaceId = persistedChatWorkspaceId(chat.workspaceId);
  return chat.messages.length === 0 && chatSurface(chat) === "regular" &&
    workspaceIds.has(workspaceId) &&
    !chat.id.startsWith("telegram-") && !chat.id.startsWith("assistant-") &&
    !reservedChatIds.has(chat.id);
}
```

Replace the `ASSISTANT_WORKSPACE_ID` import with `import { chatSurface } from "../../renderer/shared/chat-visibility.js";`.

- [ ] **Step 4: Run them and watch them pass.**
  Run the same command. Expected: all pass, including "only zero-message ordinary workspace chats qualify, regardless of title".

- [ ] **Step 5: Register the tests.**
  1. Append `main/services/chat-fork-service.test.ts main/services/rpiv-btw/service.test.ts main/services/empty-chat-migration.test.ts` to `test:chat-visibility`. They are already assigned to lanes.
  2. Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add main/services/chat-fork-service.ts main/services/rpiv-btw/service-core.ts main/services/empty-chat-migration.ts main/services/chat-fork-service.test.ts main/services/rpiv-btw/service.test.ts main/services/empty-chat-migration.test.ts package.json
git commit -F - <<'EOF'
feat(chats): refuse fork, side questions and empty sweeps on owned chats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-3.5: PR A gates

- [ ] **Step 1: Run the narrow and adjacent suites.**
  ```bash
  npm run test:chat-visibility
  npm run test:aiden-remote
  npm run test:aiden-service-boundary
  npm run test:slash-commands
  npm run test:ci:registry
  npm run test:ci-policy
  ```
  Expected: every command passes.

- [ ] **Step 2: Run the full lanes for the touched files.**
  ```bash
  node scripts/run-ci-tests.mjs --lane core-git --summary
  node scripts/run-ci-tests.mjs --lane runtime-subagents --summary
  node scripts/run-ci-tests.mjs --lane renderer-other --summary
  ```
  Expected: green.

- [ ] **Step 3: Run static checks.**
  `npm run type-check && npm run lint`. Expected: clean.

- [ ] **Step 4: Run the native contract suites as regression evidence.** There is no wire change, but AGENTS.md requires these when a shared server projection changes.
  ```bash
  xcodebuild test -quiet -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO
  (cd android && ./gradlew :app:testDebugUnitTest --stacktrace)
  ```
  Expected: pass. Record the counts in the PR description. If a different simulator is installed, list one with `xcrun simctl list devices available`.

- [ ] **Step 5: Write the memory note and open the PR.**
  1. Add `.memory/chat-visibility.md` covering:
     - `chatSurface()` and the four surfaces.
     - The rule that `list()` / `listSummaryMetadata()` stay unfiltered, and why.
     - The site table in ADR-F F-D5.
     - That the Remote Assistant direct-ID read was left unchanged (Q2).
  2. Commit it with the trailer, push `feature/studio-chat-visibility`, and open the PR. End the PR body with:
     ```
     🤖 Generated with [Claude Code](https://claude.com/claude-code)
     ```

---
# PR B: Studio Foundation (`feature/studio-foundation`)

Task order inside PR B matters. Routes (F-2.2) must exist before commands (F-2.3) and the sidebar (F-2.4), because TanStack's typed `navigate({ to: "/design" })` requires the route.

## Task F-1.1: Studio feature flags

**Files:**
- Create: `main/services/studio/feature-flags.ts`
- Test: `main/services/studio/feature-flags.test.ts`
- Modify: `package.json` (new `test:studio-foundation`, appended to `test:serial`), `scripts/ci-test-registry.json` (`core-git`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const DESIGN_STUDIO_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_STUDIO";
  export const CREATE_IMAGES_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_CREATE_IMAGES";
  export function designStudioEnabled(environment?: Readonly<Record<string, string | undefined>>): boolean;
  export function createImagesEnabled(environment?: Readonly<Record<string, string | undefined>>): boolean;
  export function studioAssetsEnabled(environment?: Readonly<Record<string, string | undefined>>): boolean;
  export function studioCapabilities(environment?: Readonly<Record<string, string | undefined>>): { designStudio: boolean; createImages: boolean };
  ```

- [ ] **Step 1: Write the failing test** in `main/services/studio/feature-flags.test.ts`. It follows the style of `main/services/devices/feature-flag.test.ts`.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_FEATURE_FLAG,
  DESIGN_STUDIO_FEATURE_FLAG,
  studioAssetsEnabled,
  studioCapabilities,
} from "./feature-flags.js";

test("studio features stay off unless their own experimental flag is set", () => {
  assert.deepEqual(studioCapabilities({}), { designStudio: false, createImages: false });
  assert.deepEqual(studioCapabilities({ [DESIGN_STUDIO_FEATURE_FLAG]: "1" }), {
    designStudio: true,
    createImages: false,
  });
  assert.deepEqual(studioCapabilities({ [CREATE_IMAGES_FEATURE_FLAG]: " TRUE " }), {
    designStudio: false,
    createImages: true,
  });
  for (const value of ["0", "", "yes", "on", "false"]) {
    assert.deepEqual(
      studioCapabilities({ [DESIGN_STUDIO_FEATURE_FLAG]: value, [CREATE_IMAGES_FEATURE_FLAG]: value }),
      { designStudio: false, createImages: false },
      value,
    );
  }
});

test("the shared asset store opens when either studio feature is on", () => {
  assert.equal(studioAssetsEnabled({}), false);
  assert.equal(studioAssetsEnabled({ [DESIGN_STUDIO_FEATURE_FLAG]: "1" }), true);
  assert.equal(studioAssetsEnabled({ [CREATE_IMAGES_FEATURE_FLAG]: "true" }), true);
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run `npx tsx --test main/services/studio/feature-flags.test.ts`. Expected: FAIL, `Cannot find module './feature-flags.js'`.

- [ ] **Step 3: Implement** `main/services/studio/feature-flags.ts`.

```ts
export const DESIGN_STUDIO_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_STUDIO";
export const CREATE_IMAGES_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_CREATE_IMAGES";

type Environment = Readonly<Record<string, string | undefined>>;

function flagOn(environment: Environment, name: string): boolean {
  const value = environment[name]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Design Studio stays dark (no route, row, command, store or protocol) until explicitly enabled. */
export function designStudioEnabled(environment: Environment = process.env): boolean {
  return flagOn(environment, DESIGN_STUDIO_FEATURE_FLAG);
}

/** Create Images stays dark until explicitly enabled. */
export function createImagesEnabled(environment: Environment = process.env): boolean {
  return flagOn(environment, CREATE_IMAGES_FEATURE_FLAG);
}

/** The shared studio asset store and `aiden-asset:` protocol exist only for an enabled studio feature. */
export function studioAssetsEnabled(environment: Environment = process.env): boolean {
  return designStudioEnabled(environment) || createImagesEnabled(environment);
}

export function studioCapabilities(environment: Environment = process.env): {
  designStudio: boolean;
  createImages: boolean;
} {
  return {
    designStudio: designStudioEnabled(environment),
    createImages: createImagesEnabled(environment),
  };
}
```

- [ ] **Step 4: Run it and watch it pass.** Run the same command. Expected: 2 tests pass.

- [ ] **Step 5: Register the test.**
  1. Add `"test:studio-foundation": "tsx --test main/services/studio/feature-flags.test.ts",` to `package.json`, and append ` && npm run test:studio-foundation` to the end of `test:serial`. If PR A has merged, it sits after `npm run test:chat-visibility`.
  2. Add `"main/services/studio/feature-flags.test.ts"` to the `core-git` lane.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add main/services/studio/feature-flags.ts main/services/studio/feature-flags.test.ts package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(studio): add default-off Design Studio and Create Images flags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-1.2: Expose the capabilities to the renderer

**Files:**
- Modify: `main/handlers/app.ts` (:38-53), `renderer/lib/app-capabilities.tsx` (:4-60)
- Test: `renderer/lib/app-capabilities.test.ts` (new; `renderer-other`)

**Interfaces:**
- Consumes: `studioCapabilities()` (F-1.1).
- Produces: `AppCapabilities.designStudio: boolean` and `AppCapabilities.createImages: boolean`. Both are `false` in `DISABLED_APP_CAPABILITIES`, and `parseAppCapabilities` accepts only literal `true`.

- [ ] **Step 1: Write the failing test** in `renderer/lib/app-capabilities.test.ts`.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DISABLED_APP_CAPABILITIES, parseAppCapabilities } from "./app-capabilities.js";

test("studio capabilities fail closed until main enables them with a literal true", () => {
  assert.equal(DISABLED_APP_CAPABILITIES.designStudio, false);
  assert.equal(DISABLED_APP_CAPABILITIES.createImages, false);
  assert.equal(parseAppCapabilities({}).designStudio, false);
  for (const value of ["true", 1, "1", {}, null]) {
    const parsed = parseAppCapabilities({ designStudio: value, createImages: value });
    assert.equal(parsed.designStudio, false, JSON.stringify(value));
    assert.equal(parsed.createImages, false, JSON.stringify(value));
  }
});

test("each studio capability is independent of the others", () => {
  assert.deepEqual(parseAppCapabilities({ designStudio: true }), {
    ...DISABLED_APP_CAPABILITIES,
    designStudio: true,
  });
  assert.deepEqual(parseAppCapabilities({ createImages: true, devices: true }), {
    ...DISABLED_APP_CAPABILITIES,
    createImages: true,
    devices: true,
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run `npx tsx --test renderer/lib/app-capabilities.test.ts`. Expected: FAIL. The first assertion sees `undefined !== false` (TypeScript also reports the missing properties).

- [ ] **Step 3: Implement.**
  1. In `renderer/lib/app-capabilities.tsx`, add `designStudio: boolean;` and `createImages: boolean;` to the interface, `designStudio: false,` and `createImages: false,` to `DISABLED_APP_CAPABILITIES`, and `designStudio: record.designStudio === true,` and `createImages: record.createImages === true,` to `parseAppCapabilities`.
  2. In `main/handlers/app.ts`, import `studioCapabilities` from `../services/studio/feature-flags.js`, and add `...studioCapabilities(),` as the last entry of `capabilities`.

  `getInfo` imports Electron through `platform.js`, so it is not unit-tested. The end-to-end path is pinned by Playwright in F-5.4.

- [ ] **Step 4: Run it and watch it pass.**
  Run `npx tsx --test renderer/lib/app-capabilities.test.ts renderer/components/environment-subagents-contract.test.ts`. Expected: pass. The existing contract test builds on `DISABLED_APP_CAPABILITIES`, so it still holds. Then run `npm run type-check`.

- [ ] **Step 5: Register the test.**
  1. Append `renderer/lib/app-capabilities.test.ts` to `test:studio-foundation`.
  2. Add it to the `renderer-other` lane.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add main/handlers/app.ts renderer/lib/app-capabilities.tsx renderer/lib/app-capabilities.test.ts package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(studio): expose studio capabilities through app info

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-2.1: Studio path helper and workspace command visibility

**Files:**
- Create: `renderer/shared/studio-routes.ts`
- Test: `renderer/shared/studio-routes.test.ts` (new; `renderer-other`), `renderer/lib/command-system-core.test.ts` (extend)
- Modify: `renderer/lib/command-system-core.ts` (`workspaceCommandVisibility`, :41-52)

**Interfaces:**
- Produces:
  ```ts
  export type StudioFeature = "designStudio" | "createImages";
  export const STUDIO_ROUTE_ROOTS: Readonly<Record<StudioFeature, "/design" | "/images">>;
  export function studioFeatureForPath(pathname: string): StudioFeature | null;
  export function isStudioPath(pathname: string): boolean;
  ```
  `workspaceCommandVisibility(pathname)` returns `{ environment: false, terminal: false }` on studio paths.

- [ ] **Step 1: Write the failing tests.** Create `renderer/shared/studio-routes.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isStudioPath, studioFeatureForPath } from "./studio-routes.js";

test("studio routes match their root and nested paths only", () => {
  assert.equal(studioFeatureForPath("/design"), "designStudio");
  assert.equal(studioFeatureForPath("/design/project-1"), "designStudio");
  assert.equal(studioFeatureForPath("/images"), "createImages");
  assert.equal(studioFeatureForPath("/images/workflow-1"), "createImages");
  for (const pathname of ["/", "/designs", "/imagesx", "/chat/design", "/settings", "/bots/images"]) {
    assert.equal(studioFeatureForPath(pathname), null, pathname);
    assert.equal(isStudioPath(pathname), false, pathname);
  }
});
```

Append to `renderer/lib/command-system-core.test.ts`:

```ts
test("studio surfaces hide the Environment and terminal commands", () => {
  for (const pathname of ["/design", "/design/project-1", "/images", "/images/workflow-1"]) {
    assert.deepEqual(workspaceCommandVisibility(pathname), { environment: false, terminal: false }, pathname);
  }
  assert.deepEqual(workspaceCommandVisibility("/chat/chat-1"), { environment: true, terminal: true });
  assert.deepEqual(workspaceCommandVisibility("/settings"), { environment: false, terminal: false });
  assert.deepEqual(workspaceCommandVisibility("/scheduled"), { environment: true, terminal: false });
});
```

- [ ] **Step 2: Run them and watch them fail.**
  Run `npx tsx --test renderer/shared/studio-routes.test.ts renderer/lib/command-system-core.test.ts`.
  Expected: FAIL.
  - The module is missing.
  - The new core test fails with `environment: true` for `/design`.

- [ ] **Step 3: Implement.**

`renderer/shared/studio-routes.ts`:

```ts
export type StudioFeature = "designStudio" | "createImages";

/** Root path of each studio surface; nested routes live under the root. */
export const STUDIO_ROUTE_ROOTS = Object.freeze({
  designStudio: "/design",
  createImages: "/images",
} as const satisfies Record<StudioFeature, string>);

const FEATURES = Object.keys(STUDIO_ROUTE_ROOTS) as StudioFeature[];

export function studioFeatureForPath(pathname: string): StudioFeature | null {
  for (const feature of FEATURES) {
    const root = STUDIO_ROUTE_ROOTS[feature];
    if (pathname === root || pathname.startsWith(`${root}/`)) return feature;
  }
  return null;
}

export function isStudioPath(pathname: string): boolean {
  return studioFeatureForPath(pathname) !== null;
}
```

`renderer/lib/command-system-core.ts`: add `import { isStudioPath } from "../shared/studio-routes";` and change one line:

```ts
    environment: pathname !== "/settings" && !isStudioPath(pathname),
```

- [ ] **Step 4: Run them and watch them pass.** Run the same command. Expected: pass.

- [ ] **Step 5: Register the tests.**
  1. Append `renderer/shared/studio-routes.test.ts renderer/lib/command-system-core.test.ts` to `test:studio-foundation`.
  2. Add `renderer/shared/studio-routes.test.ts` to `renderer-other`. The core test is already assigned.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add renderer/shared/studio-routes.ts renderer/shared/studio-routes.test.ts renderer/lib/command-system-core.ts renderer/lib/command-system-core.test.ts package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(studio): recognize studio paths and hide workspace commands there

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-2.2: Capability-gated lazy routes, chat-layout suppression, placeholder views

**Files:**
- Create: `renderer/main/studio-capability-route.tsx`, `renderer/design/design-route.tsx`, `renderer/images/images-route.tsx`
- Modify: `renderer/main/router.tsx` (lazy views after :33; routes after :171; tree :185-198), `renderer/main/chat-layout.tsx` (:104, :109-114)
- Test: `renderer/main/studio-capability-route.test.tsx` (new; `renderer-other`)

**Interfaces:**
- Consumes: `useAppCapabilities` and `AppCapabilitiesProvider` (`renderer/lib/app-capabilities.tsx`), `StudioFeature` and `isStudioPath` (F-2.1), `lazyRouteComponent`, `preloadsWith` (`router.tsx:36-43`), `ScrollArea` and `EmptyState` (`renderer/components/ui.tsx`).
- Produces:
  - `StudioCapabilityRoute({ feature, children })`.
  - Routes `/design`, `/design/$projectId`, `/images` and `/images/$workflowId`.
  - `DesignRoute(props: { projectId?: string })` and `ImagesRoute(props: { workflowId?: string })`. These are the exact export names and props the DS and CI tracks replace without touching `router.tsx`.

- [ ] **Step 1: Write the failing test** in `renderer/main/studio-capability-route.test.tsx`.

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import { StudioCapabilityRoute } from "./studio-capability-route";

async function render(path: string, flags: { designStudio: boolean; createImages: boolean }) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <p>home</p> });
  const design = createRoute({
    getParentRoute: () => root,
    path: "/design",
    component: () => (
      <StudioCapabilityRoute feature="designStudio">
        <p>design body</p>
      </StudioCapabilityRoute>
    ),
  });
  const images = createRoute({
    getParentRoute: () => root,
    path: "/images",
    component: () => (
      <StudioCapabilityRoute feature="createImages">
        <p>images body</p>
      </StudioCapabilityRoute>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([home, design, images]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, ...flags }}>
      <RouterProvider router={router} />
    </AppCapabilitiesProvider>,
  );
}

test("studio routes render none of their feature while its capability is off", async () => {
  const off = { designStudio: false, createImages: false };
  assert.equal((await render("/design", off)).includes("design body"), false);
  assert.equal((await render("/images", off)).includes("images body"), false);
});

test("each studio route renders only under its own capability", async () => {
  assert.match(await render("/design", { designStudio: true, createImages: false }), /design body/u);
  assert.equal(
    (await render("/images", { designStudio: true, createImages: false })).includes("images body"),
    false,
  );
  assert.match(await render("/images", { designStudio: false, createImages: true }), /images body/u);
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run `npx tsx --test renderer/main/studio-capability-route.test.tsx`. Expected: FAIL, `Cannot find module './studio-capability-route'`.

- [ ] **Step 3: Implement.**

`renderer/main/studio-capability-route.tsx`:

```tsx
import { Navigate } from "@tanstack/react-router";
import * as React from "react";
import { useAppCapabilities } from "../lib/app-capabilities";
import type { StudioFeature } from "../shared/studio-routes";

/** A studio route exists only while its capability is on; otherwise it sends the user home. */
export function StudioCapabilityRoute({
  feature,
  children,
}: React.PropsWithChildren<{ feature: StudioFeature }>) {
  const capabilities = useAppCapabilities();
  return capabilities[feature] ? <>{children}</> : <Navigate to="/" replace />;
}
```

`renderer/design/design-route.tsx`. This is a placeholder until F-5.3 mounts the canvas.

```tsx
import { EmptyState, ScrollArea } from "../components/ui";

export function DesignRoute(_props: { projectId?: string }) {
  return (
    <ScrollArea title="Design">
      <EmptyState title="No design projects yet" description="Design projects will appear here." />
    </ScrollArea>
  );
}
```

`renderer/images/images-route.tsx`:

```tsx
import { EmptyState, ScrollArea } from "../components/ui";

export function ImagesRoute(_props: { workflowId?: string }) {
  return (
    <ScrollArea title="Images">
      <EmptyState title="No image workflows yet" description="Image workflows will appear here." />
    </ScrollArea>
  );
}
```

`renderer/main/router.tsx`:
1. After `BotChatRouteView` (:33), add:
   ```tsx
   const DesignView = lazyRouteComponent(() => import("../design/design-route"), "DesignRoute");
   const ImagesView = lazyRouteComponent(() => import("../images/images-route"), "ImagesRoute");
   ```
2. Import `StudioCapabilityRoute` from `./studio-capability-route`.
3. After `hostNewChatRoute` (:171), add:

```tsx
// Studio surfaces keep the chat shell's sidebar. ChatLayout suppresses the
// Environment workbench and terminal on these paths (isStudioPath).
const designRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/design",
  component: preloadsWith(function DesignStudioRoute() {
    return (
      <StudioCapabilityRoute feature="designStudio">
        <DesignView />
      </StudioCapabilityRoute>
    );
  }, DesignView),
  staticData: { title: "Design" },
});

const designProjectRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/design/$projectId",
  component: preloadsWith(function DesignStudioProjectRoute() {
    const { projectId } = designProjectRoute.useParams();
    return (
      <StudioCapabilityRoute feature="designStudio">
        <DesignView projectId={projectId} />
      </StudioCapabilityRoute>
    );
  }, DesignView),
  staticData: { title: "Design project" },
});

const imagesRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/images",
  component: preloadsWith(function CreateImagesRoute() {
    return (
      <StudioCapabilityRoute feature="createImages">
        <ImagesView />
      </StudioCapabilityRoute>
    );
  }, ImagesView),
  staticData: { title: "Images" },
});

const imagesWorkflowRoute = createRoute({
  getParentRoute: () => chatLayoutRoute,
  path: "/images/$workflowId",
  component: preloadsWith(function CreateImagesWorkflowRoute() {
    const { workflowId } = imagesWorkflowRoute.useParams();
    return (
      <StudioCapabilityRoute feature="createImages">
        <ImagesView workflowId={workflowId} />
      </StudioCapabilityRoute>
    );
  }, ImagesView),
  staticData: { title: "Image workflow" },
});
```

4. Add `designRoute, designProjectRoute, imagesRoute, imagesWorkflowRoute,` to the `chatLayoutRoute.addChildren([...])` list, after `hostNewChatRoute`.

`renderer/main/chat-layout.tsx`:
1. Import `isStudioPath` from `../shared/studio-routes`.
2. After `const onRemoteHost = …` (:36), add `const studioSurface = isStudioPath(pathname);`.
3. Change `<EnvironmentWorkbench suppressed={onRemoteHost}>` to `<EnvironmentWorkbench suppressed={onRemoteHost || studioSurface}>`.
4. Add `studioSurface ||` to the `TerminalDrawer` exclusion, after `onRemoteHost ||`.

- [ ] **Step 4: Run it and watch it pass.**
  Run `npx tsx --test renderer/main/studio-capability-route.test.tsx`. Expected: 2 tests pass. Then run `npm run type-check && npm run build && npm run check:bundle-budget`.
  - Expected: green.
  - Expected: `build/renderer/assets/` contains separate `design-route-*.js` and `images-route-*.js` chunks. Check with `ls build/renderer/assets | grep -E "design-route|images-route"`.
  - Record the bundle-budget numbers in the PR.

- [ ] **Step 5: Register the test.**
  1. Append `renderer/main/studio-capability-route.test.tsx` to `test:studio-foundation`.
  2. Add it to `renderer-other`.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add renderer/main/studio-capability-route.tsx renderer/main/studio-capability-route.test.tsx renderer/design/design-route.tsx renderer/images/images-route.tsx renderer/main/router.tsx renderer/main/chat-layout.tsx package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(studio): add capability-gated lazy Design and Images routes

Studio routes keep the chat-shell sidebar and suppress the Environment
workbench and terminal drawer.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-2.3: Palette commands `design.open` and `images.open`

**Files:**
- Modify: `renderer/shared/keybindings.ts` (`COMMAND_IDS` :5-33, `CommandDefinition` :39-54, `COMMANDS` :58-301), `renderer/lib/command-system-core.ts` (new `paletteCommands`), `renderer/components/command-palette.tsx` (`rootCommands`, :162-169), `renderer/main/root-view.tsx` (`RootContent`, next to `settings.open` at :159)
- Test: `renderer/lib/command-system-core.test.ts` (extend)

**Interfaces:**
- Consumes: `StudioFeature` (F-2.1) and `AppCapabilities` (F-1.2).
- Produces:
  - `CommandDefinition.requiresCapability?: StudioFeature`
  - `export function paletteCommands(capabilities: Readonly<Record<StudioFeature, boolean>>): CommandDefinition[]`
  - Command IDs `"design.open"` and `"images.open"`

- [ ] **Step 1: Write the failing test.** Append to `renderer/lib/command-system-core.test.ts`, and add `paletteCommands` to the import from `./command-system-core`.

```ts
test("palette omits studio commands while their capability is off", () => {
  const studio = (capabilities: { designStudio: boolean; createImages: boolean }) =>
    paletteCommands(capabilities)
      .map(({ id }) => id)
      .filter((id) => id === "design.open" || id === "images.open");

  assert.deepEqual(studio({ designStudio: false, createImages: false }), []);
  assert.deepEqual(studio({ designStudio: true, createImages: false }), ["design.open"]);
  assert.deepEqual(studio({ designStudio: false, createImages: true }), ["images.open"]);
  assert.deepEqual(studio({ designStudio: true, createImages: true }), ["design.open", "images.open"]);
  // With both flags off, nothing capability-gated remains in the palette.
  assert.ok(
    paletteCommands({ designStudio: false, createImages: false }).every(
      (definition) => definition.requiresCapability === undefined,
    ),
  );
});

test("studio commands never reserve a shortcut", () => {
  const bindings = effectiveBindings(undefined);
  assert.equal(bindings["design.open"], null);
  assert.equal(bindings["images.open"], null);
});
```

`effectiveBindings(overrides: unknown, legacy?)` (`keybindings.ts:751`) is already imported by this file and called the same way at `:70`.

- [ ] **Step 2: Run it and watch it fail.**
  Run `npx tsx --test renderer/lib/command-system-core.test.ts`. Expected: FAIL, because `paletteCommands` is not exported yet (`is not a function` / missing export).

- [ ] **Step 3: Implement.**

`renderer/shared/keybindings.ts`:
1. Add `import type { StudioFeature } from "./studio-routes.js";`.
2. Append `"design.open",` and `"images.open",` to `COMMAND_IDS` after `"settings.open",`.
3. Add this optional field to `CommandDefinition`:
   ```ts
     /** Hidden from the palette, and never handled, unless this capability is on. */
     requiresCapability?: StudioFeature;
   ```
4. Insert these two definitions after the `settings.open` command:

```ts
  command({
    id: "design.open",
    title: "Open Design Studio",
    description: "Open Design Studio projects.",
    category: "Navigate",
    keywords: ["design", "prototype", "screens", "studio"],
    defaultBinding: null,
    scope: "app",
    global: false,
    requiresCapability: "designStudio",
    showInPalette: true,
    showInSettings: false,
  }),
  command({
    id: "images.open",
    title: "Open Create Images",
    description: "Open image generation workflows.",
    category: "Navigate",
    keywords: ["images", "generate", "workflow", "canvas"],
    defaultBinding: null,
    scope: "app",
    global: false,
    requiresCapability: "createImages",
    showInPalette: true,
    showInSettings: false,
  }),
```

`renderer/lib/command-system-core.ts`: extend the keybindings import with `type CommandDefinition`, import `type StudioFeature` from `../shared/studio-routes`, and add:

```ts
/** Commands the palette may list for these capabilities; gated commands are absent, not disabled. */
export function paletteCommands(
  capabilities: Readonly<Record<StudioFeature, boolean>>,
): CommandDefinition[] {
  return COMMANDS.filter(
    (definition) =>
      definition.showInPalette &&
      (definition.requiresCapability === undefined || capabilities[definition.requiresCapability]),
  );
}
```

`renderer/components/command-palette.tsx`: import `paletteCommands` from `../lib/command-system-core`, and change `rootCommands` to:

```tsx
  const rootCommands = React.useMemo(() => {
    const order = new Map(recentCommands.map((id, index) => [id, index]));
    return paletteCommands(capabilities).sort(
      (left, right) =>
        (order.get(left.id) ?? Number.POSITIVE_INFINITY) -
        (order.get(right.id) ?? Number.POSITIVE_INFINITY),
    );
  }, [capabilities, recentCommands]);
```

`renderer/main/root-view.tsx`: import `useAppCapabilities` from `../lib/app-capabilities`. In `RootContent`, add `const capabilities = useAppCapabilities();` near the other hooks. Then, after the `settings.open` handler, add:

```tsx
  const openStudio = React.useCallback(
    (to: "/design" | "/images") => {
      if (navigationBlockedReason) {
        toast.info(navigationBlockedReason);
        return;
      }
      void navigate({ to });
    },
    [navigate, navigationBlockedReason],
  );
  useCommandHandler("design.open", () => openStudio("/design"), capabilities.designStudio);
  useCommandHandler("images.open", () => openStudio("/images"), capabilities.createImages);
```

- [ ] **Step 4: Run it and watch it pass.**
  Run `npx tsx --test renderer/lib/command-system-core.test.ts renderer/shared/keybindings.test.ts main/services/native-menu-command-contract.test.ts`. Expected: pass. Then run `npm run test:command-system && npm run type-check`.

- [ ] **Step 5: Register.** The test files are already registered (`renderer/lib/command-system-core.test.ts` was added to `test:studio-foundation` in F-2.1). Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add renderer/shared/keybindings.ts renderer/lib/command-system-core.ts renderer/lib/command-system-core.test.ts renderer/components/command-palette.tsx renderer/main/root-view.tsx
git commit -F - <<'EOF'
feat(studio): add capability-gated Design Studio and Create Images commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-2.4: Sidebar primary nav with Design and Images rows

**Files:**
- Create: `renderer/components/sidebar-primary-nav.tsx`
- Modify: `renderer/components/chat-sidebar.tsx` (replace the block at :1662-1684, add the import), `renderer/components/chat-sidebar.test.tsx` (**delete** the source-grep tests "sidebar places primary actions above the unified workspace outline" (:17-31) and "new agent uses the same sidebar row style as scheduled" (:33-39). Their behavior moves to the render test below and to Playwright F-5.4.)
- Test: `renderer/components/sidebar-primary-nav.test.tsx` (new; `renderer-other`)

**Interfaces:**
- Consumes: `SidebarListItem` (`ui.tsx:801`), `BotSidebarIcon` (`bot-avatar.tsx:230`), `studioFeatureForPath` (F-2.1), and `AppCapabilities` (F-1.2).
- Produces:
  ```ts
  export type SidebarPrimaryDestination = "/scheduled" | "/bots" | "/design" | "/images";
  export interface SidebarPrimaryNavProps {
    pathname: string;
    capabilities: Pick<AppCapabilities, "bots" | "designStudio" | "createImages">;
    newAgentDisabled: boolean;
    onNewAgent: () => void;
    onNavigate: (destination: SidebarPrimaryDestination) => void;
  }
  export function SidebarPrimaryNav(props: SidebarPrimaryNavProps): JSX.Element;
  ```

- [ ] **Step 1: Review the UI references.** Read `docs/design-guide.md`, `docs/chatgpt-desktop-ui-inspiration.md` (sidebar navigation) and `docs/chatgpt-ui-element-specimen.html` (list rows). Rows reuse `SidebarListItem` unchanged, including its fill focus state and `aria-current`.

- [ ] **Step 2: Write the failing test** in `renderer/components/sidebar-primary-nav.test.tsx`.

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import { SidebarPrimaryNav, type SidebarPrimaryNavProps } from "./sidebar-primary-nav";

const noop = () => undefined;
const ALL = { bots: true, designStudio: true, createImages: true };

function render(overrides: Partial<SidebarPrimaryNavProps> = {}) {
  const markup = renderToStaticMarkup(
    <SidebarPrimaryNav
      pathname="/chat/chat-1"
      capabilities={{ bots: true, designStudio: false, createImages: false }}
      newAgentDisabled={false}
      onNewAgent={noop}
      onNavigate={noop}
      {...overrides}
    />,
  );
  const document = new DOMParser().parseFromString(`<root>${markup}</root>`, "text/xml");
  const nav = Array.from(document.getElementsByTagName("nav"));
  const rows = Array.from(document.getElementsByTagName("button")).map((button) => ({
    title: button.textContent,
    current: button.getAttribute("aria-current"),
    disabled: button.hasAttribute("disabled"),
  }));
  return { label: nav[0]?.getAttribute("aria-label") ?? null, navCount: nav.length, rows };
}

test("with both flags off the nav is exactly New Agent, Scheduled, Bots", () => {
  const { label, navCount, rows } = render();
  assert.equal(navCount, 1);
  assert.equal(label, "Primary");
  assert.deepEqual(rows.map(({ title }) => title), ["New Agent", "Scheduled", "Bots"]);
  assert.deepEqual(
    render({ capabilities: { bots: false, designStudio: false, createImages: false } }).rows.map(({ title }) => title),
    ["New Agent", "Scheduled"],
  );
});

test("each studio row appears only with its own capability, after the existing rows", () => {
  const titles = (capabilities: SidebarPrimaryNavProps["capabilities"]) =>
    render({ capabilities }).rows.map(({ title }) => title);
  assert.deepEqual(titles({ bots: true, designStudio: true, createImages: false }), [
    "New Agent",
    "Scheduled",
    "Bots",
    "Design",
  ]);
  assert.deepEqual(titles({ bots: false, designStudio: false, createImages: true }), [
    "New Agent",
    "Scheduled",
    "Images",
  ]);
  assert.deepEqual(titles(ALL), ["New Agent", "Scheduled", "Bots", "Design", "Images"]);
});

test("the current row follows the path, including nested studio routes", () => {
  const current = (pathname: string) =>
    render({ pathname, capabilities: ALL }).rows.filter(({ current }) => current === "page").map(({ title }) => title);
  assert.deepEqual(current("/design"), ["Design"]);
  assert.deepEqual(current("/design/project-1"), ["Design"]);
  assert.deepEqual(current("/images/workflow-1"), ["Images"]);
  assert.deepEqual(current("/bots/bot-1"), ["Bots"]);
  assert.deepEqual(current("/scheduled"), ["Scheduled"]);
  assert.deepEqual(current("/chat/chat-1"), []);
});

test("New Agent reflects its disabled state and nothing else is disabled", () => {
  const { rows } = render({ newAgentDisabled: true, capabilities: ALL });
  assert.deepEqual(rows.filter(({ disabled }) => disabled).map(({ title }) => title), ["New Agent"]);
});
```

- [ ] **Step 3: Run it and watch it fail.**
  Run `npx tsx --test renderer/components/sidebar-primary-nav.test.tsx`. Expected: FAIL, `Cannot find module './sidebar-primary-nav'`.

- [ ] **Step 4: Implement** `renderer/components/sidebar-primary-nav.tsx`.

```tsx
import { Clock3, Images, PenTool, SquarePen } from "lucide-react";
import type { AppCapabilities } from "../lib/app-capabilities";
import { studioFeatureForPath } from "../shared/studio-routes";
import { BotSidebarIcon } from "./bot-avatar";
import { SidebarListItem } from "./ui";

export type SidebarPrimaryDestination = "/scheduled" | "/bots" | "/design" | "/images";

export interface SidebarPrimaryNavProps {
  pathname: string;
  capabilities: Pick<AppCapabilities, "bots" | "designStudio" | "createImages">;
  newAgentDisabled: boolean;
  onNewAgent: () => void;
  onNavigate: (destination: SidebarPrimaryDestination) => void;
}

/** Top-level destinations above the workspace outline. Studio rows exist only behind their flags. */
export function SidebarPrimaryNav({
  pathname,
  capabilities,
  newAgentDisabled,
  onNewAgent,
  onNavigate,
}: SidebarPrimaryNavProps) {
  const studio = studioFeatureForPath(pathname);
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 px-2.5 pb-2">
      <SidebarListItem
        icon={<SquarePen />}
        title="New Agent"
        disabled={newAgentDisabled}
        onClick={onNewAgent}
      />
      <SidebarListItem
        icon={<Clock3 />}
        title="Scheduled"
        selected={pathname === "/scheduled"}
        onClick={() => onNavigate("/scheduled")}
      />
      {capabilities.bots ? (
        <SidebarListItem
          icon={<BotSidebarIcon />}
          title="Bots"
          selected={pathname.startsWith("/bots")}
          onClick={() => onNavigate("/bots")}
        />
      ) : null}
      {capabilities.designStudio ? (
        <SidebarListItem
          icon={<PenTool />}
          title="Design"
          selected={studio === "designStudio"}
          onClick={() => onNavigate("/design")}
        />
      ) : null}
      {capabilities.createImages ? (
        <SidebarListItem
          icon={<Images />}
          title="Images"
          selected={studio === "createImages"}
          onClick={() => onNavigate("/images")}
        />
      ) : null}
    </nav>
  );
}
```

In `renderer/components/chat-sidebar.tsx`:
1. Import `SidebarPrimaryNav`.
2. Replace the `<div className="flex flex-col gap-0.5 px-2.5 pb-2">…</div>` block (:1662-1684) with:

```tsx
        <SidebarPrimaryNav
          pathname={pathname}
          capabilities={capabilities}
          newAgentDisabled={!activeId || appendReconciliationRequired}
          onNewAgent={() => void newAgent()}
          onNavigate={(to) => void navigate({ to })}
        />
```

3. Remove `Clock3`, `SquarePen` and `BotSidebarIcon` from the `chat-sidebar.tsx` imports only if `npm run lint` reports them unused.
4. Delete the two source-grep tests named above from `chat-sidebar.test.tsx`.

- [ ] **Step 5: Run it and watch it pass.**
  Run `npx tsx --test renderer/components/sidebar-primary-nav.test.tsx renderer/components/chat-sidebar.test.tsx`. Expected: pass. Then run `npm run test:sidebar && npm run type-check && npm run lint`.

- [ ] **Step 6: Register the test.**
  1. Append `renderer/components/sidebar-primary-nav.test.tsx` to `test:studio-foundation`.
  2. Add it to `renderer-other`.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 7: Commit.**

```bash
git add renderer/components/sidebar-primary-nav.tsx renderer/components/sidebar-primary-nav.test.tsx renderer/components/chat-sidebar.tsx renderer/components/chat-sidebar.test.tsx package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(studio): add flag-gated Design and Images sidebar rows

Extract the sidebar's primary nav into a rendered component and replace
its source-grep coverage with render tests.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-4.1: One privileged-scheme registration for `aiden-genui` and `aiden-asset`

**Files:**
- Create: `main/services/custom-schemes-core.ts` (pure), `main/services/custom-schemes.ts` (Electron)
- Modify: `main/services/generative-ui-protocol.ts` (delete `registerGenerativeUiScheme` and `schemesRegistered`, :12, :31-46), `main/index.ts` (imports at :99-102; the call at :162)
- Test: `main/services/custom-schemes-core.test.ts` (new; `core-git`)

**Interfaces:**
- Consumes: `GENERATIVE_UI_PROTOCOL_SCHEME` (`renderer/shared/generative-ui.ts:39`) and `studioAssetsEnabled()` (F-1.1).
- Produces:
  ```ts
  export const STUDIO_ASSET_SCHEME = "aiden-asset";
  export interface CustomSchemeDefinition { scheme: string; privileges: { standard: boolean; secure: boolean; bypassCSP: boolean; allowServiceWorkers: boolean; supportFetchAPI: boolean; corsEnabled: boolean; stream: boolean } }
  export function customSchemePrivileges(options: { studioAssets: boolean }): CustomSchemeDefinition[];
  export function createCustomSchemeRegistrar(target: { registerSchemesAsPrivileged(schemes: CustomSchemeDefinition[]): void }): (options: { studioAssets: boolean }) => boolean;
  export const registerCustomSchemes: (options: { studioAssets: boolean }) => boolean; // custom-schemes.ts
  ```

- [ ] **Step 1: Write the failing test** in `main/services/custom-schemes-core.test.ts`.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  createCustomSchemeRegistrar,
  customSchemePrivileges,
  type CustomSchemeDefinition,
} from "./custom-schemes-core.js";

test("only aiden-genui is privileged with both flags off", () => {
  assert.deepEqual(customSchemePrivileges({ studioAssets: false }).map(({ scheme }) => scheme), ["aiden-genui"]);
});

test("one registration call covers both schemes and later calls are ignored", () => {
  const calls: string[][] = [];
  const register = createCustomSchemeRegistrar({
    registerSchemesAsPrivileged: (schemes: CustomSchemeDefinition[]) => {
      calls.push(schemes.map(({ scheme }) => scheme));
    },
  });
  assert.equal(register({ studioAssets: true }), true);
  assert.equal(register({ studioAssets: true }), false);
  assert.equal(register({ studioAssets: false }), false);
  assert.deepEqual(calls, [["aiden-genui", "aiden-asset"]]);
});

test("no custom scheme can bypass CSP, run service workers, or be fetched cross-origin", () => {
  for (const { scheme, privileges } of customSchemePrivileges({ studioAssets: true })) {
    assert.equal(privileges.bypassCSP, false, scheme);
    assert.equal(privileges.allowServiceWorkers, false, scheme);
    assert.equal(privileges.supportFetchAPI, false, scheme);
    assert.equal(privileges.corsEnabled, false, scheme);
    assert.equal(privileges.secure, true, scheme);
  }
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run `npx tsx --test main/services/custom-schemes-core.test.ts`. Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement.**

`main/services/custom-schemes-core.ts`:

```ts
import { GENERATIVE_UI_PROTOCOL_SCHEME } from "../../renderer/shared/generative-ui.js";

export const STUDIO_ASSET_SCHEME = "aiden-asset";

export interface CustomSchemeDefinition {
  scheme: string;
  privileges: {
    standard: boolean;
    secure: boolean;
    bypassCSP: boolean;
    allowServiceWorkers: boolean;
    supportFetchAPI: boolean;
    corsEnabled: boolean;
    stream: boolean;
  };
}

const LOCAL_CONTENT_PRIVILEGES: CustomSchemeDefinition["privileges"] = Object.freeze({
  standard: true,
  secure: true,
  bypassCSP: false,
  allowServiceWorkers: false,
  supportFetchAPI: false,
  corsEnabled: false,
  stream: true,
});

/** Every custom scheme Aiden registers. Electron accepts exactly one call, before app ready. */
export function customSchemePrivileges(options: { studioAssets: boolean }): CustomSchemeDefinition[] {
  return [
    { scheme: GENERATIVE_UI_PROTOCOL_SCHEME, privileges: { ...LOCAL_CONTENT_PRIVILEGES } },
    ...(options.studioAssets
      ? [{ scheme: STUDIO_ASSET_SCHEME, privileges: { ...LOCAL_CONTENT_PRIVILEGES } }]
      : []),
  ];
}

export function createCustomSchemeRegistrar(target: {
  registerSchemesAsPrivileged(schemes: CustomSchemeDefinition[]): void;
}): (options: { studioAssets: boolean }) => boolean {
  let registered = false;
  return (options) => {
    if (registered) return false;
    target.registerSchemesAsPrivileged(customSchemePrivileges(options));
    registered = true;
    return true;
  };
}
```

`main/services/custom-schemes.ts`:

```ts
import { protocol } from "electron";
import { createCustomSchemeRegistrar } from "./custom-schemes-core.js";

/** Must run before `app.whenReady()`. Registers privileges only; handlers are installed later. */
export const registerCustomSchemes = createCustomSchemeRegistrar(protocol);
```

`main/services/generative-ui-protocol.ts`: delete `let schemesRegistered = false;` and the whole `registerGenerativeUiScheme` function. `registerGenerativeUiProtocol` is unchanged.

`main/index.ts`:
1. Remove `registerGenerativeUiScheme` from the `generative-ui-protocol.js` import.
2. Add `import { registerCustomSchemes } from "./services/custom-schemes.js";` and `import { studioAssetsEnabled } from "./services/studio/feature-flags.js";`.
3. Replace line 162 `registerGenerativeUiScheme();` with `registerCustomSchemes({ studioAssets: studioAssetsEnabled() });`.

The privileges for `aiden-genui` are unchanged. The previously omitted `bypassCSP` and `allowServiceWorkers` default to `false` in Electron.

- [ ] **Step 4: Run it and watch it pass.**
  Run `npx tsx --test main/services/custom-schemes-core.test.ts main/services/generative-ui-protocol.test.ts`. Expected: pass. Then run `grep -rn "registerSchemesAsPrivileged" main --include=*.ts | grep -v test`. Expected: exactly one hit, in `custom-schemes-core.ts`. Finally run `npm run type-check`.

- [ ] **Step 5: Register the test.**
  1. Append `main/services/custom-schemes-core.test.ts` to `test:studio-foundation`.
  2. Add it to `core-git`.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add main/services/custom-schemes-core.ts main/services/custom-schemes-core.test.ts main/services/custom-schemes.ts main/services/generative-ui-protocol.ts main/index.ts package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
refactor(protocol): register every privileged scheme in one call

aiden-asset joins aiden-genui only while a studio feature is enabled.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-4.2: Studio asset contract and image validation

**Files:**
- Create: `main/services/studio-assets/contract.ts`, `main/services/studio-assets/image-validation-core.ts`, `main/services/studio-assets/test-fixture.ts` (test helper, not a test file)
- Test: `main/services/studio-assets/image-validation-core.test.ts` (new; `core-git`)

**Interfaces:**
- Consumes: `displayImageDimensions(bytes: Buffer, mimeType: string)`, `validateDisplayImageDimensions(bytes: Buffer, mimeType: string, name: string)`, `MAX_DISPLAY_IMAGE_DIMENSION` and `MAX_DISPLAY_IMAGE_PIXELS` (`main/services/display-image-extension.ts:17-18, 326, 364`).
- Produces (`contract.ts`):
  ```ts
  export type StudioAssetMediaType = "image/png" | "image/jpeg" | "image/webp";
  export type StudioAssetThumbnailEdge = 256 | 512;
  export type StudioAssetRendition = "original" | "thumb-256" | "thumb-512";
  export const STUDIO_ASSET_HOLDER_KINDS: readonly ["design", "images-workflow", "images-run"];
  export interface StudioAssetHolder { kind: (typeof STUDIO_ASSET_HOLDER_KINDS)[number]; id: string }
  export interface StudioAssetRecord { assetId: string; mediaType: StudioAssetMediaType; bytes: number; width: number; height: number; createdAt: number }
  export interface StudioAssetLimits { maxAssetBytes: number; maxTotalBytes: number; maxAssets: number; maxEdge: number; maxPixels: number; gcGraceMs: number }
  export const STUDIO_ASSET_LIMITS: Readonly<StudioAssetLimits>;
  export type StudioAssetErrorCode = "invalid_image" | "too_large" | "quota" | "not_found" | "invalid_holder" | "unavailable";
  export class StudioAssetError extends Error { readonly code: StudioAssetErrorCode }
  export function isStudioAssetId(value: unknown): value is string;
  export function holderKey(holder: StudioAssetHolder): string;      // "design:<id>"
  export function parseHolderKey(key: string): StudioAssetHolder;
  ```
  `image-validation-core.ts` exports:
  ```ts
  export function sniffStudioImageType(bytes: Uint8Array): StudioAssetMediaType | undefined;
  export function validateStudioImage(bytes: Uint8Array, declaredMimeType: string | undefined, limits?: Pick<StudioAssetLimits, "maxEdge" | "maxPixels">): { mediaType: StudioAssetMediaType; width: number; height: number };
  ```

- [ ] **Step 1: Create the test fixture helper** `main/services/studio-assets/test-fixture.ts`.

```ts
// Test-only images. Aiden validates raster structure and header dimensions
// without decoding, so these need valid chunk layout but no real pixels.

export function pngBytes(width: number, height: number, seed = 0): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", Buffer.from([seed & 0xff, (seed >> 8) & 0xff])),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

export function fakeThumbnailer() {
  const calls: number[] = [];
  let failures = 0;
  return {
    calls,
    failNext() {
      failures += 1;
    },
    thumbnailer: {
      async render({ edge }: { bytes: Uint8Array; edge: 256 | 512 }) {
        calls.push(edge);
        if (failures > 0) {
          failures -= 1;
          throw new Error("decode failed");
        }
        return { bytes: pngBytes(edge, edge, 7), width: edge, height: edge };
      },
    },
  };
}
```

- [ ] **Step 2: Write the failing test** in `main/services/studio-assets/image-validation-core.test.ts`.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { holderKey, parseHolderKey, StudioAssetError } from "./contract.js";
import { sniffStudioImageType, validateStudioImage } from "./image-validation-core.js";
import { pngBytes } from "./test-fixture.js";

const code = (expected: StudioAssetError["code"]) => (error: unknown) =>
  error instanceof StudioAssetError && error.code === expected;

test("magic bytes decide the type; a mismatched declaration is rejected", () => {
  const png = pngBytes(640, 480);
  assert.equal(sniffStudioImageType(png), "image/png");
  assert.deepEqual(validateStudioImage(png, "image/png"), { mediaType: "image/png", width: 640, height: 480 });
  assert.deepEqual(validateStudioImage(png, undefined), { mediaType: "image/png", width: 640, height: 480 });
  assert.throws(() => validateStudioImage(png, "image/jpeg"), code("invalid_image"));
  assert.equal(sniffStudioImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), undefined);
  assert.throws(() => validateStudioImage(new TextEncoder().encode("GIF89a"), "image/gif"), code("invalid_image"));
});

test("a recognized signature with broken structure is rejected", () => {
  const truncated = pngBytes(10, 10).slice(0, 40);
  assert.throws(() => validateStudioImage(truncated, "image/png"), code("invalid_image"));
  const fakeWebp = new Uint8Array([...new TextEncoder().encode("RIFF"), 4, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
  assert.equal(sniffStudioImageType(fakeWebp), "image/webp");
  assert.throws(() => validateStudioImage(fakeWebp, "image/webp"), code("invalid_image"));
});

test("oversize dimensions are rejected before any decode", () => {
  assert.throws(() => validateStudioImage(pngBytes(20_000, 2), "image/png"), code("too_large"));
  assert.throws(() => validateStudioImage(pngBytes(5_000, 5_000), "image/png"), code("too_large"));
  assert.throws(
    () => validateStudioImage(pngBytes(300, 300), "image/png", { maxEdge: 256, maxPixels: 1_000_000 }),
    code("too_large"),
  );
});

test("holder keys round-trip the ADR strings and reject unsafe holders", () => {
  assert.equal(holderKey({ kind: "design", id: "project-1" }), "design:project-1");
  assert.equal(holderKey({ kind: "images-run", id: "run_42" }), "images-run:run_42");
  assert.deepEqual(parseHolderKey("images-workflow:wf.1"), { kind: "images-workflow", id: "wf.1" });
  for (const holder of [
    { kind: "bot", id: "b" },
    { kind: "design", id: "../escape" },
    { kind: "design", id: "" },
    { kind: "design", id: "a:b" },
  ]) {
    assert.throws(() => holderKey(holder as never), code("invalid_holder"), JSON.stringify(holder));
  }
});
```

- [ ] **Step 3: Run it and watch it fail.**
  Run `npx tsx --test main/services/studio-assets/image-validation-core.test.ts`. Expected: FAIL, the modules are missing.

- [ ] **Step 4: Implement.**

`main/services/studio-assets/contract.ts`:

```ts
import { MAX_DISPLAY_IMAGE_DIMENSION, MAX_DISPLAY_IMAGE_PIXELS } from "../display-image-extension.js";

export type StudioAssetMediaType = "image/png" | "image/jpeg" | "image/webp";
export type StudioAssetThumbnailEdge = 256 | 512;
export type StudioAssetRendition = "original" | "thumb-256" | "thumb-512";

/** Who keeps an asset alive. Keys are `${kind}:${id}`, matching ADR-DS and ADR-CI. */
export const STUDIO_ASSET_HOLDER_KINDS = ["design", "images-workflow", "images-run"] as const;
export type StudioAssetHolderKind = (typeof STUDIO_ASSET_HOLDER_KINDS)[number];
export interface StudioAssetHolder {
  kind: StudioAssetHolderKind;
  id: string;
}

export interface StudioAssetRecord {
  assetId: string;
  mediaType: StudioAssetMediaType;
  bytes: number;
  width: number;
  height: number;
  createdAt: number;
}

export interface StudioAssetLimits {
  maxAssetBytes: number;
  maxTotalBytes: number;
  maxAssets: number;
  maxEdge: number;
  maxPixels: number;
  /** Unheld assets survive this long after their last put or release. */
  gcGraceMs: number;
}

export const STUDIO_ASSET_LIMITS: Readonly<StudioAssetLimits> = Object.freeze({
  maxAssetBytes: 32 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024 * 1024,
  maxAssets: 100_000,
  maxEdge: MAX_DISPLAY_IMAGE_DIMENSION,
  maxPixels: MAX_DISPLAY_IMAGE_PIXELS,
  gcGraceMs: 60 * 60 * 1000,
});

export type StudioAssetErrorCode =
  | "invalid_image"
  | "too_large"
  | "quota"
  | "not_found"
  | "invalid_holder"
  | "unavailable";

export class StudioAssetError extends Error {
  constructor(
    readonly code: StudioAssetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioAssetError";
  }
}

const ASSET_ID = /^[0-9a-f]{64}$/u;
const HOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isStudioAssetId(value: unknown): value is string {
  return typeof value === "string" && ASSET_ID.test(value);
}

export function holderKey(holder: StudioAssetHolder): string {
  if (
    !holder ||
    !(STUDIO_ASSET_HOLDER_KINDS as readonly string[]).includes(holder.kind) ||
    typeof holder.id !== "string" ||
    !HOLDER_ID.test(holder.id)
  ) {
    throw new StudioAssetError("invalid_holder", "Invalid studio asset holder.");
  }
  return `${holder.kind}:${holder.id}`;
}

export function parseHolderKey(key: string): StudioAssetHolder {
  const separator = key.indexOf(":");
  const holder = { kind: key.slice(0, separator), id: key.slice(separator + 1) } as StudioAssetHolder;
  holderKey(holder);
  return holder;
}
```

`main/services/studio-assets/image-validation-core.ts`:

```ts
import { displayImageDimensions, validateDisplayImageDimensions } from "../display-image-extension.js";
import {
  STUDIO_ASSET_LIMITS,
  StudioAssetError,
  type StudioAssetLimits,
  type StudioAssetMediaType,
} from "./contract.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Content decides the type; extensions and declared MIME types never do. */
export function sniffStudioImageType(bytes: Uint8Array): StudioAssetMediaType | undefined {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export function validateStudioImage(
  bytes: Uint8Array,
  declaredMimeType: string | undefined,
  limits: Pick<StudioAssetLimits, "maxEdge" | "maxPixels"> = STUDIO_ASSET_LIMITS,
): { mediaType: StudioAssetMediaType; width: number; height: number } {
  const mediaType = sniffStudioImageType(bytes);
  if (!mediaType) {
    throw new StudioAssetError("invalid_image", "Only PNG, JPEG and WebP images are supported.");
  }
  const declared = declaredMimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (declared !== undefined && declared !== mediaType && !(declared === "image/jpg" && mediaType === "image/jpeg")) {
    throw new StudioAssetError("invalid_image", "The declared image type does not match its contents.");
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = displayImageDimensions(buffer, mediaType);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw new StudioAssetError("invalid_image", "The image is malformed.");
  }
  if (
    dimensions.width > limits.maxEdge ||
    dimensions.height > limits.maxEdge ||
    dimensions.width * dimensions.height > limits.maxPixels
  ) {
    throw new StudioAssetError("too_large", "The image is too large to decode safely.");
  }
  try {
    validateDisplayImageDimensions(buffer, mediaType, "The image");
  } catch (error) {
    throw new StudioAssetError(
      "invalid_image",
      error instanceof Error ? error.message : "The image is malformed.",
    );
  }
  return { mediaType, width: dimensions.width, height: dimensions.height };
}
```

- [ ] **Step 5: Run it and watch it pass.** Run the same command. Expected: 4 tests pass.

- [ ] **Step 6: Register the test.**
  1. Append `main/services/studio-assets/image-validation-core.test.ts` to `test:studio-foundation`.
  2. Add it to `core-git`.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 7: Commit.**

```bash
git add main/services/studio-assets/contract.ts main/services/studio-assets/image-validation-core.ts main/services/studio-assets/image-validation-core.test.ts main/services/studio-assets/test-fixture.ts package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(studio-assets): add asset contract and content-sniffed image validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-4.3: Content-addressed store with holder retention and GC

**Files:**
- Create: `main/services/studio-assets/store.ts`
- Test: `main/services/studio-assets/store.test.ts` (new; `core-git`)

**Interfaces:**
- Consumes: `writeFileAtomic` (`main/services/durable-fs.ts:77`), `DatabaseSync` (`node:sqlite`), and F-4.2's contract and validation.
- Produces:
  ```ts
  export interface StudioAssetThumbnailer {
    render(input: { bytes: Uint8Array; mediaType: StudioAssetMediaType; edge: StudioAssetThumbnailEdge }): Promise<{ bytes: Uint8Array; width: number; height: number }>;
  }
  export interface StudioAssetStoreOptions { root: () => string; thumbnailer: StudioAssetThumbnailer; now?: () => number; limits?: Partial<StudioAssetLimits> }
  export class StudioAssetStore {
    constructor(options: StudioAssetStoreOptions);
    initialize(): Promise<void>;
    close(): void;
    put(input: { bytes: Uint8Array; declaredMimeType?: string }): Promise<StudioAssetRecord>;
    get(assetId: string): StudioAssetRecord | undefined;
    read(assetId: string): Promise<{ record: StudioAssetRecord; bytes: Uint8Array }>;
    thumbnail(assetId: string, edge: StudioAssetThumbnailEdge): Promise<{ bytes: Uint8Array; mediaType: StudioAssetMediaType }>;
    retain(holder: StudioAssetHolder, assetIds: readonly string[]): void;
    release(holder: StudioAssetHolder, assetIds: readonly string[]): void;
    releaseAllForHolder(holder: StudioAssetHolder): number;
    replaceHolder(holder: StudioAssetHolder, assetIds: readonly string[]): void;
    holders(assetId: string): StudioAssetHolder[];
    usage(): { assets: number; bytes: number };
    collectGarbage(): Promise<{ deletedAssets: number; freedBytes: number }>;
  }
  ```

- [ ] **Step 1: Write the failing test** in `main/services/studio-assets/store.test.ts`.

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { StudioAssetError, type StudioAssetLimits } from "./contract.js";
import { StudioAssetStore } from "./store.js";
import { fakeThumbnailer, pngBytes } from "./test-fixture.js";

const HOUR = 60 * 60 * 1000;
const code = (expected: StudioAssetError["code"]) => (error: unknown) =>
  error instanceof StudioAssetError && error.code === expected;

async function fixture(t: TestContext, limits: Partial<StudioAssetLimits> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-studio-assets-"));
  let now = 1_000_000;
  const thumbs = fakeThumbnailer();
  const open = async () => {
    const store = new StudioAssetStore({ root: () => root, thumbnailer: thumbs.thumbnailer, now: () => now, limits });
    await store.initialize();
    t.after(() => store.close());
    return store;
  };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    thumbs,
    open,
    store: await open(),
    advance(ms: number) {
      now += ms;
    },
    async blobFiles() {
      const shards = await fs.readdir(path.join(root, "blobs"));
      return (await Promise.all(shards.map((shard) => fs.readdir(path.join(root, "blobs", shard))))).flat();
    },
  };
}

test("put stores validated bytes once and deduplicates identical content", async (t) => {
  const f = await fixture(t);
  const bytes = pngBytes(640, 480, 1);
  const first = await f.store.put({ bytes, declaredMimeType: "image/png" });
  const second = await f.store.put({ bytes });
  assert.match(first.assetId, /^[0-9a-f]{64}$/u);
  assert.deepEqual(second, first);
  assert.deepEqual(
    { mediaType: first.mediaType, width: first.width, height: first.height, bytes: first.bytes },
    { mediaType: "image/png", width: 640, height: 480, bytes: bytes.byteLength },
  );
  assert.deepEqual(Buffer.from((await f.store.read(first.assetId)).bytes), Buffer.from(bytes));
  assert.deepEqual(f.store.usage(), { assets: 1, bytes: bytes.byteLength });
  assert.deepEqual(await f.blobFiles(), [first.assetId]);
});

test("rejected images write nothing", async (t) => {
  const f = await fixture(t, { maxAssetBytes: 1_000 });
  await assert.rejects(f.store.put({ bytes: new TextEncoder().encode("not an image") }), code("invalid_image"));
  await assert.rejects(f.store.put({ bytes: pngBytes(20_000, 2) }), code("too_large"));
  await assert.rejects(f.store.put({ bytes: new Uint8Array(1_001) }), code("too_large"));
  assert.deepEqual(f.store.usage(), { assets: 0, bytes: 0 });
  assert.deepEqual(await f.blobFiles(), []);
});

test("only unheld assets past the grace period are collected, across a restart", async (t) => {
  const f = await fixture(t);
  const held = await f.store.put({ bytes: pngBytes(10, 10, 1) });
  const loose = await f.store.put({ bytes: pngBytes(10, 10, 2) });
  f.store.retain({ kind: "design", id: "project-1" }, [held.assetId]);

  assert.deepEqual(await f.store.collectGarbage(), { deletedAssets: 0, freedBytes: 0 });
  f.advance(2 * HOUR);
  f.store.close();
  const restarted = await f.open(); // initialize() collects too
  assert.equal(restarted.get(loose.assetId), undefined);
  await assert.rejects(restarted.read(loose.assetId), code("not_found"));
  assert.deepEqual(restarted.holders(held.assetId), [{ kind: "design", id: "project-1" }]);

  restarted.release({ kind: "design", id: "project-1" }, [held.assetId]);
  assert.equal((await restarted.collectGarbage()).deletedAssets, 0, "a fresh release is still within grace");
  f.advance(2 * HOUR);
  assert.equal((await restarted.collectGarbage()).deletedAssets, 1);
  assert.deepEqual(await f.blobFiles(), []);
});

test("holders are independent; releaseAll and replace change only their own holds", async (t) => {
  const f = await fixture(t);
  const [a, b, c] = await Promise.all([1, 2, 3].map((seed) => f.store.put({ bytes: pngBytes(10, 10, seed) })));
  const workflow = { kind: "images-workflow", id: "wf-1" } as const;
  const run = { kind: "images-run", id: "run-1" } as const;
  f.store.retain(workflow, [a!.assetId, b!.assetId]);
  f.store.retain(run, [b!.assetId]);

  assert.equal(f.store.releaseAllForHolder(workflow), 2);
  assert.deepEqual(f.store.holders(a!.assetId), []);
  assert.deepEqual(f.store.holders(b!.assetId), [run]);

  f.store.replaceHolder(workflow, [b!.assetId, c!.assetId]);
  f.store.replaceHolder(workflow, [c!.assetId]);
  assert.deepEqual(f.store.holders(b!.assetId), [run]);
  assert.deepEqual(f.store.holders(c!.assetId), [workflow]);
});

test("retain is atomic and refuses unknown assets and unsafe holders", async (t) => {
  const f = await fixture(t);
  const a = await f.store.put({ bytes: pngBytes(10, 10, 1) });
  assert.throws(
    () => f.store.retain({ kind: "design", id: "project-1" }, [a.assetId, "f".repeat(64)]),
    code("not_found"),
  );
  assert.deepEqual(f.store.holders(a.assetId), []);
  assert.throws(() => f.store.retain({ kind: "design", id: "../x" }, [a.assetId]), code("invalid_holder"));
});

test("a blob written without its row is swept on restart", async (t) => {
  const f = await fixture(t);
  const orphanId = "a".repeat(64);
  await fs.mkdir(path.join(f.root, "blobs", "aa"), { recursive: true });
  await fs.writeFile(path.join(f.root, "blobs", "aa", orphanId), pngBytes(4, 4));
  await fs.writeFile(path.join(f.root, "blobs", "aa", `.${orphanId}.crash.tmp`), "partial");
  await fs.writeFile(path.join(f.root, "thumbs", `${orphanId}-256.png`), pngBytes(4, 4));
  f.store.close();
  await f.open();
  assert.deepEqual(await f.blobFiles(), []);
  assert.deepEqual(await fs.readdir(path.join(f.root, "thumbs")), []);
});

test("store-wide quota fails closed", async (t) => {
  const f = await fixture(t, { maxAssets: 1 });
  await f.store.put({ bytes: pngBytes(10, 10, 1) });
  await assert.rejects(f.store.put({ bytes: pngBytes(10, 10, 2) }), code("quota"));
  assert.equal(f.store.usage().assets, 1);
});

test("thumbnails render once, are cached, and fall back to the original", async (t) => {
  const f = await fixture(t);
  const large = await f.store.put({ bytes: pngBytes(2_000, 1_000, 1) });
  const small = await f.store.put({ bytes: pngBytes(100, 100, 2) });

  const first = await f.store.thumbnail(large.assetId, 256);
  const again = await f.store.thumbnail(large.assetId, 256);
  assert.equal(first.mediaType, "image/png");
  assert.deepEqual(Buffer.from(again.bytes), Buffer.from(first.bytes));
  assert.deepEqual(f.thumbs.calls, [256]);

  const tiny = await f.store.thumbnail(small.assetId, 256);
  assert.deepEqual(Buffer.from(tiny.bytes), Buffer.from((await f.store.read(small.assetId)).bytes));
  assert.deepEqual(f.thumbs.calls, [256], "an image within the edge is served as-is");

  f.thumbs.failNext();
  const fallback = await f.store.thumbnail(large.assetId, 512);
  assert.deepEqual(Buffer.from(fallback.bytes), Buffer.from((await f.store.read(large.assetId)).bytes));
  await f.store.thumbnail(large.assetId, 512);
  assert.deepEqual(f.thumbs.calls, [256, 512, 512], "a failed render is not cached");
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run `npx tsx --test main/services/studio-assets/store.test.ts`. Expected: FAIL, `Cannot find module './store.js'`.

- [ ] **Step 3: Implement** `main/services/studio-assets/store.ts`, at about 280 lines.

```ts
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "../durable-fs.js";
import {
  STUDIO_ASSET_LIMITS,
  StudioAssetError,
  holderKey,
  isStudioAssetId,
  parseHolderKey,
  type StudioAssetHolder,
  type StudioAssetLimits,
  type StudioAssetMediaType,
  type StudioAssetRecord,
  type StudioAssetThumbnailEdge,
} from "./contract.js";
import { validateStudioImage } from "./image-validation-core.js";

export interface StudioAssetThumbnailer {
  render(input: {
    bytes: Uint8Array;
    mediaType: StudioAssetMediaType;
    edge: StudioAssetThumbnailEdge;
  }): Promise<{ bytes: Uint8Array; width: number; height: number }>;
}

export interface StudioAssetStoreOptions {
  /** Resolved lazily so a disabled feature never touches userData. */
  root: () => string;
  thumbnailer: StudioAssetThumbnailer;
  now?: () => number;
  limits?: Partial<StudioAssetLimits>;
}

interface AssetRow {
  id: string;
  media_type: StudioAssetMediaType;
  bytes: number;
  width: number;
  height: number;
  created_at: number;
}

const SCHEMA = `
  CREATE TABLE assets (id TEXT PRIMARY KEY, media_type TEXT NOT NULL, bytes INTEGER NOT NULL,
    width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL);
  CREATE TABLE holds (holder TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
    PRIMARY KEY (holder, asset_id));
  CREATE INDEX holds_by_asset ON holds(asset_id);
  PRAGMA user_version=1;
`;
const THUMBNAIL_EDGES: readonly StudioAssetThumbnailEdge[] = [256, 512];

function toRecord(row: AssetRow): StudioAssetRecord {
  return {
    assetId: row.id,
    mediaType: row.media_type,
    bytes: Number(row.bytes),
    width: Number(row.width),
    height: Number(row.height),
    createdAt: Number(row.created_at),
  };
}

/**
 * Content-addressed image store shared by Design Studio and Create Images.
 * Bytes are immutable files named by sha256; SQLite holds metadata and which
 * holders (projects, workflows, runs) keep each asset alive. An asset with no
 * holder is collected after a grace period measured from its last put or release.
 */
export class StudioAssetStore {
  private db: DatabaseSync | null = null;
  private root = "";
  private readonly now: () => number;
  private readonly limits: StudioAssetLimits;

  constructor(private readonly options: StudioAssetStoreOptions) {
    this.now = options.now ?? Date.now;
    this.limits = { ...STUDIO_ASSET_LIMITS, ...options.limits };
  }

  async initialize(): Promise<void> {
    if (this.db) return;
    const root = this.options.root();
    await fs.mkdir(path.join(root, "blobs"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(root, "thumbs"), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(root, "assets-v1.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (Number(version) === 0) {
        db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
      } else if (Number(version) !== 1) {
        throw new StudioAssetError("unavailable", "The studio asset database uses an unsupported schema.");
      }
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    this.root = root;
    await this.sweepOrphanFiles();
    await this.collectGarbage();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  get(assetId: string): StudioAssetRecord | undefined {
    const row = this.row(assetId);
    return row ? toRecord(row) : undefined;
  }

  usage(): { assets: number; bytes: number } {
    const row = this.requireDb()
      .prepare("SELECT COUNT(*) AS assets, COALESCE(SUM(bytes), 0) AS bytes FROM assets")
      .get() as { assets: number; bytes: number };
    return { assets: Number(row.assets), bytes: Number(row.bytes) };
  }

  async put(input: { bytes: Uint8Array; declaredMimeType?: string }): Promise<StudioAssetRecord> {
    const db = this.requireDb();
    if (input.bytes.byteLength > this.limits.maxAssetBytes) {
      throw new StudioAssetError(
        "too_large",
        `The image is larger than the ${Math.floor(this.limits.maxAssetBytes / (1024 * 1024))} MiB asset limit.`,
      );
    }
    const image = validateStudioImage(input.bytes, input.declaredMimeType, this.limits);
    const id = createHash("sha256").update(input.bytes).digest("hex");
    const existing = this.row(id);
    if (existing) {
      // A dedup hit restarts the grace period so a concurrent GC cannot take it.
      db.prepare("UPDATE assets SET touched_at = ? WHERE id = ?").run(this.now(), id);
      return toRecord(existing);
    }
    const usage = this.usage();
    if (
      usage.assets + 1 > this.limits.maxAssets ||
      usage.bytes + input.bytes.byteLength > this.limits.maxTotalBytes
    ) {
      throw new StudioAssetError(
        "quota",
        "Studio asset storage is full. Delete unused projects or workflows to free space.",
      );
    }
    const target = this.blobPath(id);
    try {
      await writeFileAtomic(target, input.bytes, { exclusive: true, mode: 0o600, mkdirMode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Same name means same content unless the file was damaged.
      if ((await fs.stat(target)).size !== input.bytes.byteLength) {
        throw new StudioAssetError("unavailable", "A stored studio asset is damaged.");
      }
    }
    const now = this.now();
    db.prepare(
      "INSERT OR IGNORE INTO assets (id, media_type, bytes, width, height, created_at, touched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, image.mediaType, input.bytes.byteLength, image.width, image.height, now, now);
    return toRecord(this.requireRow(id));
  }

  async read(assetId: string): Promise<{ record: StudioAssetRecord; bytes: Uint8Array }> {
    const row = this.requireRow(assetId);
    return { record: toRecord(row), bytes: await fs.readFile(this.blobPath(row.id)) };
  }

  async thumbnail(
    assetId: string,
    edge: StudioAssetThumbnailEdge,
  ): Promise<{ bytes: Uint8Array; mediaType: StudioAssetMediaType }> {
    const row = this.requireRow(assetId);
    if (Math.max(Number(row.width), Number(row.height)) <= edge) {
      return { bytes: await fs.readFile(this.blobPath(row.id)), mediaType: row.media_type };
    }
    const cached = this.thumbPath(row.id, edge);
    try {
      return { bytes: await fs.readFile(cached), mediaType: "image/png" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const original = await fs.readFile(this.blobPath(row.id));
    let rendered: { bytes: Uint8Array };
    try {
      rendered = await this.options.thumbnailer.render({ bytes: original, mediaType: row.media_type, edge });
    } catch {
      // nativeImage cannot decode every accepted format (for example WebP on
      // Linux). The original is within the validated pixel limit.
      return { bytes: original, mediaType: row.media_type };
    }
    // The cache is regenerable; a failed write only costs a re-render.
    await writeFileAtomic(cached, rendered.bytes, { fsync: false, mode: 0o600 }).catch(() => undefined);
    return { bytes: rendered.bytes, mediaType: "image/png" };
  }

  retain(holder: StudioAssetHolder, assetIds: readonly string[]): void {
    const key = holderKey(holder);
    this.transaction((db) => {
      const insert = db.prepare("INSERT OR IGNORE INTO holds (holder, asset_id) VALUES (?, ?)");
      for (const assetId of new Set(assetIds)) {
        this.requireRow(assetId);
        insert.run(key, assetId);
      }
    });
  }

  release(holder: StudioAssetHolder, assetIds: readonly string[]): void {
    const key = holderKey(holder);
    this.transaction((db) => {
      const remove = db.prepare("DELETE FROM holds WHERE holder = ? AND asset_id = ?");
      const touch = db.prepare("UPDATE assets SET touched_at = ? WHERE id = ?");
      const now = this.now();
      for (const assetId of new Set(assetIds)) {
        if (Number(remove.run(key, assetId).changes) > 0) touch.run(now, assetId);
      }
    });
  }

  releaseAllForHolder(holder: StudioAssetHolder): number {
    const key = holderKey(holder);
    return this.transaction((db) => {
      db.prepare(
        "UPDATE assets SET touched_at = ? WHERE id IN (SELECT asset_id FROM holds WHERE holder = ?)",
      ).run(this.now(), key);
      return Number(db.prepare("DELETE FROM holds WHERE holder = ?").run(key).changes);
    });
  }

  /** Set exact membership, for example from a workflow document's autosave. */
  replaceHolder(holder: StudioAssetHolder, assetIds: readonly string[]): void {
    const key = holderKey(holder);
    const next = new Set(assetIds);
    this.transaction((db) => {
      for (const assetId of next) this.requireRow(assetId);
      const current = (
        db.prepare("SELECT asset_id FROM holds WHERE holder = ?").all(key) as { asset_id: string }[]
      ).map(({ asset_id }) => asset_id);
      const remove = db.prepare("DELETE FROM holds WHERE holder = ? AND asset_id = ?");
      const touch = db.prepare("UPDATE assets SET touched_at = ? WHERE id = ?");
      const now = this.now();
      for (const assetId of current) {
        if (next.has(assetId)) continue;
        remove.run(key, assetId);
        touch.run(now, assetId);
      }
      const insert = db.prepare("INSERT OR IGNORE INTO holds (holder, asset_id) VALUES (?, ?)");
      for (const assetId of next) insert.run(key, assetId);
    });
  }

  holders(assetId: string): StudioAssetHolder[] {
    this.requireRow(assetId);
    return (
      this.requireDb()
        .prepare("SELECT holder FROM holds WHERE asset_id = ? ORDER BY holder")
        .all(assetId) as { holder: string }[]
    ).map(({ holder }) => parseHolderKey(holder));
  }

  async collectGarbage(): Promise<{ deletedAssets: number; freedBytes: number }> {
    const cutoff = this.now() - this.limits.gcGraceMs;
    // Synchronous transaction: no retain can interleave between select and delete.
    const doomed = this.transaction((db) => {
      const rows = db
        .prepare(
          "SELECT id, bytes FROM assets WHERE touched_at < ? AND NOT EXISTS (SELECT 1 FROM holds WHERE holds.asset_id = assets.id)",
        )
        .all(cutoff) as { id: string; bytes: number }[];
      const remove = db.prepare("DELETE FROM assets WHERE id = ?");
      for (const row of rows) remove.run(row.id);
      return rows;
    });
    for (const row of doomed) await this.removeFiles(row.id);
    return {
      deletedAssets: doomed.length,
      freedBytes: doomed.reduce((total, row) => total + Number(row.bytes), 0),
    };
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new StudioAssetError("unavailable", "Studio asset storage is not open.");
    return this.db;
  }

  private row(assetId: string): AssetRow | undefined {
    if (!isStudioAssetId(assetId)) return undefined;
    return this.requireDb()
      .prepare("SELECT id, media_type, bytes, width, height, created_at FROM assets WHERE id = ?")
      .get(assetId) as AssetRow | undefined;
  }

  private requireRow(assetId: string): AssetRow {
    const row = this.row(assetId);
    if (!row) throw new StudioAssetError("not_found", "This studio asset is no longer available.");
    return row;
  }

  private transaction<T>(work: (db: DatabaseSync) => T): T {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private blobPath(id: string): string {
    return path.join(this.root, "blobs", id.slice(0, 2), id);
  }

  private thumbPath(id: string, edge: StudioAssetThumbnailEdge): string {
    return path.join(this.root, "thumbs", `${id}-${edge}.png`);
  }

  private async removeFiles(id: string): Promise<void> {
    await fs.rm(this.blobPath(id), { force: true });
    for (const edge of THUMBNAIL_EDGES) await fs.rm(this.thumbPath(id, edge), { force: true });
  }

  /** Remove crash leftovers: staging files, blobs whose row never committed, orphan thumbnails. */
  private async sweepOrphanFiles(): Promise<void> {
    const blobs = path.join(this.root, "blobs");
    for (const shard of await fs.readdir(blobs, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      const directory = path.join(blobs, shard.name);
      for (const entry of await fs.readdir(directory)) {
        const staged = entry.startsWith(".") && entry.endsWith(".tmp");
        if (staged || (isStudioAssetId(entry) && !this.row(entry))) {
          await fs.rm(path.join(directory, entry), { force: true });
        }
      }
    }
    const thumbs = path.join(this.root, "thumbs");
    for (const entry of await fs.readdir(thumbs)) {
      const id = entry.slice(0, 64);
      if (!isStudioAssetId(id) || !this.row(id)) await fs.rm(path.join(thumbs, entry), { force: true });
    }
  }
}
```

- [ ] **Step 4: Run it and watch it pass.**
  Run `npx tsx --test main/services/studio-assets/store.test.ts`. Expected: 8 tests pass. Then run `npm run type-check`.

- [ ] **Step 5: Register the test.**
  1. Append `main/services/studio-assets/store.test.ts` to `test:studio-foundation`.
  2. Add it to `core-git`.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add main/services/studio-assets/store.ts main/services/studio-assets/store.test.ts package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(studio-assets): add content-addressed store with holder retention

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-4.4: Document-bound delivery grants

**Files:**
- Create: `main/services/studio-assets/delivery-core.ts`
- Test: `main/services/studio-assets/delivery-core.test.ts` (new; `core-git`)

**Interfaces:**
- Consumes: `RendererDocumentOwner` (`main/services/renderer-document-owner.ts:4-10`), `STUDIO_ASSET_SCHEME` (F-4.1), and `isStudioAssetId` and `StudioAssetRendition` (F-4.2).
- Produces:
  ```ts
  export type StudioAssetGrantOwner = Pick<RendererDocumentOwner, "id" | "documentId" | "isDestroyed" | "onInvalidated">;
  export class StudioAssetGrants {
    constructor(options?: { maxGrants?: number; token?: () => string });
    issue(owner: StudioAssetGrantOwner, assetId: string, rendition: StudioAssetRendition): string; // "aiden-asset://grant/<token>"
    resolve(token: string): { assetId: string; rendition: StudioAssetRendition } | undefined;
    revokeDocument(documentKey: string): number;
    size(): number;
  }
  export function studioAssetGrantToken(url: string): string | undefined;
  ```

- [ ] **Step 1: Write the failing test** in `main/services/studio-assets/delivery-core.test.ts`.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { StudioAssetError } from "./contract.js";
import { StudioAssetGrants, studioAssetGrantToken } from "./delivery-core.js";

const ASSET = "b".repeat(64);
const OTHER = "c".repeat(64);

function owner(id = 1, documentId = "7:1:token-a") {
  let destroyed = false;
  const listeners = new Set<() => void>();
  return {
    id,
    documentId,
    isDestroyed: () => destroyed,
    onInvalidated(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    navigate() {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  };
}

test("issued URLs carry only an opaque token that resolves to the asset", () => {
  const grants = new StudioAssetGrants();
  const url = grants.issue(owner(), ASSET, "original");
  assert.match(url, /^aiden-asset:\/\/grant\/[A-Za-z0-9_-]{43}$/u);
  assert.equal(url.includes(ASSET), false);
  assert.deepEqual(grants.resolve(studioAssetGrantToken(url)!), { assetId: ASSET, rendition: "original" });
});

test("grants deduplicate per document, asset and rendition", () => {
  const grants = new StudioAssetGrants();
  const a = owner(1, "doc-a");
  const b = owner(1, "doc-b");
  assert.equal(grants.issue(a, ASSET, "thumb-256"), grants.issue(a, ASSET, "thumb-256"));
  assert.notEqual(grants.issue(a, ASSET, "thumb-256"), grants.issue(a, ASSET, "thumb-512"));
  assert.notEqual(grants.issue(a, ASSET, "original"), grants.issue(b, ASSET, "original"));
  assert.equal(grants.size(), 3);
});

test("navigation revokes every grant of that document and only that document", () => {
  const grants = new StudioAssetGrants();
  const a = owner(1, "doc-a");
  const b = owner(2, "doc-b");
  const aUrls = [grants.issue(a, ASSET, "original"), grants.issue(a, OTHER, "thumb-256")];
  const bUrl = grants.issue(b, ASSET, "original");
  assert.equal(a.listeners(), 1, "one invalidation listener per document");

  a.navigate();
  for (const url of aUrls) assert.equal(grants.resolve(studioAssetGrantToken(url)!), undefined);
  assert.deepEqual(grants.resolve(studioAssetGrantToken(bUrl)!), { assetId: ASSET, rendition: "original" });
  assert.equal(a.listeners(), 0);
  assert.equal(grants.size(), 1);
});

test("a destroyed document can neither receive nor use grants", () => {
  const grants = new StudioAssetGrants();
  const a = owner();
  const url = grants.issue(a, ASSET, "original");
  a.navigate();
  assert.equal(grants.resolve(studioAssetGrantToken(url)!), undefined);
  assert.throws(
    () => grants.issue(a, ASSET, "original"),
    (error: unknown) => error instanceof StudioAssetError && error.code === "unavailable",
  );
  assert.throws(
    () => grants.issue(owner(), "../etc/passwd", "original"),
    (error: unknown) => error instanceof StudioAssetError && error.code === "not_found",
  );
});

test("capacity evicts the oldest grant first", () => {
  const grants = new StudioAssetGrants({ maxGrants: 2 });
  const a = owner();
  const first = grants.issue(a, ASSET, "original");
  const second = grants.issue(a, ASSET, "thumb-256");
  grants.issue(a, ASSET, "original"); // refreshes `first`
  const third = grants.issue(a, OTHER, "original");
  assert.equal(grants.resolve(studioAssetGrantToken(second)!), undefined);
  assert.ok(grants.resolve(studioAssetGrantToken(first)!));
  assert.ok(grants.resolve(studioAssetGrantToken(third)!));
});

test("only exact grant URLs yield a token", () => {
  const token = "A".repeat(43);
  assert.equal(studioAssetGrantToken(`aiden-asset://grant/${token}`), token);
  for (const url of [
    `aiden-asset://grant/${token}?x=1`,
    `aiden-asset://grant/${token}#f`,
    `aiden-asset://other/${token}`,
    `aiden-asset://grant/${token}/extra`,
    `aiden-genui://grant/${token}`,
    "aiden-asset://grant/short",
    "not a url",
  ]) {
    assert.equal(studioAssetGrantToken(url), undefined, url);
  }
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run `npx tsx --test main/services/studio-assets/delivery-core.test.ts`. Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement** `main/services/studio-assets/delivery-core.ts`.

```ts
import { randomBytes } from "node:crypto";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { STUDIO_ASSET_SCHEME } from "../custom-schemes-core.js";
import { isStudioAssetId, StudioAssetError, type StudioAssetRendition } from "./contract.js";

export type StudioAssetGrantOwner = Pick<
  RendererDocumentOwner,
  "id" | "documentId" | "isDestroyed" | "onInvalidated"
>;

const GRANT_HOST = "grant";
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const RENDITIONS: readonly StudioAssetRendition[] = ["original", "thumb-256", "thumb-512"];

interface Grant {
  assetId: string;
  rendition: StudioAssetRendition;
  documentKey: string;
  dedupeKey: string;
  owner: StudioAssetGrantOwner;
}

function grantUrl(token: string): string {
  return `${STUDIO_ASSET_SCHEME}://${GRANT_HOST}/${token}`;
}

/** The token of an exact `aiden-asset://grant/<token>` URL, or undefined. */
export function studioAssetGrantToken(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== `${STUDIO_ASSET_SCHEME}:` ||
    parsed.hostname !== GRANT_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }
  const token = parsed.pathname.slice(1);
  return TOKEN.test(token) ? token : undefined;
}

/**
 * Opaque, document-bound capabilities for `aiden-asset:` URLs. A grant lives
 * until its renderer document navigates, reloads, crashes or closes; there is
 * no TTL to renew. Feature handlers authorize the asset before issuing.
 */
export class StudioAssetGrants {
  private readonly grants = new Map<string, Grant>(); // insertion order is age
  private readonly tokensByKey = new Map<string, string>();
  private readonly documentListeners = new Map<string, () => void>();
  private readonly maxGrants: number;
  private readonly token: () => string;

  constructor(options: { maxGrants?: number; token?: () => string } = {}) {
    this.maxGrants = options.maxGrants ?? 8_192;
    this.token = options.token ?? (() => randomBytes(32).toString("base64url"));
  }

  issue(owner: StudioAssetGrantOwner, assetId: string, rendition: StudioAssetRendition): string {
    if (!isStudioAssetId(assetId) || !RENDITIONS.includes(rendition)) {
      throw new StudioAssetError("not_found", "This studio asset is no longer available.");
    }
    if (owner.isDestroyed()) {
      throw new StudioAssetError("unavailable", "The renderer document is no longer active.");
    }
    const documentKey = `${owner.id}:${owner.documentId}`;
    const dedupeKey = `${documentKey}|${assetId}|${rendition}`;
    const existing = this.tokensByKey.get(dedupeKey);
    if (existing) {
      const grant = this.grants.get(existing)!;
      this.grants.delete(existing);
      this.grants.set(existing, grant);
      return grantUrl(existing);
    }
    if (!this.documentListeners.has(documentKey)) {
      this.documentListeners.set(documentKey, owner.onInvalidated(() => this.revokeDocument(documentKey)));
    }
    const token = this.token();
    this.grants.set(token, { assetId, rendition, documentKey, dedupeKey, owner });
    this.tokensByKey.set(dedupeKey, token);
    while (this.grants.size > this.maxGrants) {
      this.remove(this.grants.keys().next().value as string);
    }
    return grantUrl(token);
  }

  resolve(token: string): { assetId: string; rendition: StudioAssetRendition } | undefined {
    const grant = this.grants.get(token);
    if (!grant) return undefined;
    if (grant.owner.isDestroyed()) {
      this.revokeDocument(grant.documentKey);
      return undefined;
    }
    return { assetId: grant.assetId, rendition: grant.rendition };
  }

  revokeDocument(documentKey: string): number {
    let revoked = 0;
    for (const [token, grant] of this.grants) {
      if (grant.documentKey !== documentKey) continue;
      this.remove(token);
      revoked += 1;
    }
    this.documentListeners.get(documentKey)?.();
    this.documentListeners.delete(documentKey);
    return revoked;
  }

  size(): number {
    return this.grants.size;
  }

  private remove(token: string): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    this.tokensByKey.delete(grant.dedupeKey);
  }
}
```

- [ ] **Step 4: Run it and watch it pass.** Run the same command. Expected: 6 tests pass.

- [ ] **Step 5: Register the test.**
  1. Append the test to `test:studio-foundation`.
  2. Add it to `core-git`.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add main/services/studio-assets/delivery-core.ts main/services/studio-assets/delivery-core.test.ts package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(studio-assets): add document-bound aiden-asset grants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-4.5: Protocol handler, startup wiring and the CSP token

**Files:**
- Create: `main/services/studio-assets/request-handler.ts` (pure), `main/services/studio-assets/protocol.ts`, `main/services/studio-assets/thumbnailer-main.ts`, `main/services/studio-assets/main.ts`
- Modify: `main/index.ts` (after `registerGenerativeUiProtocol();` at :1760), `main-window.html` (:8, `img-src` only)
- Test: `main/services/studio-assets/request-handler.test.ts` (new; `core-git`)

**Interfaces:**
- Consumes: `StudioAssetStore` (F-4.3), `StudioAssetGrants` and `studioAssetGrantToken` (F-4.4), `nativeImage` and `app` (`main/platform.ts:179-192`), `studioAssetsEnabled` (F-1.1), and `logger` (`main/platform.ts:54`).
- Produces:
  ```ts
  export function createStudioAssetRequestHandler(deps: {
    store: Pick<StudioAssetStore, "read" | "thumbnail">;
    grants: Pick<StudioAssetGrants, "resolve">;
  }): (request: Request) => Promise<Response>;
  export function registerStudioAssetProtocol(handler: (request: Request) => Promise<Response>): void; // protocol.ts
  export function createNativeStudioThumbnailer(): StudioAssetThumbnailer;                              // thumbnailer-main.ts
  export const studioAssetStore: StudioAssetStore;                                                       // main.ts
  export const studioAssetGrants: StudioAssetGrants;                                                     // main.ts
  ```

- [ ] **Step 1: Write the failing test** in `main/services/studio-assets/request-handler.test.ts`.

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { StudioAssetGrants } from "./delivery-core.js";
import { createStudioAssetRequestHandler } from "./request-handler.js";
import { StudioAssetStore } from "./store.js";
import { fakeThumbnailer, pngBytes } from "./test-fixture.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-studio-protocol-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 1_000_000;
  const store = new StudioAssetStore({
    root: () => root,
    thumbnailer: fakeThumbnailer().thumbnailer,
    now: () => now,
  });
  await store.initialize();
  t.after(() => store.close());
  const grants = new StudioAssetGrants();
  let destroyed = false;
  const listeners = new Set<() => void>();
  const owner = {
    id: 3,
    documentId: "3:1:main",
    isDestroyed: () => destroyed,
    onInvalidated: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    store,
    grants,
    owner,
    handle: createStudioAssetRequestHandler({ store, grants }),
    advance(ms: number) {
      now += ms;
    },
    navigate() {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

test("a granted original is served with safe headers", async (t) => {
  const f = await fixture(t);
  const bytes = pngBytes(64, 32, 1);
  const asset = await f.store.put({ bytes });
  const response = await f.handle(new Request(f.grants.issue(f.owner, asset.assetId, "original")));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(bytes));
});

test("thumbnail renditions serve PNG thumbnails", async (t) => {
  const f = await fixture(t);
  const asset = await f.store.put({ bytes: pngBytes(1_024, 768, 2) });
  const response = await f.handle(new Request(f.grants.issue(f.owner, asset.assetId, "thumb-256")));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
});

test("unknown, malformed and revoked URLs are not found", async (t) => {
  const f = await fixture(t);
  const asset = await f.store.put({ bytes: pngBytes(8, 8, 3) });
  const url = f.grants.issue(f.owner, asset.assetId, "original");
  for (const candidate of [`aiden-asset://grant/${"Z".repeat(43)}`, `${url}?download=1`, url.replace("grant", "other")]) {
    assert.equal((await f.handle(new Request(candidate))).status, 404, candidate);
  }
  f.navigate();
  assert.equal((await f.handle(new Request(url))).status, 404);
});

test("only GET and HEAD are served", async (t) => {
  const f = await fixture(t);
  const asset = await f.store.put({ bytes: pngBytes(8, 8, 4) });
  const url = f.grants.issue(f.owner, asset.assetId, "original");
  assert.equal((await f.handle(new Request(url, { method: "POST", body: "x" }))).status, 405);
  const head = await f.handle(new Request(url, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("a collected asset is not found and a closed store is unavailable", async (t) => {
  const f = await fixture(t);
  const collected = await f.store.put({ bytes: pngBytes(8, 8, 5) });
  const collectedUrl = f.grants.issue(f.owner, collected.assetId, "original");
  f.advance(2 * 60 * 60 * 1000);
  assert.equal((await f.store.collectGarbage()).deletedAssets, 1);
  // The grant outlives the asset; the response says "gone", not "broken".
  assert.equal((await f.handle(new Request(collectedUrl))).status, 404);

  const kept = await f.store.put({ bytes: pngBytes(8, 8, 6) });
  const keptUrl = f.grants.issue(f.owner, kept.assetId, "original");
  f.store.close();
  assert.equal((await f.handle(new Request(keptUrl))).status, 503);
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run `npx tsx --test main/services/studio-assets/request-handler.test.ts`. Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement.**

`main/services/studio-assets/request-handler.ts`:

```ts
import { StudioAssetError, type StudioAssetMediaType } from "./contract.js";
import { studioAssetGrantToken, type StudioAssetGrants } from "./delivery-core.js";
import type { StudioAssetStore } from "./store.js";

function status(code: 404 | 405 | 503): Response {
  const text = code === 404 ? "Not found" : code === 405 ? "Method not allowed" : "Unavailable";
  return new Response(text, { status: code, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Pure `aiden-asset:` handler; `protocol.ts` installs it once. */
export function createStudioAssetRequestHandler(deps: {
  store: Pick<StudioAssetStore, "read" | "thumbnail">;
  grants: Pick<StudioAssetGrants, "resolve">;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return status(405);
    const token = studioAssetGrantToken(request.url);
    const grant = token ? deps.grants.resolve(token) : undefined;
    if (!grant) return status(404);
    let body: { bytes: Uint8Array; mediaType: StudioAssetMediaType };
    try {
      body =
        grant.rendition === "original"
          ? await deps.store.read(grant.assetId).then(({ record, bytes }) => ({ bytes, mediaType: record.mediaType }))
          : await deps.store.thumbnail(grant.assetId, grant.rendition === "thumb-256" ? 256 : 512);
    } catch (error) {
      return status(error instanceof StudioAssetError && error.code === "not_found" ? 404 : 503);
    }
    return new Response(request.method === "HEAD" ? null : body.bytes, {
      status: 200,
      headers: {
        "content-type": body.mediaType,
        "cache-control": "no-store",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      },
    });
  };
}
```

`main/services/studio-assets/protocol.ts`:

```ts
import { protocol } from "electron";
import { STUDIO_ASSET_SCHEME } from "../custom-schemes-core.js";

let installed = false;

/** Install the `aiden-asset:` handler once, after the store has initialized. */
export function registerStudioAssetProtocol(handler: (request: Request) => Promise<Response>): void {
  if (installed) return;
  protocol.handle(STUDIO_ASSET_SCHEME, handler);
  installed = true;
}
```

`main/services/studio-assets/thumbnailer-main.ts` (follows `bot-avatar-image-main.ts:24-53`):

```ts
import { nativeImage } from "../../platform.js";
import type { StudioAssetThumbnailer } from "./store.js";

/** Chromium decode, longest-edge resize, PNG re-encode. Failures fall back to the original in the store. */
export function createNativeStudioThumbnailer(): StudioAssetThumbnailer {
  return {
    async render({ bytes, edge }) {
      if (!nativeImage || typeof nativeImage.createFromBuffer !== "function") {
        throw new Error("Image decoding is unavailable.");
      }
      const decoded = nativeImage.createFromBuffer(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        { scaleFactor: 1 },
      );
      if (decoded.isEmpty()) throw new Error("The image could not be decoded.");
      const size = decoded.getSize(1);
      const scale = Math.min(1, edge / Math.max(size.width, size.height));
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      const resized = decoded.resize({ width, height, quality: "good" });
      if (resized.isEmpty()) throw new Error("The image could not be resized.");
      return { bytes: resized.toPNG({ scaleFactor: 1 }), width, height };
    },
  };
}
```

`main/services/studio-assets/main.ts`:

```ts
import path from "node:path";
import { app } from "../../platform.js";
import { StudioAssetGrants } from "./delivery-core.js";
import { StudioAssetStore } from "./store.js";
import { createNativeStudioThumbnailer } from "./thumbnailer-main.js";

/** App-lifetime singletons. The root resolves only when a studio flag initializes the store. */
export const studioAssetStore = new StudioAssetStore({
  root: () => path.join(app.getPath("userData"), "studio-assets"),
  thumbnailer: createNativeStudioThumbnailer(),
});

export const studioAssetGrants = new StudioAssetGrants();
```

`main/index.ts`: add these imports.

```ts
import { createStudioAssetRequestHandler } from "./services/studio-assets/request-handler.js";
import { registerStudioAssetProtocol } from "./services/studio-assets/protocol.js";
import { studioAssetGrants, studioAssetStore } from "./services/studio-assets/main.js";
```

`studioAssetsEnabled` was already imported in F-4.1. Directly after `registerGenerativeUiProtocol();` (:1760), add:

```ts
      if (studioAssetsEnabled()) {
        try {
          await studioAssetStore.initialize();
          registerStudioAssetProtocol(
            createStudioAssetRequestHandler({ store: studioAssetStore, grants: studioAssetGrants }),
          );
        } catch (error) {
          logger.warn(
            "studio",
            "Studio assets are unavailable; Design and Images will report a storage error.",
            error,
          );
        }
      }
```

`main-window.html` line 8: change `img-src 'self' data: blob: file: https: http:` to `img-src 'self' data: blob: file: https: http: aiden-asset:`. Change no other directive.

- [ ] **Step 4: Run it and watch it pass.**
  Run `npx tsx --test main/services/studio-assets/request-handler.test.ts main/services/generative-ui-html.test.ts`. Expected: pass, and the existing `frame-src` and `script-src` CSP assertions still hold.
  Then run `npm run type-check && npm run build`.
  Then launch the app with no flags (`npm run dev`) and confirm that `~/Library/Application Support/<dev profile>/studio-assets` was **not** created. This is the flag-off no-trace check.

- [ ] **Step 5: Register the test.**
  1. Append `main/services/studio-assets/request-handler.test.ts` to `test:studio-foundation`.
  2. Add it to `core-git`.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add main/services/studio-assets/request-handler.ts main/services/studio-assets/request-handler.test.ts main/services/studio-assets/protocol.ts main/services/studio-assets/thumbnailer-main.ts main/services/studio-assets/main.ts main/index.ts main-window.html package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(studio-assets): serve granted assets over aiden-asset after reconcile

The store opens only while a studio flag is on. The CSP gains
aiden-asset: in img-src only (ADR-F F-D6).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-5.1: Canvas keymap core

**Files:**
- Create: `renderer/canvas/canvas-keymap-core.ts`, `renderer/canvas/canvas-viewport-core.ts`
- Test: `renderer/canvas/canvas-keymap-core.test.ts` (new; `renderer-other`)

**Interfaces:**
- Produces:
  ```ts
  export type CanvasTool = "select" | "hand";
  export type CanvasCommand =
    | { type: "tool"; tool: CanvasTool }
    | { type: "zoomIn" } | { type: "zoomOut" } | { type: "zoomReset" } | { type: "fitView" } | { type: "toggleMinimap" };
  export interface CanvasKeyEvent { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean; isComposing: boolean }
  export const CANVAS_TOOL_SHORTCUTS: Readonly<Record<CanvasTool, "V" | "H">>;
  export function resolveCanvasKey(event: CanvasKeyEvent, context: { editable: boolean }): CanvasCommand | null;
  // canvas-viewport-core.ts
  export const CANVAS_MIN_ZOOM = 0.1;
  export const CANVAS_MAX_ZOOM = 4;
  export function formatZoomPercent(zoom: number): string;
  ```

- [ ] **Step 1: Write the failing test** in `renderer/canvas/canvas-keymap-core.test.ts`.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveCanvasKey, type CanvasKeyEvent } from "./canvas-keymap-core";
import { formatZoomPercent } from "./canvas-viewport-core";

const key = (code: string, overrides: Partial<CanvasKeyEvent> = {}): CanvasKeyEvent => ({
  key: code.replace(/^Key|^Digit/u, "").toLowerCase(),
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  ...overrides,
});
const idle = { editable: false };

test("single letters switch tools and Shift digits fit or reset the zoom", () => {
  assert.deepEqual(resolveCanvasKey(key("KeyV"), idle), { type: "tool", tool: "select" });
  assert.deepEqual(resolveCanvasKey(key("KeyH"), idle), { type: "tool", tool: "hand" });
  assert.deepEqual(resolveCanvasKey(key("Digit1", { shiftKey: true, key: "!" }), idle), { type: "fitView" });
  assert.deepEqual(resolveCanvasKey(key("Digit0", { shiftKey: true, key: ")" }), idle), { type: "zoomReset" });
  assert.deepEqual(resolveCanvasKey(key("KeyM"), idle), { type: "toggleMinimap" });
});

test("plus and minus zoom, including the shifted plus and held repeats", () => {
  assert.deepEqual(resolveCanvasKey(key("Equal", { key: "=" }), idle), { type: "zoomIn" });
  assert.deepEqual(resolveCanvasKey(key("Equal", { key: "+", shiftKey: true }), idle), { type: "zoomIn" });
  assert.deepEqual(resolveCanvasKey(key("Minus", { key: "-", repeat: true }), idle), { type: "zoomOut" });
});

test("text entry, modifiers, IME and repeated tool keys never trigger canvas commands", () => {
  assert.equal(resolveCanvasKey(key("KeyV"), { editable: true }), null);
  // Command+V and Control+V stay paste; Command+= stays app zoom.
  assert.equal(resolveCanvasKey(key("KeyV", { metaKey: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyV", { ctrlKey: true }), idle), null);
  assert.equal(resolveCanvasKey(key("Equal", { key: "=", metaKey: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyH", { altKey: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyH", { isComposing: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyH", { repeat: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyV", { shiftKey: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyQ"), idle), null);
});

test("zoom percentages round to whole numbers", () => {
  assert.equal(formatZoomPercent(1), "100%");
  assert.equal(formatZoomPercent(1.2), "120%");
  assert.equal(formatZoomPercent(0.3333), "33%");
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run `npx tsx --test renderer/canvas/canvas-keymap-core.test.ts`. Expected: FAIL, the modules are missing.

- [ ] **Step 3: Implement.**

`renderer/canvas/canvas-viewport-core.ts`:

```ts
export const CANVAS_MIN_ZOOM = 0.1;
export const CANVAS_MAX_ZOOM = 4;

export function formatZoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
```

`renderer/canvas/canvas-keymap-core.ts`:

```ts
// Canvas keys are unmodified and handled on the focused canvas region only,
// never window-wide, so they reserve no app or global shortcut.

export type CanvasTool = "select" | "hand";

export type CanvasCommand =
  | { type: "tool"; tool: CanvasTool }
  | { type: "zoomIn" }
  | { type: "zoomOut" }
  | { type: "zoomReset" }
  | { type: "fitView" }
  | { type: "toggleMinimap" };

export interface CanvasKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
}

export const CANVAS_TOOL_SHORTCUTS = Object.freeze({ select: "V", hand: "H" } as const);

export function resolveCanvasKey(
  event: CanvasKeyEvent,
  context: { editable: boolean },
): CanvasCommand | null {
  if (context.editable || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }
  if (event.code === "Equal" || event.key === "+") return { type: "zoomIn" };
  if (event.code === "Minus" && !event.shiftKey) return { type: "zoomOut" };
  if (event.repeat) return null;
  if (event.shiftKey) {
    if (event.code === "Digit1") return { type: "fitView" };
    if (event.code === "Digit0") return { type: "zoomReset" };
    return null;
  }
  if (event.code === "KeyV") return { type: "tool", tool: "select" };
  if (event.code === "KeyH") return { type: "tool", tool: "hand" };
  if (event.code === "KeyM") return { type: "toggleMinimap" };
  return null;
}
```

- [ ] **Step 4: Run it and watch it pass.** Run the same command. Expected: 4 tests pass.

- [ ] **Step 5: Register the test.**
  1. Append `renderer/canvas/canvas-keymap-core.test.ts` to `test:studio-foundation`.
  2. Add it to `renderer-other`.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 6: Commit.**

```bash
git add renderer/canvas/canvas-keymap-core.ts renderer/canvas/canvas-viewport-core.ts renderer/canvas/canvas-keymap-core.test.ts package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(canvas): add canvas-scoped tool and zoom keymap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-5.2: Tool rail, zoom controls and node chrome

**Files:**
- Create: `renderer/canvas/canvas-tool-rail.tsx`, `renderer/canvas/canvas-zoom-controls.tsx`, `renderer/canvas/canvas-node-chrome.tsx`
- Test: `renderer/canvas/canvas-controls.test.tsx` (new; `renderer-other`)

**Interfaces:**
- Consumes: `Button` (`renderer/components/ui.tsx:61`; variants `transparent` and `muted`, `iconOnly`), lucide icons (`MousePointer2`, `Hand`, `ZoomIn`, `ZoomOut`, `Maximize`, `Map as MapIcon`), and F-5.1.
- Produces:
  ```ts
  export function CanvasToolRail(props: { tool: CanvasTool; onToolChange: (tool: CanvasTool) => void }): JSX.Element;
  export interface CanvasZoomControlsProps { zoom: number; minimapVisible: boolean; onZoomIn(): void; onZoomOut(): void; onResetZoom(): void; onFitView(): void; onToggleMinimap(): void }
  export function CanvasZoomControls(props: CanvasZoomControlsProps): JSX.Element;
  export function CanvasNodeChrome(props: React.PropsWithChildren<{ title: string; selected: boolean; status?: string; toolbar?: React.ReactNode }>): JSX.Element;
  ```

- [ ] **Step 1: Review the UI references.** Read `docs/design-guide.md` (squircle `Button`, fills not borders, neutral focus), `docs/chatgpt-desktop-ui-inspiration.md` (floating toolbars) and `docs/chatgpt-ui-element-specimen.html` (icon buttons, pressed states). A pressed tool is shown with the `muted` fill and `aria-pressed`, with no border. Status text is visible text, not only color.

- [ ] **Step 2: Write the failing test** in `renderer/canvas/canvas-controls.test.tsx`.

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import { CanvasNodeChrome } from "./canvas-node-chrome";
import { CanvasToolRail } from "./canvas-tool-rail";
import { CanvasZoomControls, type CanvasZoomControlsProps } from "./canvas-zoom-controls";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from "./canvas-viewport-core";

const noop = () => undefined;

function parse(element: ReactElement) {
  const document = new DOMParser().parseFromString(`<root>${renderToStaticMarkup(element)}</root>`, "text/xml");
  const all = Array.from(document.getElementsByTagName("*"));
  return {
    all,
    buttons: all.filter((node) => node.tagName === "button"),
    byRole: (role: string) => all.filter((node) => node.getAttribute("role") === role),
  };
}

test("the tool rail is a labelled toolbar of pressed toggles with their shortcuts", () => {
  const { byRole, buttons } = parse(<CanvasToolRail tool="hand" onToolChange={noop} />);
  assert.equal(byRole("toolbar")[0]?.getAttribute("aria-label"), "Canvas tools");
  assert.deepEqual(
    buttons.map((button) => [
      button.getAttribute("aria-label"),
      button.getAttribute("aria-pressed"),
      button.getAttribute("aria-keyshortcuts"),
    ]),
    [
      ["Select", "false", "V"],
      ["Hand", "true", "H"],
    ],
  );
});

const zoomProps: Omit<CanvasZoomControlsProps, "zoom"> = {
  minimapVisible: false,
  onZoomIn: noop,
  onZoomOut: noop,
  onResetZoom: noop,
  onFitView: noop,
  onToggleMinimap: noop,
};

test("zoom controls read out the zoom and disable at the limits", () => {
  const at = (zoom: number) => parse(<CanvasZoomControls zoom={zoom} {...zoomProps} />).buttons;
  const label = (zoom: number, name: string) =>
    at(zoom).find((button) => button.getAttribute("aria-label")?.startsWith(name));
  assert.equal(label(1.2, "Zoom 120%")?.textContent, "120%");
  assert.equal(label(CANVAS_MIN_ZOOM, "Zoom out")?.hasAttribute("disabled"), true);
  assert.equal(label(CANVAS_MAX_ZOOM, "Zoom in")?.hasAttribute("disabled"), true);
  assert.equal(label(1, "Zoom out")?.hasAttribute("disabled"), false);
  assert.equal(label(1, "Zoom in")?.hasAttribute("disabled"), false);
  assert.equal(label(1, "Fit to screen")?.getAttribute("aria-keyshortcuts"), "Shift+1");
});

test("the overview map toggle reports its state", () => {
  const toggle = (minimapVisible: boolean) =>
    parse(<CanvasZoomControls zoom={1} {...zoomProps} minimapVisible={minimapVisible} />).buttons.find(
      (button) => button.getAttribute("aria-label") === "Overview map",
    );
  assert.equal(toggle(false)?.getAttribute("aria-pressed"), "false");
  assert.equal(toggle(true)?.getAttribute("aria-pressed"), "true");
});

test("node chrome names the node, exposes selection, and shows status as text", () => {
  const { byRole, all } = parse(
    <CanvasNodeChrome title="Hero screen" selected status="Generating">
      <p>body</p>
    </CanvasNodeChrome>,
  );
  const group = byRole("group")[0];
  assert.equal(group?.getAttribute("aria-label"), "Hero screen");
  assert.equal(group?.getAttribute("data-selected"), "true");
  assert.ok(all.some((node) => node.textContent === "Generating"));
  assert.equal(
    parse(<CanvasNodeChrome title="Idle" selected={false}><p /></CanvasNodeChrome>).byRole("group")[0]?.getAttribute("data-selected"),
    "false",
  );
});
```

- [ ] **Step 3: Run it and watch it fail.**
  Run `npx tsx --test renderer/canvas/canvas-controls.test.tsx`. Expected: FAIL, the modules are missing.

- [ ] **Step 4: Implement.**

`renderer/canvas/canvas-tool-rail.tsx`:

```tsx
import { Hand, MousePointer2 } from "lucide-react";
import { Button } from "../components/ui";
import { CANVAS_TOOL_SHORTCUTS, type CanvasTool } from "./canvas-keymap-core";

const TOOLS = [
  { tool: "select", label: "Select", Icon: MousePointer2 },
  { tool: "hand", label: "Hand", Icon: Hand },
] as const satisfies readonly { tool: CanvasTool; label: string; Icon: typeof Hand }[];

export function CanvasToolRail({
  tool,
  onToolChange,
}: {
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      aria-orientation="vertical"
      className="glass-surface flex flex-col gap-1 rounded-button p-1 shadow-control"
    >
      {TOOLS.map(({ tool: item, label, Icon }) => {
        const shortcut = CANVAS_TOOL_SHORTCUTS[item];
        return (
          <Button
            key={item}
            variant={tool === item ? "muted" : "transparent"}
            iconOnly
            aria-label={label}
            aria-pressed={tool === item}
            aria-keyshortcuts={shortcut}
            title={`${label} (${shortcut})`}
            onClick={() => onToolChange(item)}
          >
            <Icon />
          </Button>
        );
      })}
    </div>
  );
}
```

`renderer/canvas/canvas-zoom-controls.tsx`:

```tsx
import { Map as MapIcon, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "../components/ui";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, formatZoomPercent } from "./canvas-viewport-core";

export interface CanvasZoomControlsProps {
  zoom: number;
  minimapVisible: boolean;
  onZoomIn(): void;
  onZoomOut(): void;
  onResetZoom(): void;
  onFitView(): void;
  onToggleMinimap(): void;
}

const EPSILON = 1e-6;

export function CanvasZoomControls({
  zoom,
  minimapVisible,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFitView,
  onToggleMinimap,
}: CanvasZoomControlsProps) {
  const percent = formatZoomPercent(zoom);
  return (
    <div
      role="toolbar"
      aria-label="Zoom"
      className="glass-surface flex items-center gap-0.5 rounded-button p-1 shadow-control"
    >
      <Button
        variant="transparent"
        iconOnly
        aria-label="Zoom out"
        aria-keyshortcuts="-"
        disabled={zoom <= CANVAS_MIN_ZOOM + EPSILON}
        onClick={onZoomOut}
      >
        <ZoomOut />
      </Button>
      <Button
        variant="transparent"
        aria-label={`Zoom ${percent}, reset to 100%`}
        aria-keyshortcuts="Shift+0"
        className="min-w-14 tabular-nums"
        onClick={onResetZoom}
      >
        {percent}
      </Button>
      <Button
        variant="transparent"
        iconOnly
        aria-label="Zoom in"
        aria-keyshortcuts="="
        disabled={zoom >= CANVAS_MAX_ZOOM - EPSILON}
        onClick={onZoomIn}
      >
        <ZoomIn />
      </Button>
      <Button variant="transparent" iconOnly aria-label="Fit to screen" aria-keyshortcuts="Shift+1" onClick={onFitView}>
        <Maximize />
      </Button>
      <Button
        variant={minimapVisible ? "muted" : "transparent"}
        iconOnly
        aria-label="Overview map"
        aria-pressed={minimapVisible}
        aria-keyshortcuts="M"
        onClick={onToggleMinimap}
      >
        <MapIcon />
      </Button>
    </div>
  );
}
```

`renderer/canvas/canvas-node-chrome.tsx`:

```tsx
import * as React from "react";
import { cn } from "../lib/ui-utils";

/** Shared frame for studio canvas nodes. Selection is a fill and an attribute, never a colored border. */
export function CanvasNodeChrome({
  title,
  selected,
  status,
  toolbar,
  children,
}: React.PropsWithChildren<{
  title: string;
  selected: boolean;
  status?: string;
  toolbar?: React.ReactNode;
}>) {
  return (
    <div
      role="group"
      aria-label={title}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex min-w-40 flex-col overflow-visible rounded-button bg-popover shadow-control",
        selected && "bg-list-selection",
      )}
    >
      <div className="flex min-h-9 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-strong text-primary">{title}</span>
        {status ? <span className="shrink-0 text-secondary">{status}</span> : null}
        {toolbar ? <div className="nodrag flex shrink-0 items-center gap-1">{toolbar}</div> : null}
      </div>
      <div className="min-h-0 flex-1 px-3 pb-3">{children}</div>
    </div>
  );
}
```

- [ ] **Step 5: Run it and watch it pass.**
  Run `npx tsx --test renderer/canvas/canvas-controls.test.tsx`. Expected: 4 tests pass. Then run `npm run lint`.

- [ ] **Step 6: Register the test.**
  1. Append `renderer/canvas/canvas-controls.test.tsx` to `test:studio-foundation`.
  2. Add it to `renderer-other`.
  3. Run `npm run test:ci:registry`.

- [ ] **Step 7: Commit.**

```bash
git add renderer/canvas/canvas-tool-rail.tsx renderer/canvas/canvas-zoom-controls.tsx renderer/canvas/canvas-node-chrome.tsx renderer/canvas/canvas-controls.test.tsx package.json scripts/ci-test-registry.json
git commit -F - <<'EOF'
feat(canvas): add tool rail, zoom controls and node chrome

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-5.3: Pin `@xyflow/react`, build `<StudioCanvas>` and `<StudioSurface>`, mount them in the placeholder routes

**Files:**
- Modify: `package.json` + `package-lock.json` (`@xyflow/react` 12.11.6 in `devDependencies`), `THIRD_PARTY_NOTICES.md`, `renderer/components/ui.tsx` (export `useSplitViewCollapsed`), `renderer/design/design-route.tsx`, `renderer/images/images-route.tsx`
- Create: `renderer/canvas/studio-canvas.tsx`, `renderer/canvas/studio-surface.tsx`, `renderer/canvas/studio-canvas.css`, `renderer/canvas/styles.ts`, `renderer/canvas/index.ts`
- Test: verified by build, bundle budget and the Playwright spec in F-5.4. xyflow needs a real DOM, and its behavior is user-visible.

**Interfaces:**
- Consumes: F-5.1, F-5.2, the `SplitContext` value `{ collapsed }` (`ui.tsx:387`), and xyflow 12's `ReactFlow`, `ReactFlowProvider`, `useReactFlow` (`zoomIn`, `zoomOut`, `zoomTo`, `fitView`), `useViewport`, `Background`, `BackgroundVariant` and `MiniMap`.
- Produces:
  ```ts
  export type StudioCanvasProps<N extends Node = Node, E extends Edge = Edge> =
    Omit<ReactFlowProps<N, E>, "panOnDrag" | "selectionOnDrag" | "minZoom" | "maxZoom" | "proOptions"> & {
      label: string; tool: CanvasTool; onToolChange(tool: CanvasTool): void;
      minimap: boolean; onMinimapChange(visible: boolean): void; emptyState?: React.ReactNode;
    };
  export function StudioCanvas<N extends Node = Node, E extends Edge = Edge>(props: StudioCanvasProps<N, E>): JSX.Element;
  export function StudioSurface(props: React.PropsWithChildren<{ title: string; actions?: React.ReactNode }>): JSX.Element;
  export function useSplitViewCollapsed(): boolean; // ui.tsx
  ```
  `renderer/canvas/index.ts` re-exports `StudioCanvas`, `StudioSurface`, `CanvasToolRail`, `CanvasZoomControls`, `CanvasNodeChrome`, `resolveCanvasKey` and the types. It does **not** re-export `styles.ts`.

- [ ] **Step 1: Pin the dependency.**
  1. Run `npm install --save-dev --save-exact @xyflow/react@12.11.6`.
  2. Confirm that `package.json` shows `"@xyflow/react": "12.11.6"` under `devDependencies`, and that `package-lock.json` resolves `@xyflow/system` `0.0.82`.
  3. Run `node --test scripts/main-runtime-dependencies.test.mjs`. Expected: pass, because the dependency is renderer-only.

- [ ] **Step 2: Add the third-party notice.** Append this section to `THIRD_PARTY_NOTICES.md`, after `## three.js`:

```markdown
## React Flow (@xyflow/react)

Renders the Design Studio and Create Images canvases. Loaded only when one of
those experimental surfaces is opened.

Copyright (c) 2019-2026 webkid GmbH

MIT License. https://github.com/xyflow/xyflow/blob/main/LICENSE
```

- [ ] **Step 3: Implement.**

`renderer/components/ui.tsx`: add this export directly after the `SplitContext` declaration (:387-392):

```tsx
/** Whether the leading sidebar is collapsed, for full-height chrome that must clear the window controls. */
export function useSplitViewCollapsed(): boolean {
  return React.useContext(SplitContext)?.collapsed === true;
}
```

`renderer/canvas/studio-canvas.css`:

```css
/* xyflow theme mapped onto Aiden's semantic tokens. Imported only by lazy studio routes. */
.studio-canvas {
  --xy-background-color: var(--color-background);
  --xy-background-pattern-color: var(--color-separator);
  --xy-edge-stroke: var(--color-tertiary);
  --xy-edge-stroke-selected: var(--color-accent);
  --xy-connectionline-stroke: var(--color-accent);
  --xy-selection-background-color: color-mix(in srgb, var(--color-accent) 12%, transparent);
  --xy-selection-border: none;
  --xy-minimap-background-color: var(--color-popover);
  --xy-node-background-color: transparent;
  --xy-node-border: none;
}

.studio-canvas:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
  .studio-canvas .react-flow__viewport {
    transition: none;
  }
}
```

`renderer/canvas/styles.ts`:

```ts
// Imported only by lazy route modules so React Flow CSS never enters the entry chunk.
import "@xyflow/react/dist/base.css";
import "./studio-canvas.css";
```

`renderer/canvas/studio-surface.tsx`:

```tsx
import * as React from "react";
import { useSplitViewCollapsed } from "../components/ui";

/** Full-height studio chrome: a drag-region header like ScrollArea's, then an unscrolled body. */
export function StudioSurface({
  title,
  actions,
  children,
}: React.PropsWithChildren<{ title: string; actions?: React.ReactNode }>) {
  const collapsed = useSplitViewCollapsed();
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header
        className="drag-region flex min-h-13 shrink-0 items-center gap-3 px-4 transition-[padding] duration-300 ease-out motion-reduce:transition-none"
        style={{ paddingLeft: collapsed ? 142 : undefined }}
      >
        <h1 className="min-w-0 flex-1 truncate text-strong text-primary">{title}</h1>
        {actions ? <div className="no-drag flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}
```

`renderer/canvas/studio-canvas.tsx`, at about 130 lines:

```tsx
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Edge,
  type Node,
  type ReactFlowProps,
} from "@xyflow/react";
import * as React from "react";
import { CanvasToolRail } from "./canvas-tool-rail";
import { CanvasZoomControls } from "./canvas-zoom-controls";
import { resolveCanvasKey, type CanvasTool } from "./canvas-keymap-core";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from "./canvas-viewport-core";

export type StudioCanvasProps<N extends Node = Node, E extends Edge = Edge> = Omit<
  ReactFlowProps<N, E>,
  "panOnDrag" | "selectionOnDrag" | "minZoom" | "maxZoom" | "proOptions"
> & {
  label: string;
  tool: CanvasTool;
  onToolChange(tool: CanvasTool): void;
  minimap: boolean;
  onMinimapChange(visible: boolean): void;
  emptyState?: React.ReactNode;
};

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export function StudioCanvas<N extends Node = Node, E extends Edge = Edge>(
  props: StudioCanvasProps<N, E>,
) {
  return (
    <ReactFlowProvider>
      <StudioCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function StudioCanvasInner<N extends Node, E extends Edge>({
  label,
  tool,
  onToolChange,
  minimap,
  onMinimapChange,
  emptyState,
  nodes,
  nodesDraggable,
  elementsSelectable,
  ...flowProps
}: StudioCanvasProps<N, E>) {
  const flow = useReactFlow<N, E>();
  const { zoom } = useViewport();
  const hand = tool === "hand";

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const command = resolveCanvasKey(
      {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
      },
      { editable: isEditableTarget(event.target) },
    );
    if (!command) return;
    event.preventDefault();
    if (command.type === "tool") onToolChange(command.tool);
    else if (command.type === "zoomIn") void flow.zoomIn({ duration: 0 });
    else if (command.type === "zoomOut") void flow.zoomOut({ duration: 0 });
    else if (command.type === "zoomReset") void flow.zoomTo(1, { duration: 0 });
    else if (command.type === "fitView") void flow.fitView({ duration: 0, padding: 0.2 });
    else onMinimapChange(!minimap);
  };

  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      data-tool={tool}
      className="studio-canvas relative h-full min-h-0 w-full"
      onKeyDown={onKeyDown}
    >
      <ReactFlow<N, E>
        {...flowProps}
        nodes={nodes}
        panOnDrag={hand ? true : [1, 2]}
        selectionOnDrag={!hand}
        panOnScroll
        nodesDraggable={!hand && nodesDraggable !== false}
        elementsSelectable={!hand && elementsSelectable !== false}
        minZoom={CANVAS_MIN_ZOOM}
        maxZoom={CANVAS_MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        {minimap ? <MiniMap pannable zoomable ariaLabel="Canvas overview" /> : null}
      </ReactFlow>
      {(nodes?.length ?? 0) === 0 && emptyState ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {emptyState}
        </div>
      ) : null}
      <div className="absolute left-3 top-1/2 -translate-y-1/2">
        <CanvasToolRail tool={tool} onToolChange={onToolChange} />
      </div>
      <div className="absolute bottom-3 right-3">
        <CanvasZoomControls
          zoom={zoom}
          minimapVisible={minimap}
          onZoomIn={() => void flow.zoomIn({ duration: 0 })}
          onZoomOut={() => void flow.zoomOut({ duration: 0 })}
          onResetZoom={() => void flow.zoomTo(1, { duration: 0 })}
          onFitView={() => void flow.fitView({ duration: 0, padding: 0.2 })}
          onToggleMinimap={() => onMinimapChange(!minimap)}
        />
      </div>
    </div>
  );
}
```

`renderer/canvas/index.ts`:

```ts
export { StudioCanvas, type StudioCanvasProps } from "./studio-canvas";
export { StudioSurface } from "./studio-surface";
export { CanvasToolRail } from "./canvas-tool-rail";
export { CanvasZoomControls, type CanvasZoomControlsProps } from "./canvas-zoom-controls";
export { CanvasNodeChrome } from "./canvas-node-chrome";
export { resolveCanvasKey, type CanvasCommand, type CanvasTool } from "./canvas-keymap-core";
export { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, formatZoomPercent } from "./canvas-viewport-core";
```

Replace `renderer/design/design-route.tsx`:

```tsx
import "../canvas/styles";
import * as React from "react";
import { StudioCanvas, StudioSurface, type CanvasTool } from "../canvas";
import { EmptyState } from "../components/ui";

/** Placeholder until DS-1b replaces this module; the export name and props are the route contract. */
export function DesignRoute(_props: { projectId?: string }) {
  const [tool, setTool] = React.useState<CanvasTool>("select");
  const [minimap, setMinimap] = React.useState(false);
  return (
    <StudioSurface title="Design">
      <StudioCanvas
        label="Design canvas"
        nodes={[]}
        edges={[]}
        tool={tool}
        onToolChange={setTool}
        minimap={minimap}
        onMinimapChange={setMinimap}
        emptyState={
          <EmptyState placement="inline" title="No design projects yet" description="Design projects will appear here." />
        }
      />
    </StudioSurface>
  );
}
```

Replace `renderer/images/images-route.tsx` in the same way. The differences are:
- export `ImagesRoute(_props: { workflowId?: string })`
- title `"Images"`
- `label="Images canvas"`
- empty state "No image workflows yet" / "Image workflows will appear here."

- [ ] **Step 4: Verify.**
  ```bash
  npm run type-check
  npm run lint
  npm run build
  npm run check:bundle-budget
  ls build/renderer/assets | grep -E "design-route|images-route"
  grep -l "react-flow__" build/renderer/assets/*.js
  ```
  Expected:
  - Type-check, lint and build pass.
  - The budget passes, and the raw/gzip numbers stay within a few KB of the F-2.2 numbers. Record both in the PR.
  - The route chunks exist.
  - The `react-flow__` match appears only in lazy chunks, never in the entry `main-window-*.js` or its modulepreloads.
  - `npx tsx --test renderer/canvas/canvas-controls.test.tsx renderer/canvas/canvas-keymap-core.test.ts` still passes.

- [ ] **Step 5: Commit.**

```bash
git add package.json package-lock.json THIRD_PARTY_NOTICES.md renderer/components/ui.tsx renderer/canvas/studio-canvas.tsx renderer/canvas/studio-surface.tsx renderer/canvas/studio-canvas.css renderer/canvas/styles.ts renderer/canvas/index.ts renderer/design/design-route.tsx renderer/images/images-route.tsx
git commit -F - <<'EOF'
feat(canvas): add StudioCanvas on pinned @xyflow/react 12.11.6

The canvas, its CSS and React Flow load only with the lazy studio routes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-5.4: Playwright flags-off and flags-on smoke

**Files:**
- Create: `tests/e2e/studio-foundation.spec.ts`. It is discovered automatically by `scripts/ci-e2e-shards.mjs` `discoverSpecs()`, so no registry entry is needed. Optionally add `"studio-foundation.spec.ts": 45` to `FILE_SECONDS` in `scripts/ci-e2e-shards.mjs` after the first hosted timing.

**Interfaces:**
- Consumes: `test`, `expect` and `finishLmStudioOnboarding` from `tests/e2e/fixtures.ts`; the fixture options `appEnvironment` and `workspaceSeed`; and `aiden.relaunch(afterClose?, appEnvironment?)`.

- [ ] **Step 1: Write the spec** in `tests/e2e/studio-foundation.spec.ts`.

```ts
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";
const STUDIO_FLAGS = {
  AIDEN_EXPERIMENTAL_DESIGN_STUDIO: "1",
  AIDEN_EXPERIMENTAL_CREATE_IMAGES: "1",
};

test.describe("Studio foundation with both flags off", () => {
  test("adds no studio rows, commands or routes", async ({ aiden }) => {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("button", { name: "Scheduled", exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Design", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "Images", exact: true })).toHaveCount(0);

    await page.keyboard.press(`${PRIMARY_MODIFIER}+K`);
    const search = page.getByLabel("Search commands");
    await search.fill("Open Design Studio");
    await expect(page.getByRole("option", { name: /Open Design Studio/ })).toHaveCount(0);
    await search.fill("Open Create Images");
    await expect(page.getByRole("option", { name: /Open Create Images/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});

test.describe("Studio foundation with both flags on", () => {
  test.use({ workspaceSeed: true, appEnvironment: STUDIO_FLAGS });

  test("Design and Images open empty canvases beside the sidebar", async ({ aiden }) => {
    let page = aiden.page;
    await finishLmStudioOnboarding(page);
    await page.mouse.move(1, 1); // keep the onboarding toast from pausing over the toolbar

    const tools = page.getByRole("complementary", { name: "Environment work surface" });
    if (!(await tools.isVisible())) await page.locator("[data-environment-toggle]").click();
    await expect(tools).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Primary" });
    const designRow = nav.getByRole("button", { name: "Design", exact: true });
    const workspaces = page.getByText("Workspaces", { exact: true }).first();
    const [rowBox, workspacesBox] = await Promise.all([designRow.boundingBox(), workspaces.boundingBox()]);
    expect(rowBox!.y).toBeLessThan(workspacesBox!.y); // studio rows sit above the workspace outline

    await designRow.click();
    const canvas = page.getByRole("region", { name: "Design canvas" });
    await expect(canvas).toBeVisible();
    await expect(designRow).toHaveAttribute("aria-current", "page");
    await expect(nav).toBeVisible(); // the sidebar stays
    await expect(tools).toBeHidden(); // the Environment workbench is suppressed, not closed
    await expect(canvas.getByText("No design projects yet")).toBeVisible();

    // Keyboard tools and zoom act on the focused canvas only.
    await canvas.focus();
    const rail = canvas.getByRole("toolbar", { name: "Canvas tools" });
    const zoom = canvas.getByRole("toolbar", { name: "Zoom" });
    await expect(rail.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("h");
    await expect(rail.getByRole("button", { name: "Hand" })).toHaveAttribute("aria-pressed", "true");
    await expect(zoom.getByRole("button", { name: /^Zoom 100%/ })).toBeVisible();
    await page.keyboard.press("=");
    await expect(zoom.getByRole("button", { name: /^Zoom 120%/ })).toBeVisible();
    await page.keyboard.press("Shift+0");
    await expect(zoom.getByRole("button", { name: /^Zoom 100%/ })).toBeVisible();
    await zoom.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoom.getByRole("button", { name: /^Zoom 120%/ })).toBeVisible();

    // The Hand tool pans the viewport.
    const viewport = canvas.locator(".react-flow__viewport");
    const before = await viewport.evaluate((element) => getComputedStyle(element).transform);
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(() => viewport.evaluate((element) => getComputedStyle(element).transform))
      .not.toBe(before);

    // Back in a chat, the Environment workbench returns exactly as it was.
    await nav.getByRole("button", { name: "New Agent", exact: true }).click();
    await expect(tools).toBeVisible();

    // The palette opens Images.
    await page.keyboard.press(`${PRIMARY_MODIFIER}+K`);
    await page.getByLabel("Search commands").fill("Open Create Images");
    await page.getByRole("option", { name: /Open Create Images/ }).click();
    await expect(page.getByRole("region", { name: "Images canvas" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Images", exact: true })).toHaveAttribute("aria-current", "page");

    // Relaunching without the flags removes every trace.
    page = await aiden.relaunch(undefined, {});
    const relaunchedNav = page.getByRole("navigation", { name: "Primary" });
    await expect(relaunchedNav.getByRole("button", { name: "Scheduled", exact: true })).toBeVisible();
    await expect(relaunchedNav.getByRole("button", { name: "Design", exact: true })).toHaveCount(0);
    await expect(relaunchedNav.getByRole("button", { name: "Images", exact: true })).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run it.**
  `npm run type-check:e2e && npm run build && npx playwright test --config=playwright.config.ts tests/e2e/studio-foundation.spec.ts --fail-on-flaky-tests`. Expected: 2 tests pass.
  - If a selector fails, fix the product (labels, roles) rather than weakening the assertion.
  - On Linux, run the same command under `xvfb-run -a`, or rely on the hosted Linux e2e shard.

- [ ] **Step 3: Run the adjacent specs.** `npx playwright test --config=playwright.config.ts tests/e2e/chat-shell-interactions.spec.ts tests/e2e/environment-focus.spec.ts tests/e2e/settings-model-picker.spec.ts --fail-on-flaky-tests`. Expected: pass. They cover the sidebar, the Environment workbench and the Bots row.

- [ ] **Step 4: Commit.**

```bash
git add tests/e2e/studio-foundation.spec.ts
git commit -F - <<'EOF'
test(e2e): pin studio flags-off parity and flags-on canvases

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

## Task F-6: Local gates, memory and plan index

**Files:**
- Create: `.memory/studio-foundation.md`
- Modify: `docs/plans/README.md` (the Design Studio + Create Images row), `docs/plans/design-studio-create-images-rebuild-plan.md` (tick §6 ADR-F and the Track F rows)

- [ ] **Step 1: Run the narrow suites.**
  ```bash
  npm run test:studio-foundation
  npm run test:command-system
  npm run test:sidebar
  npm run test:generative-ui
  npm run test:ci:registry
  npm run test:ci-policy
  ```
  Expected: all pass.

- [ ] **Step 2: Run the CI lanes and preserved modes that PR B touches.**
  ```bash
  node scripts/run-ci-tests.mjs --lane core-git --summary
  node scripts/run-ci-tests.mjs --lane renderer-other --summary
  node scripts/run-ci-tests.mjs --lane runtime-subagents --summary
  node scripts/run-ci-tests.mjs --preserved=generative-ui-chromium
  ```
  Expected: green.

- [ ] **Step 3: Run static checks, build and budget.**
  ```bash
  npm run type-check
  npm run type-check:e2e
  npm run lint
  npm run build
  npm run check:bundle-budget
  ```
  Expected: green. Paste the budget output for `main` and for the branch into the PR.

- [ ] **Step 4: Run Playwright.**
  ```bash
  npx playwright test --config=playwright.config.ts tests/e2e/studio-foundation.spec.ts tests/e2e/chat-shell-interactions.spec.ts tests/e2e/environment-focus.spec.ts --fail-on-flaky-tests
  ```

- [ ] **Step 5: Run the CLI.** `npm run test:cli`. Expected: pass. The CLI bundles `renderer/shared/*` (`keybindings.ts`, `studio-routes.ts`) and `main/services/*`.

- [ ] **Step 6: Native suites.** These are not required for PR B, because it changes no Remote projection. They are required for PR A (F-3.5).

- [ ] **Step 7: Write the memory note** `.memory/studio-foundation.md`. It covers:
  1. The flags `AIDEN_EXPERIMENTAL_DESIGN_STUDIO` and `AIDEN_EXPERIMENTAL_CREATE_IMAGES` (values `1`/`true`) and how to run with them (`AIDEN_EXPERIMENTAL_DESIGN_STUDIO=1 npm run dev`).
  2. The route contract: replace `renderer/design/design-route.tsx` (`DesignRoute({ projectId? })`) and `renderer/images/images-route.tsx` (`ImagesRoute({ workflowId? })`), and never edit `router.tsx`.
  3. The studio asset API, the holder keys `design:` / `images-workflow:` / `images-run:`, the 1 h GC grace, and the grant URLs `aiden-asset://grant/<token>`, which are revoked on navigation.
  4. That `registerCustomSchemes` is the only scheme registration.
  5. The CSP token `aiden-asset:` (img-src only).
  6. The canvas kit exports and that only route modules import `renderer/canvas/styles`.
  7. That test suites go in `test:studio-foundation`, `test:design-studio` and `test:create-images`, assigned to the existing lanes. No new CI lanes.
  8. The before/after bundle-budget numbers.

- [ ] **Step 8: Update the plan index.**
  1. In `docs/plans/README.md`, update the "Design Studio + Create Images rebuild" entry to say that Track F has landed. Give the PR numbers for A and B, the flags (default off), what Track F provides (routes, sidebar rows, commands, chat visibility predicate, studio asset store + `aiden-asset:`, canvas kit), and that DS-1 and CI-1 are next.
  2. In the umbrella plan, tick the ADR-F checkbox and mark Track F's exit criteria met.

- [ ] **Step 9: Commit and open the PR.**

```bash
git add .memory/studio-foundation.md docs/plans/README.md docs/plans/design-studio-create-images-rebuild-plan.md
git commit -F - <<'EOF'
docs(studio): record Studio Foundation decisions and status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git push -u origin feature/studio-foundation
```

Open the PR against `main`.
- The body links ADR-F, lists the flags-off evidence (sidebar render test, palette test, scheme test, Playwright flags-off spec, bundle numbers), and records any flake that needed its one allowed rerun.
- The body ends with:
  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```
- Merge only when CI is green on the exact head. After PR A merges, merge `origin/main` into this branch and resolve `test:serial` by union.
