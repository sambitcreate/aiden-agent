import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TelegramPairingPanel } from "./telegram-pairing-panel.js";

const noop = () => {};
test("pairing cannot start while disconnected and explains its five-minute command", () => {
  const html = renderToStaticMarkup(<TelegramPairingPanel busy={false} disabled onBegin={noop} onCancel={noop} />);
  assert.match(html, /five minutes/u);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Start pairing/u);
  assert.doesNotMatch(html, /value="\/start/u);
});
test("an active proof is a readonly accessible command with copy and cancellation actions", () => {
  const html = renderToStaticMarkup(<TelegramPairingPanel pending={{ code: "synthetic-proof", expiresAt: 300_000 }} busy={false} disabled={false} onBegin={noop} onCancel={noop} />);
  assert.match(html, /aria-label="Telegram pairing command"/u);
  assert.match(html, /readOnly=""/u);
  assert.match(html, /value="\/start synthetic-proof"/u);
  assert.match(html, />Copy command</u);
  assert.match(html, />Cancel pairing</u);
  assert.doesNotMatch(html, />Start pairing</u);
});
