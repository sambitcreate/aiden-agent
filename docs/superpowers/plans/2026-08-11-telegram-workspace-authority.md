# Telegram Workspace Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the paired Telegram owner explicitly bind remote full-access turns to one configured local workspace, while preserving assistant-only behavior when no workspace is selected.

**Architecture:** Store an optional `telegramWorkspaceId` with the existing Telegram provider/model settings and expose it through the current `telegram:*` IPC contract. On every turn, the main-process service resolves that exact configured folder workspace: it routes a valid selection through `assistant-automation` and a workspace-isolated backing chat; no selection remains `assistant-unattended`; a stale selection errors before generation. The Settings selector is the sole authority-granting UI.

**Tech Stack:** Electron IPC, TypeScript, React, TanStack Query, Aiden `llmClient`, Node test runner, existing `Select` primitives.

## Global Constraints

- Telegram MUST NOT infer a workspace from recent activity.
- A persisted workspace ID that is unknown or no longer folder-backed MUST fail the turn; it MUST NOT select a replacement or silently downgrade authority.
- Project-mode turns MUST retain `permission: "full"`, `allowComputerUse: false`, `allowSubagents: false`, and `allowMcpTools: false`.
- Provider/model binding MUST retain `scheduledProviderFingerprint(provider)`.
- No workspace selection MUST preserve the existing `telegram-<ownerId>` backing chat and assistant-only mode.
- The selector MUST use existing semantic UI primitives and keyboard-accessible behavior.
- The tour tile MUST have its own 1024 × 1024 transparent RGBA PNG and preserve the existing asset test.

---

### Task 1: Persist the explicit Telegram workspace authority

**Files:**
- Create: `main/services/telegram/telegram-workspace-core.ts`
- Create: `main/services/telegram/telegram-workspace-core.test.ts`
- Modify: `main/services/types.ts:493-500`
- Modify: `main/handlers/telegram.ts:12-82`
- Modify: `renderer/lib/ipc.ts` Telegram API declaration
- Modify: `package.json` `test:telegram` script

**Interfaces:**
- Produces:

```ts
export function telegramWorkspaceSelectionId(value: unknown): string | undefined;
export function isTelegramFolderWorkspace(
  workspace: Pick<Workspace, "folderPath"> | null | undefined,
): boolean;
```

- Produces: `AppSettings.telegramWorkspaceId?: string`; `TelegramStatusResponse.workspaceId?: string`; `telegramApi.setWorkspace(workspaceId?: string): Promise<{ workspaceId?: string }>`.

- [ ] **Step 1: Write failing selection-normalization tests**

```ts
test("telegramWorkspaceSelectionId trims a non-empty workspace id", () => {
  assert.equal(telegramWorkspaceSelectionId("  workspace-a  "), "workspace-a");
});

test("telegramWorkspaceSelectionId clears non-string and blank values", () => {
  assert.equal(telegramWorkspaceSelectionId(undefined), undefined);
  assert.equal(telegramWorkspaceSelectionId("  "), undefined);
  assert.equal(telegramWorkspaceSelectionId(12), undefined);
});

test("isTelegramFolderWorkspace accepts only a configured folder workspace", () => {
  assert.equal(isTelegramFolderWorkspace({ folderPath: "/tmp/aiden" }), true);
  assert.equal(isTelegramFolderWorkspace({}), false);
  assert.equal(isTelegramFolderWorkspace(null), false);
});
```

- [ ] **Step 2: Run the core test to verify it fails**

Run: `npx tsx --test main/services/telegram/telegram-workspace-core.test.ts`

Expected: FAIL because the core module does not exist.

- [ ] **Step 3: Implement the pure authority helpers**

```ts
export function telegramWorkspaceSelectionId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isTelegramFolderWorkspace(
  workspace: Pick<Workspace, "folderPath"> | null | undefined,
): boolean {
  return Boolean(workspace?.folderPath);
}
```

Use `telegramWorkspaceSelectionId` in the new handler. When a non-empty id is supplied, call `configStore.getWorkspace(id)` and reject unless `isTelegramFolderWorkspace(workspace)` is true:

```ts
throw new Error("Choose a configured folder workspace for Telegram project automation.");
```

