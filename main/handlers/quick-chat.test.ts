import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { DesktopHandoffTicketStore } from "../services/desktop-stream-handoff.js";
import {
  registerQuickChatHandlersCore,
  type QuickChatWindowControlPort,
} from "./quick-chat-core.js";

function createTestHarness(options: {
  navigateMainWindow?: (path: string) => Promise<void>;
} = {}) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const tickets = new DesktopHandoffTicketStore();
  const mainEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
  const quickEvent = { sender: { id: 2 } } as unknown as IpcMainInvokeEvent;
  const untrustedEvent = { sender: { id: 99 } } as unknown as IpcMainInvokeEvent;

  const log: string[] = [];
  const windowPort: QuickChatWindowControlPort = {
    isCurrentQuickChatEvent: (event) => event === quickEvent,
    toggleQuickChat: async (source) => {
      log.push(`toggle:${source}`);
      return true;
    },
    hideQuickChat: () => log.push("hide"),
    setQuickChatMode: (mode) => log.push(`mode:${mode}`),
    suppressQuickChatBlurHide: (ms) => log.push(`suppress:${ms ?? "default"}`),
    resetQuickChatBlurSuppression: () => log.push("reset-suppress"),
    notifyQuickChatHandoffComplete: (payload) => log.push(`handoff-complete:${payload.kind}`),
  };

  registerQuickChatHandlersCore({
    isMainWindow: (event) => event === mainEvent,
    navigateMainWindow: options.navigateMainWindow ?? (async (p) => { log.push(`nav:${p}`); }),
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    windowPort,
    tickets,
    resolveDocumentId: () => "quick-doc-1",
  });

  return { handlers, tickets, mainEvent, quickEvent, untrustedEvent, log };
}

test("quickChat handlers enforce sender gates across toggle, hide, setMode, suppressBlur, openSettings, and expandToMain", async () => {
  const { handlers, mainEvent, quickEvent, untrustedEvent, log } = createTestHarness();

  // quickChat:toggle allows mainWindow and quickChat, rejects untrusted.
  assert.equal(await handlers.get("quickChat:toggle")!(mainEvent), true);
  assert.equal(await handlers.get("quickChat:toggle")!(quickEvent), true);
  await assert.rejects(async () => handlers.get("quickChat:toggle")!(untrustedEvent), /Untrusted/);

  // quickChat-only handlers reject BOTH mainWindow and untrusted senders.
  for (const channel of ["quickChat:hide", "quickChat:setMode", "quickChat:suppressBlur", "quickChat:openSettings", "quickChat:expandToMain"]) {
    await assert.rejects(async () => handlers.get(channel)!(mainEvent, "starter"), /Untrusted/);
    await assert.rejects(async () => handlers.get(channel)!(untrustedEvent, "starter"), /Untrusted/);
  }

  // Valid quickChat calls succeed.
  assert.equal(handlers.get("quickChat:hide")!(quickEvent), true);
  assert.equal(handlers.get("quickChat:setMode")!(quickEvent, "modal"), true);
  assert.equal(handlers.get("quickChat:suppressBlur")!(quickEvent, 1200), true);
  assert.equal(await handlers.get("quickChat:openSettings")!(quickEvent, "providers"), true);
  await assert.rejects(
    () => Promise.resolve(handlers.get("quickChat:openSettings")!(quickEvent, "not-a-section")),
    /Invalid settings section/,
  );

  assert.deepEqual(log, [
    "toggle:command",
    "toggle:command",
    "hide",
    "mode:modal",
    "suppress:1200",
    "hide",
    "nav:/quick-chat-handoff/settings/providers",
  ]);
});

test("quickChat:expandToMain creates tickets, notifies on claim, and cleans up tickets + blur suppression on navigation failure", async () => {
  let navPaths: string[] = [];
  const { handlers, tickets, quickEvent, log } = createTestHarness({
    navigateMainWindow: async (path) => {
      navPaths.push(path);
    },
  });

  // Draft expand succeeds and onClaimed hides quick chat + sends handoff-complete.
  const draftResult = await handlers.get("quickChat:expandToMain")!(quickEvent, {
    kind: "draft",
    workspaceId: "ws-1",
    text: "hello",
    attachments: [],
  });
  assert.deepEqual(draftResult, { ok: true });
  assert.equal(navPaths.length, 1);
  assert.ok(navPaths[0].startsWith("/quick-chat-handoff/draft/"));
  const ticketId = navPaths[0].slice("/quick-chat-handoff/draft/".length);
  const claimedDraft = tickets.claimDraft(ticketId);
  assert.equal(claimedDraft?.text, "hello");
  claimedDraft?.onClaimed?.();
  assert.ok(log.includes("handoff-complete:draft"));
  assert.ok(log.includes("hide"));

  // Chat expand cleans up ticket and resets blur suppression if navigateMainWindow throws.
  const failing = createTestHarness({
    navigateMainWindow: async () => {
      throw new Error("Main window unavailable");
    },
  });
  const failedChat = await failing.handlers.get("quickChat:expandToMain")!(failing.quickEvent, {
    kind: "chat",
    chatId: "chat-fail",
    draftText: "unsent",
  });
  assert.deepEqual(failedChat, { ok: false });
  assert.equal(failing.tickets.claimChat("chat-fail"), null, "failed expand must clean up its ticket");
  assert.ok(failing.log.includes("reset-suppress"), "failed expand must reset blur suppression");
});
