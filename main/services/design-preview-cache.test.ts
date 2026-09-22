import assert from "node:assert/strict";
import test from "node:test";
import { DesignPreviewCache } from "./design-preview-cache.js";

test("preview reuse is document/chat/hash bound and expires before protocol URLs", () => {
  let now = 0;
  const cache = new DesignPreviewCache(() => now);
  const document = { title: "Screen", src: "preview", contentHash: "hash", designCapability: "secret" };
  cache.set("owner", "chat", document);
  assert.equal(cache.get("owner", "chat", "hash"), document);
  assert.equal(cache.get("other", "chat", "hash"), undefined);
  assert.equal(cache.get("owner", "other", "hash"), undefined);
  assert.equal(cache.get("owner", "chat", "changed"), undefined);
  now = 5 * 60_000;
  assert.equal(cache.get("owner", "chat", "hash"), undefined);
});

test("preview reuse retains only 32 URL descriptors", () => {
  const cache = new DesignPreviewCache();
  for (let i = 0; i < 33; i++) cache.set("owner", "chat", {
    title: "Screen", src: String(i), contentHash: String(i), designCapability: String(i),
  });
  assert.equal(cache.get("owner", "chat", "0"), undefined);
  assert.equal(cache.get("owner", "chat", "32")?.src, "32");
});

test("the wrapper reauthorizes source before cache lookup and binds a main-owned document", async () => {
  const { readFile } = await import("node:fs/promises");
  const wrapper = await readFile(new URL("./gui-artifact-recovery.ts", import.meta.url), "utf8");
  const start = wrapper.indexOf("export async function wrapStoredHtmlArtifact");
  const sourceRead = wrapper.indexOf("await storedHtmlSource(input.chatId, input.mediaId)", start);
  const cacheRead = wrapper.indexOf("designPreviewCache.get(input.ownerDocumentId, input.chatId, contentHash)", start);
  assert.ok(sourceRead > start && cacheRead > sourceRead);
  const handler = await readFile(new URL("../handlers/chats.ts", import.meta.url), "utf8");
  assert.match(handler, /ownerDocumentId: owner\.documentId/u);
});
