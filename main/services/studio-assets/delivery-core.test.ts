import assert from "node:assert/strict";
import test from "node:test";
import { StudioAssetError } from "./contract.js";
import { StudioAssetGrants, studioAssetGrantToken } from "./delivery-core.js";

const ASSET = "b".repeat(64);
const OTHER = "c".repeat(64);

function owner(id = 1, documentId = "7:1:token-a") {
  let destroyed = false;
  const listeners = new Set<() => void>();
  return {
    id,
    documentId,
    isDestroyed: () => destroyed,
    onInvalidated(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    navigate() {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  };
}

test("issued URLs carry only an opaque token that resolves to the asset", () => {
  const grants = new StudioAssetGrants();
  const url = grants.issue(owner(), ASSET, "original");
  assert.match(url, /^aiden-asset:\/\/grant\/[A-Za-z0-9_-]{43}$/u);
  assert.equal(url.includes(ASSET), false);
  assert.deepEqual(grants.resolve(studioAssetGrantToken(url)!), { assetId: ASSET, rendition: "original" });
});

test("grants deduplicate per document, asset and rendition", () => {
  const grants = new StudioAssetGrants();
  const a = owner(1, "doc-a");
  const b = owner(1, "doc-b");
  // Deduped pair: identical document, asset and rendition share one grant.
  assert.equal(grants.issue(a, ASSET, "thumb-256"), grants.issue(a, ASSET, "thumb-256"));
  assert.equal(grants.size(), 1, "the repeated issue created no second grant");
  // Distinct renditions and distinct documents each get their own grant.
  assert.notEqual(grants.issue(a, ASSET, "thumb-256"), grants.issue(a, ASSET, "thumb-512"));
  assert.notEqual(grants.issue(a, ASSET, "original"), grants.issue(b, ASSET, "original"));
  // thumb-256, thumb-512, original/a, original/b.
  assert.equal(grants.size(), 4);
});

test("navigation revokes every grant of that document and only that document", () => {
  const grants = new StudioAssetGrants();
  const a = owner(1, "doc-a");
  const b = owner(2, "doc-b");
  const aUrls = [grants.issue(a, ASSET, "original"), grants.issue(a, OTHER, "thumb-256")];
  const bUrl = grants.issue(b, ASSET, "original");
  assert.equal(a.listeners(), 1, "one invalidation listener per document");

  a.navigate();
  for (const url of aUrls) assert.equal(grants.resolve(studioAssetGrantToken(url)!), undefined);
  assert.deepEqual(grants.resolve(studioAssetGrantToken(bUrl)!), { assetId: ASSET, rendition: "original" });
  assert.equal(a.listeners(), 0);
  assert.equal(grants.size(), 1);
});

test("a destroyed document can neither receive nor use grants", () => {
  const grants = new StudioAssetGrants();
  const a = owner();
  const url = grants.issue(a, ASSET, "original");
  a.navigate();
  assert.equal(grants.resolve(studioAssetGrantToken(url)!), undefined);
  assert.throws(
    () => grants.issue(a, ASSET, "original"),
    (error: unknown) => error instanceof StudioAssetError && error.code === "unavailable",
  );
  assert.throws(
    () => grants.issue(owner(), "../etc/passwd", "original"),
    (error: unknown) => error instanceof StudioAssetError && error.code === "not_found",
  );
});

test("a document that is destroyed without notifying listeners is revoked on resolve", () => {
  const grants = new StudioAssetGrants();
  let destroyed = false;
  const silent = {
    id: 3,
    documentId: "doc-silent",
    isDestroyed: () => destroyed,
    onInvalidated: () => () => undefined,
  };
  const url = grants.issue(silent, ASSET, "original");
  destroyed = true;
  assert.equal(grants.resolve(studioAssetGrantToken(url)!), undefined);
  assert.equal(grants.size(), 0);
});

test("capacity evicts the oldest grant first", () => {
  const grants = new StudioAssetGrants({ maxGrants: 2 });
  const a = owner();
  const first = grants.issue(a, ASSET, "original");
  const second = grants.issue(a, ASSET, "thumb-256");
  grants.issue(a, ASSET, "original"); // refreshes `first`
  const third = grants.issue(a, OTHER, "original");
  assert.equal(grants.resolve(studioAssetGrantToken(second)!), undefined);
  assert.ok(grants.resolve(studioAssetGrantToken(first)!));
  assert.ok(grants.resolve(studioAssetGrantToken(third)!));
});

test("only exact grant URLs yield a token", () => {
  const token = "A".repeat(43);
  assert.equal(studioAssetGrantToken(`aiden-asset://grant/${token}`), token);
  for (const url of [
    `aiden-asset://grant/${token}?x=1`,
    `aiden-asset://grant/${token}#f`,
    `aiden-asset://other/${token}`,
    `aiden-asset://grant/${token}/extra`,
    `aiden-genui://grant/${token}`,
    "aiden-asset://grant/short",
    "not a url",
  ]) {
    assert.equal(studioAssetGrantToken(url), undefined, url);
  }
});
