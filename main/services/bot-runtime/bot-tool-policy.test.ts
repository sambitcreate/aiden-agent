import assert from "node:assert/strict";
import test from "node:test";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import { botIngressAllowsTool, botToolApprovalSummary, botToolVerdict, botTurnOf, type BotToolFacts } from "./bot-tool-policy.js";

const QUESTION = "ask_user_question";
const HANDOFF = "hand_off";

/** A Bot with no grants at all: cards need none, so only the turn decides. */
function bareFacts(): BotToolFacts {
  return {
    authority: {
      otherCapabilities: [],
      files: { botHome: false },
      shell: { enabled: false },
    } as unknown as BotRuntimeEffectiveAuthority,
    supportsImages: true,
    fileLocations: 0,
    hasComputer: false,
    mcpTools: async () => new Map(),
    skillToolNames: async () => new Set(),
  };
}

const ROUTINE = "routine:task-1:2026-10-07T09:00:00.000Z";
const TELEGRAM = "tg:bot:1:0:5";
const DESK = "desk-1";
const PHONE = "remote:device:key";
const INTRO = "intro:bot";

/** [request ids of the run's inputs, whether a person is there to answer a card]. */
const RUNS: Array<[string, readonly (string | undefined)[], boolean]> = [
  ["a message from the Mac", [DESK], true],
  ["a message from a phone", [PHONE], true],
  ["an input without a request id", [undefined], true],
  ["two messages from the Mac", [DESK, "desk-2"], true],
  ["a routine run", [ROUTINE], false],
  ["a Telegram message", [TELEGRAM], false],
  ["a routine run a person's steer joined", [ROUTINE, DESK], false],
  ["a Telegram turn a person's steer joined", [TELEGRAM, PHONE], false],
  ["a person's turn a Telegram message joined", [DESK, TELEGRAM], false],
  ["the self-intro", [INTRO], false],
];

test("question and hand-off cards are offered only to runs a person is there to answer", () => {
  for (const tool of [QUESTION, HANDOFF]) {
    for (const [label, requestIds, attended] of RUNS) {
      assert.equal(botIngressAllowsTool(tool, requestIds), attended, `${tool}: ${label}`);
    }
  }
});

test("a hand-off is allowed for any Bot on an attended turn, and refused when any input is a routine or Telegram", async () => {
  for (const [label, requestIds, attended] of RUNS) {
    if (requestIds.includes(INTRO)) continue; // the self-intro is refused by ingress before any verdict
    const turns = requestIds.map(botTurnOf);
    const turn = { telegram: turns.some((each) => each.telegram), routine: turns.some((each) => each.routine) };
    const verdict = await botToolVerdict(HANDOFF, bareFacts(), turn);
    assert.equal(verdict.allowed, attended, label);
    if (!verdict.allowed) assert.equal(verdict.reason, "Hand-offs are off for this Bot.");
  }
});

test("a hand-off never needs an approval of its own: the card is the person's answer", async () => {
  assert.equal(await botToolApprovalSummary(HANDOFF, { action: "Pay the invoice" }, bareFacts()), undefined);
});

const SIGN_IN = "sign_in";

/** A Bot whose access includes its own browser. */
function browserFacts(): BotToolFacts {
  const facts = bareFacts();
  return { ...facts, authority: { ...facts.authority, otherCapabilities: [{ kind: "browser" }] } as unknown as BotRuntimeEffectiveAuthority };
}

test("a sign-in card is offered only to runs a person is there to answer", () => {
  for (const [label, requestIds, attended] of RUNS) {
    assert.equal(botIngressAllowsTool(SIGN_IN, requestIds), attended, label);
  }
});

test("a sign-in needs the Browser in the Bot's access and a person there to sign in", async () => {
  for (const [label, requestIds, attended] of RUNS) {
    if (requestIds.includes(INTRO)) continue;
    const turns = requestIds.map(botTurnOf);
    const turn = { telegram: turns.some((each) => each.telegram), routine: turns.some((each) => each.routine) };
    assert.equal((await botToolVerdict(SIGN_IN, browserFacts(), turn)).allowed, attended, label);
  }
  assert.deepEqual(await botToolVerdict(SIGN_IN, bareFacts(), {}), {
    allowed: false,
    reason: "Sign-in needs the Browser or a computer in this Bot's access.",
  });
  assert.equal(await botToolApprovalSummary(SIGN_IN, { site: "github.com" }, browserFacts()), undefined, "the card is the person's answer");
});

test("a Bot with its own computer and no browser can ask for a sign-in on the computer, on attended turns only", async () => {
  const facts = bareFacts();
  const computer = (hasComputer: boolean): BotToolFacts => ({
    ...facts,
    hasComputer,
    authority: { ...facts.authority, otherCapabilities: [{ kind: "computer" }] } as unknown as BotRuntimeEffectiveAuthority,
  });
  for (const [label, requestIds, attended] of RUNS) {
    if (requestIds.includes(INTRO)) continue;
    const turns = requestIds.map(botTurnOf);
    const turn = { telegram: turns.some((each) => each.telegram), routine: turns.some((each) => each.routine) };
    assert.equal((await botToolVerdict(SIGN_IN, computer(true), turn)).allowed, attended, label);
  }
  // The computer in its access but none given yet (or Bot computers off on this Mac).
  assert.equal((await botToolVerdict(SIGN_IN, computer(false), {})).allowed, false);
  // A computer without the capability is not the Bot's to use.
  assert.equal((await botToolVerdict(SIGN_IN, { ...bareFacts(), hasComputer: true }, {})).allowed, false);
});
