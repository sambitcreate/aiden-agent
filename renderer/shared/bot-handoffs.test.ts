import assert from "node:assert/strict";
import test from "node:test";
import {
  botHandoffAnswerOf,
  botHandoffResultLine,
  botHandoffResultOf,
  isBotHandoffOpenUrl,
  isBotHandoffOrigin,
  normalizeBotHandoffAction,
} from "./bot-handoffs.js";

test("a card opens only https pages with a host and no credentials", () => {
  for (const url of [
    "https://bank.example/verify",
    "https://bank.example:8443/2fa?step=1#code",
    "https://xn--bcher-kva.example/",
  ]) {
    assert.equal(isBotHandoffOpenUrl(url), true, url);
  }
  for (const url of [
    "http://bank.example/verify",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "mailto:ada@example.com",
    "https://ada:secret@bank.example/",
    "https://ada@bank.example/",
    " https://bank.example/",
    "https://bank.example/\n",
    "bank.example/verify",
    "",
    `https://bank.example/${"a".repeat(2_048)}`,
  ]) {
    assert.equal(isBotHandoffOpenUrl(url), false, JSON.stringify(url));
  }
});

test("an origin is exactly scheme and host, as URL.origin prints it", () => {
  assert.equal(isBotHandoffOrigin("https://github.com"), true);
  assert.equal(isBotHandoffOrigin("https://github.com:8443"), true);
  assert.equal(isBotHandoffOrigin("https://github.com/"), false, "a path is not an origin");
  assert.equal(isBotHandoffOrigin("https://github.com/login"), false);
  assert.equal(isBotHandoffOrigin("http://github.com"), false);
  assert.equal(isBotHandoffOrigin(42), false);
});

test("the card title is one tidy line without a trailing full stop", () => {
  assert.equal(normalizeBotHandoffAction("  Enter the 2FA code\n  for your bank.  "), "Enter the 2FA code for your bank");
  assert.equal(normalizeBotHandoffAction("Approve the payment..."), "Approve the payment");
  assert.equal(normalizeBotHandoffAction("Sign the form?"), "Sign the form?", "a question mark is kept");
  assert.equal(normalizeBotHandoffAction(" . "), "");
});

test("an answer is exactly Done or Skip with an optional note, trimmed", () => {
  assert.deepEqual(botHandoffAnswerOf({ outcome: "done" }), { outcome: "done" });
  assert.deepEqual(botHandoffAnswerOf({ outcome: "skipped", note: "  Not today.  " }), {
    outcome: "skipped",
    note: "Not today.",
  });
  for (const value of [
    null,
    "done",
    [],
    {},
    { outcome: "allow" },
    { outcome: "done", note: "" },
    { outcome: "done", note: "   " },
    { outcome: "done", note: 7 },
    { outcome: "done", note: "x".repeat(4_001) },
    { outcome: "done", extra: true },
    { outcome: "done", note: "\uD800" },
  ]) {
    assert.equal(botHandoffAnswerOf(value), undefined, JSON.stringify(value));
  }
  assert.deepEqual(botHandoffAnswerOf({ outcome: "done", note: "x".repeat(4_000) })?.outcome, "done", "4,000 is allowed");
});

test("transcript details read back as a hand-off answer only when every field is well formed", () => {
  assert.deepEqual(botHandoffResultOf({ kind: "action", outcome: "done", action: "Pay the invoice", note: "Paid." }), {
    kind: "action",
    outcome: "done",
    action: "Pay the invoice",
    note: "Paid.",
  });
  assert.deepEqual(
    botHandoffResultOf({
      kind: "sign_in",
      outcome: "done",
      action: "Sign in to github.com",
      origin: "https://github.com",
      toolCallId: "call-9",
      rule: { id: "credentials", label: "Enter a password or 2FA code" },
    }),
    {
      kind: "sign_in",
      outcome: "done",
      action: "Sign in to github.com",
      origin: "https://github.com",
      toolCallId: "call-9",
      rule: { id: "credentials", label: "Enter a password or 2FA code" },
    },
  );
  for (const details of [
    undefined,
    { answerText: "Blue" },
    { kind: "action", outcome: "maybe", action: "Pay" },
    { kind: "payment", outcome: "done", action: "Pay" },
    { kind: "action", outcome: "done", action: "" },
    { kind: "action", outcome: "done", action: "x".repeat(161) },
    { kind: "action", outcome: "done", action: "Pay", note: "" },
    { kind: "sign_in", outcome: "done", action: "Sign in", origin: "http://github.com" },
    { kind: "action", outcome: "done", action: "Pay", rule: { id: "money" } },
  ]) {
    assert.equal(botHandoffResultOf(details), undefined, JSON.stringify(details));
  }
});

test("the person's side of the chat says what they did, skipped or signed in to", () => {
  assert.equal(botHandoffResultLine({ kind: "action", outcome: "done", action: "Pay the invoice" }), "You did this: Pay the invoice");
  assert.equal(
    botHandoffResultLine({ kind: "action", outcome: "skipped", action: "Pay the invoice" }),
    "You skipped this: Pay the invoice",
  );
  assert.equal(
    botHandoffResultLine({ kind: "sign_in", outcome: "done", action: "Sign in to github.com", origin: "https://github.com" }),
    "You signed in to github.com",
  );
  assert.equal(
    botHandoffResultLine({ kind: "sign_in", outcome: "skipped", action: "Sign in to github.com", origin: "https://github.com" }),
    "You skipped this: Sign in to github.com",
  );
  assert.equal(
    botHandoffResultLine({ kind: "sign_in", outcome: "done", action: "Sign in to gitlab.com" }),
    "You signed in to gitlab.com",
    "without an origin, the host comes from the action",
  );
});
