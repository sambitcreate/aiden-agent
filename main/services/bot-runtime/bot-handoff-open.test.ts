import assert from "node:assert/strict";
import test from "node:test";
import type { BotPendingHandoff } from "../../../renderer/shared/bot-handoffs.js";
import { openBotHandoff, type BotHandoffOpenFrom, type BotHandoffOpeners } from "./bot-handoff-open.js";

function card(overrides: Partial<BotPendingHandoff> = {}): BotPendingHandoff {
  return {
    botId: "bot:ada",
    waitId: "w-1",
    toolCallId: "call-1",
    kind: "action",
    action: "Enter the 2FA code for your bank",
    source: "tool",
    ...overrides,
  };
}

const LINK = { url: "https://bank.example/verify" };
const SIGN_IN = card({ kind: "sign_in", action: "Sign in to github.com", origin: "https://github.com", open: { url: "https://github.com/login" } });

/** Records every opener call; `browser`/`computer` say whether the Bot has one (undefined: the feature is absent). */
function openers(options: { browser?: boolean; computer?: boolean } = {}) {
  const calls: string[] = [];
  const result: BotHandoffOpeners = {
    external: async (url) => void calls.push(`external ${url}`),
    focusChat: async (botId) => void calls.push(`chat ${botId}`),
  };
  if (options.browser !== undefined) {
    result.botBrowser = async (botId, waitId, url, hold) => {
      calls.push(`browser ${botId} ${waitId} ${url} ${hold}`);
      return options.browser!;
    };
  }
  if (options.computer !== undefined) {
    result.botComputer = async (botId, waitId, url) => {
      calls.push(`computer ${botId} ${waitId} ${url}`);
      return options.computer!;
    };
  }
  return { openers: result, calls };
}

async function open(prompt: BotPendingHandoff, from: BotHandoffOpenFrom, options?: { browser?: boolean; computer?: boolean }) {
  const recorded = openers(options);
  const opened = await openBotHandoff(prompt, from, recorded.openers);
  return { opened, calls: recorded.calls };
}

test("Open on the Mac takes the person to the card's page: the Bot's own browser when it has one, else the system browser", async () => {
  assert.deepEqual(await open(card({ open: LINK }), "desktop"), {
    opened: "external",
    calls: ["external https://bank.example/verify"],
  });
  assert.deepEqual(await open(card({ open: LINK }), "desktop", { browser: false }), {
    opened: "external",
    calls: ["browser bot:ada w-1 https://bank.example/verify handoff", "external https://bank.example/verify"],
  });
  assert.deepEqual(await open(card({ open: LINK }), "desktop", { browser: true }), {
    opened: "browser",
    calls: ["browser bot:ada w-1 https://bank.example/verify handoff"],
  });
  assert.deepEqual(await open(card(), "desktop", { browser: true }), { opened: "none", calls: [] }, "a card without a page opens nothing");
});

test("Open from a phone brings the Bot's chat forward on the Mac and leaves the page to the phone", async () => {
  for (const prompt of [card({ open: LINK }), card()]) {
    assert.deepEqual(await open(prompt, "phone", { browser: true }), { opened: "focused", calls: ["chat bot:ada"] });
  }
});

test("a sign-in opens where the Bot will use it: its browser or its computer, and nothing when it has neither", async () => {
  assert.deepEqual(await open(SIGN_IN, "desktop", { browser: true, computer: true }), {
    opened: "browser",
    calls: ["browser bot:ada w-1 https://github.com/login sign_in"],
  });
  assert.deepEqual(await open({ ...SIGN_IN, target: "computer" }, "desktop", { browser: true, computer: true }), {
    opened: "computer",
    calls: ["computer bot:ada w-1 https://github.com/login"],
  });
  assert.deepEqual(await open(SIGN_IN, "desktop"), { opened: "none", calls: [] }, "never the system browser: the Bot could not use that sign-in");
  assert.deepEqual(await open({ ...SIGN_IN, target: "computer" }, "desktop", { browser: true, computer: false }), {
    opened: "none",
    calls: ["computer bot:ada w-1 https://github.com/login"],
  });
});

test("a sign-in from a phone brings the chat forward first, then opens on the Mac where the Bot can use it", async () => {
  assert.deepEqual(await open(SIGN_IN, "phone", { browser: true }), {
    opened: "browser",
    calls: ["chat bot:ada", "browser bot:ada w-1 https://github.com/login sign_in"],
  });
  assert.deepEqual(await open(SIGN_IN, "phone"), { opened: "focused", calls: ["chat bot:ada"] });
});

test("a link that is not a plain https page is never opened, whoever asks", async () => {
  for (const url of ["http://bank.example/verify", "javascript:alert(1)", "https://ada:secret@bank.example/", "file:///etc/passwd"]) {
    assert.deepEqual(await open(card({ open: { url } }), "desktop", { browser: true }), { opened: "none", calls: [] }, url);
    assert.deepEqual(await open({ ...SIGN_IN, open: { url } }, "desktop", { browser: true }), { opened: "none", calls: [] }, url);
  }
});
