import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { toast, type ToastT } from "sonner";
import type { ChatTriageEntry, ChatTriageResult } from "../shared/chat-triage";
import type { PeerHostView } from "../shared/peer-host";
import { LOCAL_SIDEBAR_HOST_ID, projectOrderKey } from "./sidebar-organization";
import { useInboxTriage, type InboxTriageRow } from "./use-inbox-triage";

const NO_PEERS: ReadonlyMap<string, PeerHostView> = new Map();
const ROW: InboxTriageRow = {
  key: projectOrderKey(LOCAL_SIDEBAR_HOST_ID, "c1"),
  hostId: LOCAL_SIDEBAR_HOST_ID,
  chatId: "c1",
};

afterEach(() => {
  cleanup();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * This Mac's triage store over IPC: `chats:triage` answers `chats` and each
 * `chats:setTriage` takes the next pending answer, which the test settles.
 */
function installStore(chats: Record<string, ChatTriageEntry> = {}) {
  const answers: Deferred<ChatTriageResult>[] = [];
  const calls: BotTestIpcCall[] = installBotTestIpc({
    "chats:triage": () => ({ revision: 1, chats }),
    "chats:setTriage": () => {
      const answer = deferred<ChatTriageResult>();
      answers.push(answer);
      return answer.promise;
    },
  });
  const writes = () => calls.filter((call) => call.channel === "chats:setTriage").map((call) => call.args);
  return { answers, writes };
}

async function mount(onRestore?: (keys: readonly string[]) => void) {
  const hook = renderHook(() => useInboxTriage({ views: NO_PEERS, ...(onRestore ? { onRestore } : {}) }));
  // The store's first snapshot arrives.
  await act(async () => {});
  return hook;
}

/**
 * Toasts this test showed. Sonner keeps every show of an id in its history,
 * dismissed or not, and the Toaster renders the latest.
 */
let shownBefore = 0;
beforeEach(() => {
  shownBefore = toast.getHistory().length;
});
const shownToasts = () =>
  toast.getHistory().slice(shownBefore).filter((shown): shown is ToastT => !("dismiss" in shown));
type ToastAction = { label: string; onClick: (event: never) => void };
const triageToast = () => shownToasts().filter((shown) => shown.id === "inbox-triage").pop();

async function settle(answer: Deferred<ChatTriageResult> | undefined, result: ChatTriageResult | Error) {
  assert.ok(answer, "a write was sent");
  await act(async () => {
    if (result instanceof Error) answer.reject(result);
    else answer.resolve(result);
  });
}

test("a row moves the moment it is marked done, and moves back when the write fails", async () => {
  const store = installStore();
  const { result } = await mount();
  assert.equal(result.current.entryFor(ROW), undefined);

  const written: (readonly InboxTriageRow[])[] = [];
  let acting!: Promise<void>;
  act(() => {
    acting = result.current.act("done", [ROW], undefined, { onWritten: (rows) => written.push(rows) });
  });
  assert.notEqual(result.current.entryFor(ROW)?.doneAt, undefined, "the row reads Done before the host answers");
  assert.deepEqual(written, [], "nothing follows the write before the host takes it");

  // Electron wraps a handler's error in its remote-method prefix.
  await settle(store.answers[0], new Error("Error invoking remote method 'chats:setTriage': Error: The disk is full."));
  await act(() => acting);
  assert.equal(result.current.entryFor(ROW), undefined, "the row shows what it showed before");
  assert.ok(shownToasts().some((item) => item.type === "error" && item.title === "The disk is full."));
  assert.equal(triageToast(), undefined, "nothing to undo");
  assert.deepEqual(written, [], "a write that failed leaves the chat unread");
});

test("what follows a write runs once the host takes it, only for the rows it took", async () => {
  const store = installStore();
  const { result } = await mount();
  const other: InboxTriageRow = { key: projectOrderKey(LOCAL_SIDEBAR_HOST_ID, "c2"), hostId: LOCAL_SIDEBAR_HOST_ID, chatId: "c2" };
  const written: (readonly InboxTriageRow[])[] = [];
  let acting!: Promise<void>;
  act(() => {
    acting = result.current.act("snooze", [ROW, other], Date.now() + 3_600_000, { onWritten: (rows) => written.push(rows) });
  });
  await settle(store.answers[0], { ok: true, entry: { revision: 2, updatedAt: 10, snoozedUntil: Date.now() + 3_600_000 } });
  // The local store takes one write at a time; the second one fails.
  await act(async () => {});
  await settle(store.answers[1], new Error("The disk is full."));
  await act(() => acting);
  assert.deepEqual(written, [[ROW]], "only the chat whose snooze landed");
});

test("Undo reverses the action and names the revision the action left", async () => {
  const store = installStore();
  const restored: (readonly string[])[] = [];
  const { result } = await mount((keys) => restored.push(keys));

  let acting!: Promise<void>;
  act(() => {
    acting = result.current.act("done", [ROW]);
  });
  await settle(store.answers[0], { ok: true, entry: { revision: 3, updatedAt: 10, doneAt: 10 } });
  await act(() => acting);

  const shown = triageToast();
  assert.equal(shown?.title, "Marked done");
  const action = shown?.action as ToastAction | undefined;
  assert.equal(action?.label, "Undo");

  act(() => action!.onClick({} as never));
  assert.deepEqual(restored, [[ROW.key]], "the Inbox places the row live before it moves back");
  assert.equal(result.current.entryFor(ROW)?.doneAt, undefined, "the row leaves Done before the host answers");
  assert.deepEqual(store.writes()[1], ["c1", { done: false }, 3]);

  await settle(store.answers[1], { ok: true, entry: { revision: 4, updatedAt: 11 } });
  assert.equal(result.current.entryFor(ROW)?.doneAt, undefined);
  assert.equal(result.current.entryFor(ROW)?.revision, 4);
});

test("Undo leaves a chat another device changed since, and says so", async () => {
  const store = installStore();
  const { result } = await mount();

  let acting!: Promise<void>;
  act(() => {
    acting = result.current.act("done", [ROW]);
  });
  await settle(store.answers[0], { ok: true, entry: { revision: 3, updatedAt: 10, doneAt: 10 } });
  await act(() => acting);
  const action = triageToast()?.action as ToastAction | undefined;

  act(() => action!.onClick({} as never));
  // Another device snoozed the chat after this one marked it done.
  const other: ChatTriageEntry = { revision: 4, updatedAt: 12, doneAt: 10, snoozedUntil: Date.now() + 3_600_000 };
  act(() => emitBotTestNotification("chats:triage-changed", { revision: 2, chats: { c1: other } }));
  await settle(store.answers[1], { ok: false, code: "revision_conflict", entry: other, currentRevision: 4 });

  assert.deepEqual(result.current.entryFor(ROW), other, "the other device's change stands");
  assert.equal(triageToast()?.title, "That chat changed since, so Undo left it as it is.");
  assert.equal(triageToast()?.action, undefined, "nothing left to undo");
});
