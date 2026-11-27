import assert from "node:assert/strict";
import test from "node:test";
import { designModePromptSection } from "../canvas-tools.js";
import { createDesignNoteOffers, designMdLive, designMdTurnDeps, designOfferable } from "./turn-wiring.js";

const chat = { bot: false, assistantMode: false, windowless: false, permission: "workspace-write", writeFileExcluded: false };

test("only a chat that could write the files gets an offer", () => {
  assert.equal(designOfferable(chat), true);
  for (const [name, change] of [
    ["a Bot", { bot: true }],
    ["the assistant", { assistantMode: true }],
    ["a windowless turn", { windowless: true }],
    ["no access", { permission: "none" }],
    ["read-only", { permission: "read-only" }],
    ["write_file excluded", { writeFileExcluded: true }],
  ] as const) {
    assert.equal(designOfferable({ ...chat, ...change }), false, name);
  }
});

const services = {
  reader: { read: async () => ({ status: "missing", searched: [] }) },
  offers: { offerFor: async () => null, settle: async () => undefined },
  appRoots: async () => ({ roots: ["."], more: 0 }),
  report: () => undefined,
  log: () => undefined,
} as unknown as Parameters<typeof designMdTurnDeps>[0]["services"];

test("the DESIGN.md turn exists only with the live flag, and carries the turn's offer conditions", async () => {
  const base = { workspaceRoot: "/ws", offerable: true, askOffered: false, stillAvailable: async () => true, services };
  assert.equal(designMdTurnDeps({ ...base, live: false }), undefined);
  const deps = designMdTurnDeps({ ...base, live: true })!;
  assert.equal(deps.workspaceRoot, "/ws");
  assert.equal(deps.offerable, true);
  assert.equal(deps.askOffered, false);
  assert.equal(deps.reader, services.reader);
  assert.equal(deps.offers, services.offers);
  assert.equal(await deps.stillAvailable!(), true);
});

test("a turn that excludes design_system gets no DESIGN.md glue and no prompt bullet naming the tool", () => {
  const excluded = new Set(["design_system"]);
  assert.equal(designMdLive(true, undefined), true);
  assert.equal(designMdLive(true, new Set(["write_file"])), true);
  assert.equal(designMdLive(false, undefined), false);
  assert.equal(designMdLive(true, excluded), false);
  // With the tool excluded, the prompt is the flag-off section, which never names it.
  assert.doesNotMatch(designModePromptSection(designMdLive(true, excluded)), /design_system/u);
  assert.match(designModePromptSection(designMdLive(true, undefined)), /design_system/u);
});

function fakes() {
  const calls: string[] = [];
  const mdTurn = {
    statusSentence: async () => {
      calls.push("md.sentence");
      return "DESIGN.md: \"DESIGN.md\" (0 errors, 0 warnings).";
    },
    settle: async (delivered: boolean) => {
      calls.push(`md.settle ${delivered}`);
    },
  };
  const v1 = {
    offerFor: async () => {
      calls.push("v1.offer");
      return "Offer tokens.";
    },
    settle: async (folder: string, delivered: boolean) => {
      calls.push(`v1.settle ${folder} ${delivered}`);
    },
  };
  return { calls, mdTurn, v1 };
}

test("with the live flag on, the DESIGN.md sentence replaces the tokens offer, and settle settles the DESIGN.md turn", async () => {
  const { calls, mdTurn, v1 } = fakes();
  const notes = createDesignNoteOffers({ live: true, folderPath: "/ws", offerable: true, mdTurn, v1, signal: new AbortController().signal, log: () => undefined });
  assert.equal(await notes.statusLine("Canvas: 1 page."), 'Canvas: 1 page. DESIGN.md: "DESIGN.md" (0 errors, 0 warnings).');
  notes.settle(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["md.sentence", "md.settle true"]);
});

test("with the live flag off, the tokens offer is made and settled for its folder, as before", async () => {
  const { calls, mdTurn, v1 } = fakes();
  const notes = createDesignNoteOffers({ live: false, folderPath: "/ws", offerable: true, mdTurn: undefined, v1, signal: new AbortController().signal, log: () => undefined });
  assert.equal(await notes.statusLine("Canvas: 1 page."), "Canvas: 1 page. Offer tokens.");
  notes.settle(false);
  notes.settle(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["v1.offer", "v1.settle /ws false"], "settled once");
  void mdTurn;

  const unofferable = fakes();
  const quiet = createDesignNoteOffers({ live: false, folderPath: "/ws", offerable: false, mdTurn: undefined, v1: unofferable.v1, signal: new AbortController().signal, log: () => undefined });
  assert.equal(await quiet.statusLine("Canvas: 1 page."), "Canvas: 1 page.");
  assert.deepEqual(unofferable.calls, []);
});
