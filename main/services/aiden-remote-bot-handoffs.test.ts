import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { BotPendingHandoff } from "../../renderer/shared/bot-handoffs.js";
import { BOT_LOCKED_RULES } from "../../renderer/shared/bot-rules.js";
import {
  LEGACY_AUDIENCE,
  legacyHandoffNotice,
  projectBotDetailForAudience,
  projectBotSummaryForAudience,
  stateViewForAudience,
  toRemoteBotHandoff,
} from "./aiden-remote-bot-handoffs.js";
import {
  AIDEN_REMOTE_BOT_SESSION_STATES,
  parseAidenRemoteContractFixture,
  type AidenRemoteBotHandoffsFixture,
} from "./aiden-remote-protocol.js";

const HOLDER = { handoffs: true };

async function section(): Promise<AidenRemoteBotHandoffsFixture> {
  const raw = JSON.parse(
    await readFile(path.resolve(process.cwd(), "protocol/aiden-remote/v1/fixtures/contract.json"), "utf8"),
  ) as unknown;
  return parseAidenRemoteContractFixture(raw).botHandoffs!;
}

/** The card the shared fixture describes, as the Mac's hand-off bridge holds it. */
function prompt(overrides: Partial<BotPendingHandoff> = {}): BotPendingHandoff {
  return {
    botId: "bot_fixture_01",
    waitId: "4f9c2d1e-7a3b-4c5d-9e8f-0a1b2c3d4e5f",
    toolCallId: "call_fixture_36",
    kind: "action",
    action: "Enter the 2FA code your bank sent you",
    why: "The bank asks for a code only you can see.",
    open: { url: "https://bank.example.com/verify" },
    source: "tool",
    ...overrides,
  };
}

test("a holder receives the waiting card exactly as the shared fixture shows it", async () => {
  const fixture = await section();
  assert.deepEqual(toRemoteBotHandoff(prompt()), fixture.session.handoff);
});

test("a card the password-or-code rule opened tells a holder it takes no note; the Bot's own cards and other rules' do not", async () => {
  const fixture = await section();
  const [credentials, money] = BOT_LOCKED_RULES;
  const ruled = (id: string) =>
    toRemoteBotHandoff(prompt({
      waitId: fixture.noNoteHandoff.waitId,
      action: fixture.noNoteHandoff.action,
      why: undefined,
      open: undefined,
      source: "rule",
      rule: { id, label: "Enter passwords or codes" },
    }));
  assert.deepEqual(ruled(credentials!.id), fixture.noNoteHandoff);
  assert.equal("takesNote" in ruled(money!.id), false);
  assert.equal("takesNote" in toRemoteBotHandoff(prompt()), false);
});

test("a hand-off link that is not a plain https page, and a blank reason, never reach a phone", () => {
  for (const url of [
    "http://bank.example.com/verify",
    "https://person:secret@bank.example.com/verify",
    " https://bank.example.com/verify",
    "file:///Users/person/secrets.txt",
  ]) {
    const card = toRemoteBotHandoff(prompt({ open: { url } }));
    assert.equal("open" in card, false, url);
    assert.equal(card.action, "Enter the 2FA code your bank sent you", "the card itself still arrives");
  }
  assert.equal("why" in toRemoteBotHandoff(prompt({ why: "   " })), false);
  const signIn = toRemoteBotHandoff(prompt({
    kind: "sign_in",
    action: "Sign in to bank.example.com",
    why: undefined,
    open: { url: "https://bank.example.com" },
    origin: "https://bank.example.com",
    target: "browser",
  }));
  assert.deepEqual(signIn, {
    waitId: "4f9c2d1e-7a3b-4c5d-9e8f-0a1b2c3d4e5f",
    kind: "sign_in",
    action: "Sign in to bank.example.com",
    open: { url: "https://bank.example.com" },
  }, "the sign-in target and origin stay on the Mac");
});

test("a page the Mac reads in a looser form reaches a phone as the Mac's parser prints it, so every phone can decode the card", () => {
  for (const [given, sent] of [
    // The phones refuse each of these forms; the Mac's own parser reads them all as one page.
    ["https:bank.example.com/verify", "https://bank.example.com/verify"],
    ["https://@bank.example.com/verify", "https://bank.example.com/verify"],
    ["https://bank.exa\tmple.com/verify", "https://bank.example.com/verify"],
    ["HTTPS://Bank.Example.com:443/verify", "https://bank.example.com/verify"],
    ["https://bank.example.com\\verify", "https://bank.example.com/verify"],
    ["https://bänk.example.com/vérify", "https://xn--bnk-qla.example.com/v%C3%A9rify"],
  ]) {
    assert.deepEqual(toRemoteBotHandoff(prompt({ open: { url: given } })).open, { url: sent }, JSON.stringify(given));
  }
  // A page already in that form, or a bare origin as a sign-in names it, goes as it is.
  for (const url of ["https://bank.example.com/verify", "https://github.com", "https://[::1]:8443/a?b=c#d"]) {
    assert.deepEqual(toRemoteBotHandoff(prompt({ open: { url } })).open, { url }, url);
  }
  // Printed, a page may outgrow what a card may carry: the card then goes without it.
  const long = toRemoteBotHandoff(prompt({ open: { url: `https://bank.example.com/${"é".repeat(800)}` } }));
  assert.equal("open" in long, false);
  assert.equal(long.action, "Enter the 2FA code your bank sent you");
});

