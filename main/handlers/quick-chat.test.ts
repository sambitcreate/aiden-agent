import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { DesktopHandoffTicketStore } from "../services/desktop-stream-handoff.js";
import {
  registerQuickChatHandlersCore,
  type QuickChatWindowControlPort,
} from "./quick-chat-core.js";

function createTestHarness(
  options: {
    navigateMainWindow?: (path: string) => Promise<void>;
  } = {},
) {
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
    navigateMainWindow:
      options.navigateMainWindow ??
      (async (p) => {
        log.push(`nav:${p}`);
      }),
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
  for (const channel of [
    "quickChat:hide",
    "quickChat:setMode",
    "quickChat:suppressBlur",
    "quickChat:openSettings",
    "quickChat:expandToMain",
  ]) {
    await assert.rejects(async () => handlers.get(channel)!(mainEvent, "starter"), /Untrusted/);
    await assert.rejects(
      async () => handlers.get(channel)!(untrustedEvent, "starter"),
      /Untrusted/,
    );
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
  const navPaths: string[] = [];

  // Draft expand succeeds and hides quick chat + sends handoff-complete ONLY after navigation confirms.
  let claimedDuringNav = null as ReturnType<DesktopHandoffTicketStore["claimDraft"]>;
  const draftHarness = createTestHarness({
    navigateMainWindow: async (path) => {
      navPaths.push(path);
      const id = path.slice("/quick-chat-handoff/draft/".length);
      claimedDuringNav = draftHarness.tickets.claimDraft(id);
      assert.equal(
        draftHarness.log.includes("handoff-complete:draft"),
        false,
        "must not clear Quick Chat draft before main window confirms open",
      );
    },
  });
  const draftResult = await draftHarness.handlers.get("quickChat:expandToMain")!(
    draftHarness.quickEvent,
    {
      kind: "draft",
      workspaceId: "ws-1",
      text: "hello",
      attachments: [],
    },
  );
  assert.deepEqual(draftResult, { ok: true });
  assert.equal(navPaths.length, 1);
  assert.ok(navPaths[0].startsWith("/quick-chat-handoff/draft/"));
  assert.equal(claimedDuringNav?.text, "hello");
  assert.ok(draftHarness.log.includes("handoff-complete:draft"));
  assert.ok(draftHarness.log.includes("hide"));

  // Draft expand that claims ticket and then fails/blocks MUST NOT clear or hide Quick Chat.
  const failingDraft = createTestHarness({
    navigateMainWindow: async (path) => {
      const id = path.slice("/quick-chat-handoff/draft/".length);
      failingDraft.tickets.claimDraft(id);
      throw new Error("Main window is busy");
    },
  });
  const failedDraftRes = await failingDraft.handlers.get("quickChat:expandToMain")!(
    failingDraft.quickEvent,
    {
      kind: "draft",
      workspaceId: "ws-1",
      text: "keep my typed text",
      attachments: [],
    },
  );
  assert.deepEqual(failedDraftRes, { ok: false });
  assert.equal(failingDraft.log.includes("handoff-complete:draft"), false);
  assert.equal(failingDraft.log.includes("hide"), false);
  assert.ok(failingDraft.log.includes("reset-suppress"));

  // Chat expand failure runs deferred detach immediately (via abandonChat) so approvals/questions don't hang.
  let deferredDetachRan = false;
  let registeredDeferred = false;
  const failing = createTestHarness({
    navigateMainWindow: async () => {
      registeredDeferred = failing.tickets.deferDetachIfPending("chat-fail", "quick-doc-1", () => {
        deferredDetachRan = true;
      });
      throw new Error("Main window unavailable");
    },
  });
  const failedChat = await failing.handlers.get("quickChat:expandToMain")!(failing.quickEvent, {
    kind: "chat",
    chatId: "chat-fail",
    draftText: "unsent",
  });
  assert.deepEqual(failedChat, { ok: false });
  assert.equal(registeredDeferred, true, "deferred detach must register for pending ticket");
  assert.equal(deferredDetachRan, true, "failed chat expand must run deferred detach immediately");
  assert.equal(
    failing.tickets.claimChat("chat-fail"),
    null,
    "failed expand must clean up its ticket",
  );
  assert.ok(failing.log.includes("reset-suppress"), "failed expand must reset blur suppression");
});

