import assert from "node:assert/strict";
import test from "node:test";
import { botBubbleOverlayHears, isTrustedBotBubbleSender } from "./bot-bubbles-window-security.js";

const url = "file:///app/build/renderer/bot-bubbles.html";
const overlays = new Set([7, 8]);

test("only the main frame of a current overlay on the overlay page is trusted", () => {
  assert.equal(
    isTrustedBotBubbleSender(overlays, url, { webContentsId: 8, frameUrl: url, isMainFrame: true }),
    true,
  );
  assert.equal(
    isTrustedBotBubbleSender(overlays, url, { webContentsId: 1, frameUrl: url, isMainFrame: true }),
    false,
    "another window",
  );
  assert.equal(
    isTrustedBotBubbleSender(overlays, url, {
      webContentsId: 7,
      frameUrl: url,
      isMainFrame: false,
    }),
    false,
    "a subframe",
  );
  assert.equal(
    isTrustedBotBubbleSender(overlays, url, {
      webContentsId: 7,
      frameUrl: "https://example.com/",
      isMainFrame: true,
    }),
    false,
    "a navigated page",
  );
  assert.equal(
    isTrustedBotBubbleSender(new Set(), url, {
      webContentsId: 7,
      frameUrl: url,
      isMainFrame: true,
    }),
    false,
    "no overlays",
  );
  assert.equal(
    isTrustedBotBubbleSender(overlays, "", { webContentsId: 7, frameUrl: "", isMainFrame: true }),
    false,
    "no page loaded",
  );
});

test("an in-page link in the mini chat keeps the overlay trusted", () => {
  // Clicking a markdown footnote or `[x](#section)` only adds a fragment.
  assert.equal(
    isTrustedBotBubbleSender(overlays, url, {
      webContentsId: 7,
      frameUrl: `${url}#fn-1`,
      isMainFrame: true,
    }),
    true,
  );
  assert.equal(
    isTrustedBotBubbleSender(overlays, url, {
      webContentsId: 7,
      frameUrl: "file:///app/build/renderer/main-window.html#x",
      isMainFrame: true,
    }),
    false,
    "another page with a fragment is still another page",
  );
});

test("an overlay hears Bot notifications only for its heads", () => {
  const bubbled = new Set(["bot-in"]);
  for (const channel of [
    "bots:changed",
    "bots:approval",
    "bots:approval-settled",
    "bots:attention",
  ]) {
    assert.equal(botBubbleOverlayHears(channel, { botId: "bot-in" }, bubbled), true, channel);
    assert.equal(botBubbleOverlayHears(channel, { botId: "bot-out" }, bubbled), false, channel);
  }
  assert.equal(
    botBubbleOverlayHears("bots:changed", {}, bubbled),
    true,
    "a change naming no Bot means re-read",
  );
  assert.equal(
    botBubbleOverlayHears("bots:approval", {}, bubbled),
    false,
    "an approval always names its Bot",
  );
  assert.equal(
    botBubbleOverlayHears("settings:appearance-changed", { botId: "bot-out" }, bubbled),
    true,
  );
  assert.equal(botBubbleOverlayHears("bots:bubbles:changed", { bubbles: [] }, bubbled), true);
});