test("a legacy device reads a waiting hand-off as one assistant line that names the Bot", async () => {
  const fixture = await section();
  const notice = fixture.legacy.session.entries[fixture.legacy.session.entries.length - 1];
  assert.deepEqual(legacyHandoffNotice("Scout", prompt()), notice);
  assert.equal(notice && "createdAt" in notice, false, "the notice never moves a chat's preview or unread state");

  const spaced = legacyHandoffNotice("  Ada \n Lovelace ", prompt({ action: "Approve the  transfer.\n" }));
  assert.equal(spaced.type === "message" && spaced.text, "Ada Lovelace needs you on your Mac: Approve the transfer");
  const unnamed = legacyHandoffNotice(" ", prompt());
  assert.equal(unnamed.type === "message" && unnamed.text, "Your Bot needs you on your Mac: Enter the 2FA code your bank sent you");
});

test("only a person's pause reads differently to a legacy device", () => {
  for (const state of AIDEN_REMOTE_BOT_SESSION_STATES) {
    const view = { state, interrupted: state === "interrupted" };
    assert.deepEqual(stateViewForAudience(view, HOLDER), view, `${state} for a holder`);
    const legacy = stateViewForAudience(view, LEGACY_AUDIENCE);
    if (state === "paused") assert.deepEqual(legacy, { state: "unavailable", interrupted: false });
    else assert.deepEqual(legacy, view, `${state} for a legacy device`);
  }
  // An interrupted turn the person then paused is still a paused Bot to a holder.
  assert.deepEqual(
    stateViewForAudience({ state: "paused", interrupted: true }, LEGACY_AUDIENCE),
    { state: "unavailable", interrupted: false },
  );
});

test("a paused Bot's summary and detail project to the fixture's two views", async () => {
  const fixture = await section();
  assert.deepEqual(projectBotSummaryForAudience(fixture.pausedSummary, LEGACY_AUDIENCE), fixture.legacy.pausedSummary);
  assert.deepEqual(projectBotSummaryForAudience(fixture.pausedSummary, HOLDER), fixture.pausedSummary);

  const legacyDetail = projectBotDetailForAudience(fixture.pausedDetail, LEGACY_AUDIENCE);
  assert.equal("paused" in legacyDetail, false);
  assert.equal(legacyDetail.sessionState, "unavailable");
  assert.deepEqual(projectBotDetailForAudience(fixture.pausedDetail, HOLDER), fixture.pausedDetail);

  // A Bot that is not paused: a holder's detail always says so, a summary stays quiet.
  const { paused: _summaryFlag, ...idleSummary } = { ...fixture.pausedSummary, sessionState: "idle" as const };
  assert.deepEqual(projectBotSummaryForAudience(idleSummary, HOLDER), idleSummary);
  assert.deepEqual(projectBotSummaryForAudience(idleSummary, LEGACY_AUDIENCE), idleSummary);
  const { paused: _detailFlag, ...idleDetail } = { ...fixture.pausedDetail, sessionState: "idle" as const };
  assert.equal(projectBotDetailForAudience(idleDetail, HOLDER).paused, false);
  assert.equal("paused" in projectBotDetailForAudience(idleDetail, LEGACY_AUDIENCE), false);
});

test("a rule's card reaches a phone without its page: that page is the Bot's own tab on the Mac, and the phone's browser would act on the person's own session", () => {
  const ruled = toRemoteBotHandoff(prompt({
    action: "Make a purchase",
    why: "Your rule “Make a purchase” hands this to you. Scout was about to: Click Place your order in its browser",
    open: { url: "https://shop.example.com/cart" },
    source: "rule",
    rule: { id: "default.purchase", label: "Make a purchase" },
  }));
  assert.equal("open" in ruled, false);
  assert.equal(ruled.action, "Make a purchase", "the card itself still arrives, answered Done or Skip");
  assert.deepEqual(toRemoteBotHandoff(prompt()).open, { url: "https://bank.example.com/verify" }, "a link the Bot gave keeps its Open");
});