Persist the validated id or `undefined`; return the same result. Add `workspaceId: settings.telegramWorkspaceId` to `telegram:get`; declare the optional field in `TelegramStatusResponse`, `AppSettings`, and `telegramApi`. Do not modify token, enablement, pairing, or provider/model behavior.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npx tsx --test main/services/telegram/telegram-workspace-core.test.ts main/handlers/ipc-contract.test.ts`

Expected: PASS. The pure contract accepts only a trimmed id and folder-backed workspace; the IPC contract still discovers every registered `telegram:` channel.

- [ ] **Step 5: Register the new core test and commit**

```bash
# Append main/services/telegram/telegram-workspace-core.test.ts to test:telegram.
git add main/services/telegram/telegram-workspace-core.ts main/services/telegram/telegram-workspace-core.test.ts main/services/types.ts main/handlers/telegram.ts renderer/lib/ipc.ts package.json
git commit -m "feat: persist Telegram workspace authority"
```

### Task 2: Route scoped Telegram turns through project automation

**Files:**
- Modify: `main/services/telegram/telegram-service.ts:22-38`
- Modify: `main/services/telegram/telegram-service-core.ts:292-332`
- Modify: `main/services/telegram/telegram-turn.ts:64-237`
- Modify: `main/services/telegram/telegram-turn.test.ts`
- Modify: `main/services/telegram/telegram-service-core.test.ts`

**Interfaces:**
- Produces:

```ts
export type TelegramWorkspaceResolution =
  | { kind: "assistant" }
  | { kind: "project"; workspaceId: string }
  | { kind: "stale" };

resolveWorkspace(): Promise<TelegramWorkspaceResolution>;
telegramChatId(ownerUserId: number, workspaceId?: string): string;
```

- `TelegramTurnDeps.resolveWorkspace` returns the three-state resolution. The production service maps absent `telegramWorkspaceId` to `assistant`, a configured folder workspace to `project`, and a missing/folderless one to `stale`.

- [ ] **Step 1: Write failing workspace-routing tests**

```ts
test("workspace Telegram turn starts assistant automation with the selected workspace", async () => {
  let startedParams: { chatId: string; workspaceId?: string; mode?: string } | undefined;
  const llm = mockLlm(async (streamId, params, owner) => {
    startedParams = params;
    owner.send("chat:done", { streamId, content: "done" });
    return true;
  });
  const { deps } = mockDeps({ llm, workspace: { kind: "project", workspaceId: "workspace-a" } });
  const chatId = telegramChatId(123, "workspace-a");

  await sendTelegramTurn(deps, chatId, "list files");

  assert.equal(chatId, "telegram-123-workspace-a");
  assert.equal(startedParams?.chatId, chatId);
  assert.equal(startedParams?.workspaceId, "workspace-a");
  assert.equal(startedParams?.mode, "assistant-automation");
});

test("stale Telegram workspace errors before generation", async () => {
  const { deps } = mockDeps({ workspace: { kind: "stale" } });
  const result = await sendTelegramTurn(deps, telegramChatId(123, "missing"), "list files");

  assert.deepEqual(result, {
    ok: false,
    content: "",
    error: "The Telegram workspace is no longer available. Choose a folder workspace in Aiden Settings.",
  });
});

