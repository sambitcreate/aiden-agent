import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_INLINE_BYTES } from "../shared/attachment-contract";
import { terminalContextAttachment, terminalContextText } from "./terminal-context";
import type { Attachment } from "./types";

const selection = { label: "Terminal 2", lineStart: 12, lineEnd: 20, text: "npm ERR! missing script\n" };

test("a selection becomes a named text attachment sized by its encoded bytes", () => {
  const attachment = terminalContextAttachment({ ...selection, text: "café" }, [], "id-1");
  assert.ok(attachment);
  assert.equal(attachment.id, "id-1");
  assert.equal(attachment.name, "Terminal 2 lines 12-20.txt");
  assert.equal(attachment.kind, "text");
  // The framing is ASCII, so "é" is the one character that takes two bytes.
  assert.equal(attachment.size, attachment.text!.length + 1);
});

test("a one-line selection is named for that line", () => {
  const attachment = terminalContextAttachment({ ...selection, lineEnd: 12 }, [], "id");
  assert.equal(attachment?.name, "Terminal 2 line 12.txt");
});

test("the agent is told output is reference material, and it follows that notice", () => {
  const text = terminalContextText(selection);
  const notice = text.indexOf("untrusted reference material");
  assert.ok(notice >= 0);
  assert.ok(text.indexOf("npm ERR!") > notice);
});

test("line endings and surrounding blank lines are cleaned without touching the output", () => {
  const text = terminalContextText({ ...selection, text: "\r\n\n  one\r\n\r\n  two\n\n" });
  assert.ok(text.endsWith("\n  one\n\n  two"));
});

test("an oversized selection keeps its end, where a run reports what failed", () => {
  const text = terminalContextText({ ...selection, text: `start${"x".repeat(60_000)}FAILED` });
  assert.ok(text.endsWith("FAILED"));
  assert.equal(text.includes("start"), false);
  assert.ok(text.includes("[Earlier output omitted]"));
  assert.ok(text.length < 49_000);
});

test("nothing is attached for an empty selection or a full message", () => {
  assert.equal(terminalContextAttachment({ ...selection, text: "\n\n" }, [], "id"), null);
  const small: Attachment = { id: "a", name: "a.txt", kind: "text", mimeType: "text/plain", text: "a", size: 1 };
  const full = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, () => small);
  assert.equal(terminalContextAttachment(selection, full, "id"), null);
  const noRoom: Attachment = { ...small, kind: "image", size: MAX_ATTACHMENT_INLINE_BYTES - 4 };
  assert.equal(terminalContextAttachment(selection, [noRoom], "id"), null);
});