test("quickChat:expandToMain captures analytics reporter before async lookup and reports once on claim only", async () => {
  const order: string[] = [];
  const reported: Array<{ duringStream: boolean; wasEphemeral: boolean }> = [];
  const tickets = new DesktopHandoffTicketStore();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

  registerQuickChatHandlersCore({
    isMainWindow: () => false,
    navigateMainWindow: async () => {
      order.push("navigate");
    },
    handle: (channel, listener) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown);
    },
    windowPort: {
      isCurrentQuickChatEvent: () => true,
      toggleQuickChat: async () => true,
      hideQuickChat: () => undefined,
      setQuickChatMode: () => undefined,
      suppressQuickChatBlurHide: () => undefined,
      resetQuickChatBlurSuppression: () => undefined,
      notifyQuickChatHandoffComplete: () => undefined,
    },
    tickets,
    resolveDocumentId: () => "doc-qc",
    beginExpansionReport: () => {
      order.push("capture-consent");
      return (info) => {
        order.push("emit");
        reported.push(info);
      };
    },
    inspectChatExpansionState: async () => {
      order.push("inspect");
      return { duringStream: true, wasEphemeral: true };
    },
  });

  const expand = handlers.get("quickChat:expandToMain")!;
  await expand({}, { kind: "chat", chatId: "chat-ephem" });
  assert.deepEqual(order, ["capture-consent", "inspect", "navigate"]);
  assert.equal(reported.length, 0, "must not report before main claims ticket");

  const claimed = tickets.claimChat("chat-ephem");
  claimed?.onClaimed?.();
  assert.deepEqual(reported, [{ duringStream: true, wasEphemeral: true }]);
});

test("quickChat:expandToMain enforces assertChatAccess before creating a ticket or suppressing blur", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const tickets = new DesktopHandoffTicketStore();
  let blurSuppressed = 0;
  let navigated = 0;

  registerQuickChatHandlersCore({
    isMainWindow: () => false,
    navigateMainWindow: async () => {
      navigated += 1;
    },
    handle: (ch, fn) => handlers.set(ch, fn as (event: unknown, ...args: unknown[]) => unknown),
    windowPort: {
      isCurrentQuickChatEvent: () => true,
      toggleQuickChat: async () => true,
      hideQuickChat: () => undefined,
      setQuickChatMode: () => undefined,
      suppressQuickChatBlurHide: () => {
        blurSuppressed += 1;
      },
      resetQuickChatBlurSuppression: () => undefined,
      notifyQuickChatHandoffComplete: () => undefined,
    },
    tickets,
    resolveDocumentId: () => "doc-qc",
    assertChatAccess: (_event, chatId) => {
      if (chatId !== "chat-owned") {
        throw new Error("Unauthorized Quick Chat conversation access.");
      }
    },
  });

  const expand = handlers.get("quickChat:expandToMain")!;
  await assert.rejects(
    () => Promise.resolve(expand({}, { kind: "chat", chatId: "chat-other" })),
    /Unauthorized Quick Chat conversation access/u,
  );
  assert.equal(blurSuppressed, 0);
  assert.equal(navigated, 0);
  assert.equal(tickets.claimChat("chat-other"), null);
});

test("quickChat:expandToMain preserves ephemeral flag on draft handoff and analytics", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const tickets = new DesktopHandoffTicketStore();
  const navPaths: string[] = [];
  const reported: Array<{ duringStream: boolean; wasEphemeral: boolean }> = [];

  let claimed = null as ReturnType<DesktopHandoffTicketStore["claimDraft"]>;
  registerQuickChatHandlersCore({
    isMainWindow: () => false,
    navigateMainWindow: async (navPath) => {
      navPaths.push(navPath);
      const ticketId = navPath.replace("/quick-chat-handoff/draft/", "");
      claimed = tickets.claimDraft(ticketId);
    },
    handle: (ch, fn) => handlers.set(ch, fn as (event: unknown, ...args: unknown[]) => unknown),
    windowPort: {
      isCurrentQuickChatEvent: () => true,
      toggleQuickChat: async () => true,
      hideQuickChat: () => undefined,
      setQuickChatMode: () => undefined,
      suppressQuickChatBlurHide: () => undefined,
      resetQuickChatBlurSuppression: () => undefined,
      notifyQuickChatHandoffComplete: () => undefined,
    },
    tickets,
    resolveDocumentId: () => "doc-qc",
    beginExpansionReport: () => (info) => reported.push(info),
  });

  const expand = handlers.get("quickChat:expandToMain")!;
  const result = await expand(
    {},
    { kind: "draft", workspaceId: "default", text: "Quick note", attachments: [], ephemeral: true },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(claimed?.ephemeral, true);
  assert.equal(claimed?.text, "Quick note");
  assert.deepEqual(reported, [{ duringStream: false, wasEphemeral: true }]);
});