test("assistant-only Telegram turn preserves the owner chat and assistant mode", async () => {
  let startedParams: { chatId: string; workspaceId?: string; mode?: string } | undefined;
  const llm = mockLlm(async (streamId, params, owner) => {
    startedParams = params;
    owner.send("chat:done", { streamId, content: "done" });
    return true;
  });
  const { deps } = mockDeps({ llm, workspace: { kind: "assistant" } });

  await sendTelegramTurn(deps, telegramChatId(123), "settings help");

  assert.equal(startedParams?.chatId, "telegram-123");
  assert.equal(startedParams?.workspaceId, undefined);
  assert.equal(startedParams?.mode, "assistant-unattended");
});
```

- [ ] **Step 2: Run the focused Telegram test files to verify they fail**

Run: `npx tsx --test main/services/telegram/telegram-turn.test.ts main/services/telegram/telegram-service-core.test.ts`

Expected: FAIL because `TelegramTurnDeps` has no workspace resolution and the current shim always uses `assistant-unattended` with an unscoped chat id.

- [ ] **Step 3: Implement the three-state resolver and mode-aware injection**

In `telegram-service.ts`, resolve the persisted id on every dispatched turn:

```ts
async function resolveWorkspace(): Promise<TelegramWorkspaceResolution> {
  const workspaceId = (await configStore.getSettings()).telegramWorkspaceId;
  if (!workspaceId) return { kind: "assistant" };
  const workspace = await configStore.getWorkspace(workspaceId);
  return workspace?.folderPath ? { kind: "project", workspaceId: workspace.id } : { kind: "stale" };
}
```

In `telegram-turn.ts`, derive the chat id with the selected workspace only when `kind === "project"`, call `chatStore.create` with the same `workspaceId`, and start the LLM with:

```ts
const workspace = await deps.resolveWorkspace();
if (workspace.kind === "stale") {
  return { ok: false, content: "", error: "The Telegram workspace is no longer available. Choose a folder workspace in Aiden Settings." };
}
const projectWorkspaceId = workspace.kind === "project" ? workspace.workspaceId : undefined;
const mode = projectWorkspaceId ? "assistant-automation" : "assistant-unattended";
```

The existing start options retain `permission: "full"`, all three false access flags, `usageSource: "telegram"`, `turnId`, and the provider fingerprint. Update `telegram-service-core.ts` so `dispatchTurn` resolves the workspace before calling `ensureTelegramChat` and `sendTelegramTurn`; its queue/busy gate must use the same workspace-scoped chat ID. Remove the temporary success-delivery logs from `telegram-service-core.ts`; they were diagnostic-only and should not become routine noise.

- [ ] **Step 4: Run focused Telegram tests to verify they pass**

Run: `npm run test:telegram`

Expected: PASS. Scoped turns use only the selected workspace and project automation; unscoped turns preserve the assistant-only path; stale selection returns the concrete error without `llmClient.start`; all existing queue, markdown, Bot API, and service behavior remains green.

- [ ] **Step 5: Commit the routing change**

```bash
git add main/services/telegram/telegram-service.ts main/services/telegram/telegram-service-core.ts main/services/telegram/telegram-turn.ts main/services/telegram/telegram-turn.test.ts main/services/telegram/telegram-service-core.test.ts
git commit -m "feat: run Telegram turns in selected workspace"
```

### Task 3: Add a workspace selector to Telegram settings

**Files:**
- Create: `renderer/lib/telegram-workspace-options.ts`
- Create: `renderer/lib/telegram-workspace-options.test.ts`
- Modify: `renderer/components/settings/telegram-settings.tsx:21-179`
- Modify: `package.json` `test:telegram` script

**Interfaces:**
- Produces:

```ts
export const TELEGRAM_ASSISTANT_ONLY_VALUE = "__none__";
export interface TelegramWorkspaceOption {
  value: string;
  label: string;
  unavailable?: boolean;
}
export function telegramWorkspaceOptions(
  workspaces: readonly Workspace[],
  selectedId: string | undefined,
): TelegramWorkspaceOption[];
```

- `telegramWorkspaceOptions` returns the assistant-only option first, then folder-backed workspaces with `"${name} — ${folderPath}"` labels. A persisted id absent from the current list is retained as an unavailable option so the user can understand and clear it.

- [ ] **Step 1: Write failing option-data tests**

```ts
test("Telegram workspace options include assistant-only and configured folders", () => {
  assert.deepEqual(
    telegramWorkspaceOptions([
      { id: "folder", name: "Aiden", folderPath: "/tmp/aiden", permission: "ask", createdAt: 1, updatedAt: 1 },
      { id: "scratch", name: "Scratch", permission: "ask", createdAt: 1, updatedAt: 1 },
    ], undefined),
    [
      { value: "__none__", label: "Assistant-only mode" },
      { value: "folder", label: "Aiden — /tmp/aiden" },
    ],
  );
});

test("Telegram workspace options retain an unavailable saved selection", () => {
  assert.deepEqual(telegramWorkspaceOptions([], "missing"), [
    { value: "__none__", label: "Assistant-only mode" },
    { value: "missing", label: "Selected workspace is unavailable", unavailable: true },
  ]);
});
```

- [ ] **Step 2: Run the option-data test to verify it fails**

Run: `npx tsx --test renderer/lib/telegram-workspace-options.test.ts`

Expected: FAIL because the option-data module does not exist.

- [ ] **Step 3: Implement the pure option data and bind the existing controls**

```ts
export const TELEGRAM_ASSISTANT_ONLY_VALUE = "__none__";

