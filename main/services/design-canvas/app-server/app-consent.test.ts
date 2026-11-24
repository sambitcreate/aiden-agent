import assert from "node:assert/strict";
import test from "node:test";
import type { DesignAppConsentRequest } from "../../../../renderer/shared/design-app.js";
import { attachConsentKey, DesignAppConsent, type AttachConsentCard, type DesignAppConsentOwner } from "./app-consent.js";

type Sent = { channel: string; payload: Record<string, unknown> };

function fakeOwner(id = 7, options: { kind?: "remote"; documentId?: string } = {}) {
  const sent: Sent[] = [];
  const listeners = new Set<() => void>();
  let destroyed = false;
  const owner: DesignAppConsentOwner & { sent: Sent[]; destroy(): void } = {
    ...(options.kind ? { kind: options.kind } : {}),
    id,
    documentId: options.documentId ?? `doc-${id}`,
    isDestroyed: () => destroyed,
    send: (channel, payload) => {
      sent.push({ channel, payload: payload as Record<string, unknown> });
    },
    onInvalidated: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sent,
    destroy: () => {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
  return owner;
}

const card: Omit<Extract<DesignAppConsentRequest, { kind: "launch" }>, "requestId"> = {
  kind: "launch",
  chatId: "chat-1",
  workspaceId: "ws",
  appRoot: ".",
  frameworkLabel: "Vite",
  reason: "first",
  runCommand: "npm run dev",
  scripts: [{ name: "dev", text: "vite" }],
  launchFiles: [],
  savesChoice: false,
};

const shown = (owner: { sent: Sent[] }) => owner.sent.filter((entry) => entry.channel === "designApp:consent");
const closed = (owner: { sent: Sent[] }) => owner.sent.filter((entry) => entry.channel === "designApp:consentClosed");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a card goes to the owner's window and an answer from another window is refused", async () => {
  const consent = new DesignAppConsent();
  const owner = fakeOwner(7);
  const answer = consent.request({ key: "ws\0.", by: "person", request: card, owner });
  assert.equal(shown(owner).length, 1);
  const requestId = shown(owner)[0]!.payload.requestId as string;
  assert.equal(shown(owner)[0]!.payload.appRoot, ".");
  assert.equal(consent.answer(requestId, "allow", fakeOwner(8)), false, "another window");
  assert.equal(consent.answer(requestId, "allow", fakeOwner(7, { documentId: "reloaded" })), false, "a reloaded document");
  assert.equal(consent.answer(requestId, "maybe", owner), false, "not an answer");
  assert.equal(consent.answer(requestId, "allow", owner), true);
  assert.equal(await answer, "allow");
  assert.equal(closed(owner).length, 1);
  assert.equal(consent.answer(requestId, "allow", owner), false, "already answered");
});

test("a second request for a pending key joins it: one card, both callers get the answer", async () => {
  const consent = new DesignAppConsent();
  const owner = fakeOwner();
  const first = consent.request({ key: "ws\0.", by: "aiden", request: card, owner });
  const second = consent.request({ key: "ws\0.", by: "person", request: { ...card, chatId: "chat-2" }, owner: fakeOwner(9) });
  assert.equal(shown(owner).length, 1);
  consent.answer(shown(owner)[0]!.payload.requestId, "decline", owner);
  assert.deepEqual(await Promise.all([first, second]), ["decline", "decline"]);
});

test("no answer in 2 minutes gives unanswered and closes the card", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const consent = new DesignAppConsent();
  const owner = fakeOwner();
  const answer = consent.request({ key: "ws\0.", by: "aiden", request: card, owner });
  t.mock.timers.tick(2 * 60_000 - 1);
  await flush();
  assert.equal(closed(owner).length, 0);
  t.mock.timers.tick(1);
  assert.equal(await answer, "unanswered");
  assert.equal(closed(owner).length, 1);
});

test("a Remote or destroyed owner gives unavailable without sending", async () => {
  const consent = new DesignAppConsent();
  const remote = fakeOwner(0, { kind: "remote" });
  assert.equal(await consent.request({ key: "k", by: "aiden", request: card, owner: remote }), "unavailable");
  const headless = fakeOwner(0);
  assert.equal(await consent.request({ key: "k", by: "aiden", request: card, owner: headless }), "unavailable");
  const gone = fakeOwner(3);
  gone.destroy();
  assert.equal(await consent.request({ key: "k", by: "person", request: card, owner: gone }), "unavailable");
  assert.equal(await consent.request({ key: "k", by: "person", request: card }), "unavailable");
  assert.equal(remote.sent.length + headless.sent.length + gone.sent.length, 0);
  // A window that goes away while the card waits closes it as unavailable.
  const leaving = fakeOwner(4);
  const answer = consent.request({ key: "k", by: "person", request: card, owner: leaving });
  leaving.destroy();
  assert.equal(await answer, "unavailable");
});

