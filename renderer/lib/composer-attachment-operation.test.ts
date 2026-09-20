import assert from "node:assert/strict";
import test from "node:test";
import type { Attachment } from "./types.js";
import { MAX_ATTACHMENT_INLINE_BYTES } from "../shared/attachment-contract.js";
import {
  acceptComposerAttachments,
  ComposerAttachmentOperation,
} from "./composer-attachment-operation.js";

const text = (id: string, value = "context"): Attachment => ({
  id,
  kind: "text",
  name: `${id}.txt`,
  mimeType: "text/plain",
  size: value.length,
  text: value,
});
const image = (id: string, size = 8 * 1024 * 1024): Attachment => ({
  id,
  kind: "image",
  name: `${id}.png`,
  mimeType: "image/png",
  size,
  data: "ignored-in-capacity-test",
});

test("pending completion checks slots consumed by a browser annotation", async () => {
  let current = Array.from({ length: 18 }, (_, index) => text(String(index)));
  const pending = Promise.resolve([text("picked-1"), text("picked-2")]);
  current = [...current, text("annotation")];
  const accepted = acceptComposerAttachments(current, await pending, true);
  assert.deepEqual(
    accepted.map((entry) => entry.id),
    ["picked-1"],
  );
  assert.equal([...current, ...accepted].length, 20);
  assert.equal(current[current.length - 1]?.id, "annotation");
});

test("pending completion checks bytes restored by a failed send", async () => {
  const pending = Promise.resolve([image("picked"), text("small", "hello")]);
  const restored = [image("restored-1"), image("restored-2", 8 * 1024 * 1024 - 5)];
  assert.deepEqual(acceptComposerAttachments(restored, await pending, true), [
    text("small", "hello"),
  ]);
  assert.deepEqual(
    acceptComposerAttachments([image("full", MAX_ATTACHMENT_INLINE_BYTES)], [text("more")], true),
    [],
  );
});

test("commit uses latest model support and deduplicates retained identities", () => {
  const existing = text("existing");
  const added = [image("image"), existing, text("new"), text("new")];
  assert.deepEqual(acceptComposerAttachments([existing], added, false), [text("new")]);
  assert.deepEqual(acceptComposerAttachments([], [image("image")], true), [image("image")]);
});

test("capacity uses retained UTF-8 text, including exact byte boundaries", () => {
  const current = [image("current", MAX_ATTACHMENT_INLINE_BYTES - 4)];
  const unicode = { ...text("unicode", "😀"), size: 999_999_999 };
  assert.deepEqual(acceptComposerAttachments(current, [unicode, text("extra")], true), [unicode]);
  assert.deepEqual(
    acceptComposerAttachments(current, [text("too-large", "😀a"), text("fits", "é")], true),
    [text("fits", "é")],
  );
});

test("unmount invalidates pending success, error, and deferred focus callbacks", async () => {
  const operation = new ComposerAttachmentOperation();
  const token = operation.begin()!;
  const success = Promise.resolve([text("late")]);
  const failure = Promise.reject(new Error("late read failure"));
  const effects: string[] = [];
  const delivery = success.then(() => {
    if (operation.isCurrent(token)) effects.push("append");
  });
  const error = failure.catch(() => {
    if (operation.isCurrent(token)) effects.push("toast");
  });
  const focus = () => {
    if (operation.isCurrent(token)) effects.push("focus");
  };
  operation.cancel();
  await Promise.all([delivery, error]);
  focus();
  operation.finish(token);
  assert.deepEqual(effects, []);
  assert.equal(operation.isBusy, false);
});

test("cancelled clipboard preparation cannot proceed to IPC after remount", async () => {
  const operation = new ComposerAttachmentOperation();
  const old = operation.begin()!;
  const bytes = Promise.resolve(new Uint8Array([1]));
  operation.cancel();
  const replacement = operation.begin()!;
  await bytes;
  assert.equal(operation.isCurrent(old), false);
  operation.finish(old);
  assert.equal(operation.isBusy, true);
  assert.equal(operation.begin(), null);
  assert.equal(operation.isCurrent(replacement), true);
  operation.finish(replacement);
  assert.equal(operation.isBusy, false);
});

test("a newer read invalidates focus scheduled by a completed read", () => {
  const operation = new ComposerAttachmentOperation();
  const first = operation.begin()!;
  assert.equal(operation.begin(), null);
  operation.finish(first);
  assert.equal(operation.isCurrent(first), true);
  const second = operation.begin()!;
  assert.equal(operation.isCurrent(first), false);
  assert.equal(operation.isCurrent(second), true);
});