export function telegramWorkspaceOptions(
  workspaces: readonly Workspace[],
  selectedId: string | undefined,
): TelegramWorkspaceOption[] {
  const options: TelegramWorkspaceOption[] = [
    { value: TELEGRAM_ASSISTANT_ONLY_VALUE, label: "Assistant-only mode" },
    ...workspaces.filter((workspace) => workspace.folderPath).map((workspace) => ({
      value: workspace.id,
      label: `${workspace.name} — ${workspace.folderPath}`,
    })),
  ];
  if (selectedId && !options.some((option) => option.value === selectedId)) {
    options.push({ value: selectedId, label: "Selected workspace is unavailable", unavailable: true });
  }
  return options;
}
```

In `telegram-settings.tsx`, import `useWorkspaces` and the option helper. Place a `Field` before Provider with exact description:

> Project automation runs only in this folder. Assistant-only mode cannot access project files or tools.

Render an existing small `Select` with `aria-label="Telegram workspace"`. Map the `"__none__"` item to `undefined` when calling `telegramApi.setWorkspace`, invalidate `queryKeys.telegram`, and use existing action-specific `toast.success`/`toast.error` behavior. Render unavailable options disabled. When there are no folder workspace options other than assistant-only, show a muted line directing the user to add a folder workspace in Settings → Workspaces.

- [ ] **Step 4: Run renderer tests and type-check to verify they pass**

Run: `npx tsx --test renderer/lib/telegram-workspace-options.test.ts && npx tsc --noEmit`

Expected: PASS. The pure data contract protects the rendered control’s assistant-only, folder-only, and stale-selection states; TypeScript confirms the IPC response and setter agree.

- [ ] **Step 5: Register the new test and commit**

```bash
# Append renderer/lib/telegram-workspace-options.test.ts to test:telegram.
git add renderer/lib/telegram-workspace-options.ts renderer/lib/telegram-workspace-options.test.ts renderer/components/settings/telegram-settings.tsx package.json
git commit -m "feat: choose Telegram workspace scope"
```

### Task 4: Complete onboarding, docs, and full verification

**Files:**
- Modify: `renderer/components/onboarding-flow.tsx:62-87,135-355`
- Modify: `renderer/components/onboarding-flow.test.tsx:222-292`
- Create: `renderer/assets/onboarding/features/telegram-remote-control.png`
- Modify: `docs/plans/telegram-remote-control-plan.md:202-252`
- Modify: `docs/plans/README.md`

**Interfaces:**
- Produces: `FEATURE_ILLUSTRATIONS.telegram`, a Control-group `Telegram Remote Control` bento, and an onboarding asset path of `features/telegram-remote-control.png`.

- [ ] **Step 1: Write failing onboarding assertions**

```ts
assert.match(featurePresentation, /Telegram Remote Control/u);
assert.equal(featurePresentation.match(/imageUrl: FEATURE_ILLUSTRATIONS\./gu)?.length, 23);
assert.equal(featureAssetPaths.length, 23);
assert.ok(featureAssetPaths.includes("features/telegram-remote-control.png"));
```

Keep the existing PNG-signature, 1024 × 1024 dimension, and RGBA-alpha assertions unchanged.

- [ ] **Step 2: Run the onboarding test to verify it fails**

Run: `npx tsx --test renderer/components/onboarding-flow.test.tsx`

Expected: FAIL because Telegram is not an advertised bento feature and its asset does not exist.

- [ ] **Step 3: Add the feature tile and a real transparent illustration**

Add `telegram` to `FEATURE_ILLUSTRATIONS`; add a Control-group bento with the `Send` Lucide icon, title `Telegram Remote Control`, description `Run trusted workspace automations from your paired Telegram account.`, and a standard layout. Create `renderer/assets/onboarding/features/telegram-remote-control.png` as a 1024 × 1024 RGBA PNG with a transparent background, an Aiden conversation bubble and abstract paper-plane composition, and no embedded text. Update the list/count/path assertions to 23 without modifying gallery mechanics.

- [ ] **Step 4: Update plan and inventory documentation**

Update the Telegram plan implementation summary to record `telegramWorkspaceId`, `telegram:setWorkspace`, the explicit Workspace selector, `assistant-automation` for selected folder workspaces, and assistant-only fallback. Mark Phase 6 complete, remove the stale deferral line, and revise the plan index status/current state. Move the plan into `docs/plans/completed/` only when every original Phase 0–6 acceptance criterion has passed.

- [ ] **Step 5: Run full verification and live smoke**

Run:

```bash
npm run test:telegram
npm run test:onboarding
npx tsc --noEmit
npm run lint
npm run test
npm run build
```

Launch the dev app. In Settings → Telegram, select a configured folder workspace and send the paired bot: `List the top-level files in this workspace.` Verify the Telegram reply reflects the selected project’s tool output. Then clear the selection, send a settings question, and verify the reply is assistant-only. Verify a stale selection gives the specified concrete error.

- [ ] **Step 6: Commit the complete capability**

```bash
git add renderer/components/onboarding-flow.tsx renderer/components/onboarding-flow.test.tsx renderer/assets/onboarding/features/telegram-remote-control.png docs/plans/telegram-remote-control-plan.md docs/plans/README.md package.json
git commit -m "feat: complete Telegram remote control onboarding"
```