test("after Not now, Aiden's requests give declined without a card until forgetDecline", async () => {
  const consent = new DesignAppConsent();
  const owner = fakeOwner();
  const first = consent.request({ key: "ws\0.", by: "aiden", request: card, owner });
  consent.answer(shown(owner)[0]!.payload.requestId, "decline", owner);
  assert.equal(await first, "decline");
  assert.equal(consent.isDeclined("ws\0."), true);
  assert.equal(await consent.request({ key: "ws\0.", by: "aiden", request: card, owner }), "decline");
  assert.equal(shown(owner).length, 1, "no second card for Aiden");
  assert.equal(consent.isDeclined("ws\0.other"), false, "per key");
  // The person's own start still asks.
  const person = consent.request({ key: "ws\0.", by: "person", request: card, owner });
  assert.equal(shown(owner).length, 2);
  consent.answer(shown(owner)[1]!.payload.requestId, "allow", owner);
  assert.equal(await person, "allow");
  assert.equal(consent.isDeclined("ws\0."), false, "Allow forgets the decline");
  consent.answer("nothing", "decline", owner);
  const again = consent.request({ key: "ws\0.", by: "aiden", request: card, owner });
  consent.answer(shown(owner)[2]!.payload.requestId, "decline", owner);
  await again;
  consent.forgetDecline("ws\0.");
  void consent.request({ key: "ws\0.", by: "aiden", request: card, owner });
  assert.equal(shown(owner).length, 4, "asked again after forgetDecline");
});

test("the abort signal closes the card", async () => {
  const consent = new DesignAppConsent();
  const owner = fakeOwner();
  const controller = new AbortController();
  const answer = consent.request({ key: "k", by: "person", request: card, owner, signal: controller.signal });
  assert.equal(shown(owner).length, 1);
  controller.abort();
  assert.equal(await answer, "unavailable");
  assert.equal(closed(owner).length, 1);
  assert.equal(consent.answer(shown(owner)[0]!.payload.requestId, "allow", owner), false);
  // An already aborted signal sends nothing.
  assert.equal(await consent.request({ key: "k", by: "person", request: card, owner, signal: AbortSignal.abort() }), "unavailable");
  assert.equal(shown(owner).length, 1);
});

test("at most 16 cards wait at once", async () => {
  const consent = new DesignAppConsent();
  const owner = fakeOwner();
  for (let index = 0; index < 16; index += 1) void consent.request({ key: `k${index}`, by: "person", request: card, owner });
  assert.equal(await consent.request({ key: "k16", by: "person", request: card, owner }), "unavailable");
  assert.equal(shown(owner).length, 16);
});

// ── 2c: attach cards (D10) ──

const attachCard: AttachConsentCard = {
  kind: "attach",
  chatId: "chat-1",
  workspaceId: "ws",
  appRoot: "docs",
  url: "http://127.0.0.1:4321",
  configUrl: "http://localhost:4321",
  processName: "astro",
  folder: "docs",
};

test("an attach card is sent with kind attach and its display fields", async () => {
  const consent = new DesignAppConsent();
  const owner = fakeOwner(7);
  const answer = consent.request({ key: attachConsentKey("ws", "docs"), by: "person", request: attachCard, owner });
  const [sentCard] = shown(owner);
  assert.equal(sentCard!.payload.kind, "attach");
  assert.deepEqual(
    { ...sentCard!.payload, requestId: undefined },
    { ...attachCard, requestId: undefined },
  );
  assert.equal(consent.answer(sentCard!.payload.requestId, "allow", owner), true);
  assert.equal(await answer, "allow");
});

test("a launch and an attach for one root are two cards", async () => {
  const consent = new DesignAppConsent();
  const owner = fakeOwner(7);
  const launchKey = "ws\0docs";
  assert.notEqual(attachConsentKey("ws", "docs"), launchKey);
  const launch = consent.request({ key: launchKey, by: "person", request: { ...card, appRoot: "docs" }, owner });
  const attach = consent.request({ key: attachConsentKey("ws", "docs"), by: "person", request: attachCard, owner });
  assert.equal(shown(owner).length, 2, "neither joins the other");
  const [launchId, attachId] = shown(owner).map((entry) => entry.payload.requestId);
  consent.answer(attachId, "decline", owner);
  assert.equal(await attach, "decline");
  consent.answer(launchId, "allow", owner);
  assert.equal(await launch, "allow");
});

test("Not now on an attach card silences Aiden's next attach for that root, not a launch", async () => {
  const consent = new DesignAppConsent();
  const owner = fakeOwner(7);
  const first = consent.request({ key: attachConsentKey("ws", "docs"), by: "person", request: attachCard, owner });
  consent.answer(shown(owner)[0]!.payload.requestId, "decline", owner);
  assert.equal(await first, "decline");
  assert.equal(await consent.request({ key: attachConsentKey("ws", "docs"), by: "aiden", request: attachCard, owner }), "decline");
  assert.equal(shown(owner).length, 1, "no second attach card");
  const launch = consent.request({ key: "ws\0docs", by: "aiden", request: { ...card, appRoot: "docs" }, owner });
  assert.equal(shown(owner).length, 2, "the launch still asks");
  consent.answer(shown(owner)[1]!.payload.requestId, "allow", owner);
  assert.equal(await launch, "allow");
});

test("closeAll for the workspace closes attach cards too", async () => {
  const consent = new DesignAppConsent();
  const owner = fakeOwner(7);
  const attach = consent.request({ key: attachConsentKey("ws", "docs"), by: "person", request: attachCard, owner });
  consent.closeAll("ws\0");
  assert.equal(await attach, "unavailable");
  assert.equal(closed(owner).length, 1);
});
