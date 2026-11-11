// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import test from "node:test";
import {
  DESIGN_SNAPSHOT_LIMIT,
  FrameSnapshotCache,
  captureFrameSnapshot,
} from "./frame-snapshots";

test("the cache keeps the 60 most recently used snapshots", () => {
  const cache = new FrameSnapshotCache();
  for (let index = 0; index < DESIGN_SNAPSHOT_LIMIT; index += 1) cache.set(`f${index}`, 0, `data:${index}`);
  // Reading f0 makes it the most recently used, so f1 is the oldest now.
  assert.equal(cache.get("f0", 0), "data:0");
  cache.set("extra", 0, "data:extra");
  assert.equal(cache.get("f1", 0), undefined, "the least recently used snapshot is dropped");
  assert.equal(cache.get("f0", 0), "data:0");
  assert.equal(cache.get("extra", 0), "data:extra");
  assert.equal(cache.get(`f${DESIGN_SNAPSHOT_LIMIT - 1}`, 0), `data:${DESIGN_SNAPSHOT_LIMIT - 1}`);
});

test("a snapshot belongs to one version of the frame's file", () => {
  const cache = new FrameSnapshotCache();
  cache.set("page", 3, "data:old");
  assert.equal(cache.get("page", 3), "data:old");
  assert.equal(cache.get("page", 4), undefined, "a newer file version invalidates it");
  cache.set("page", 4, "data:new");
  assert.equal(cache.get("page", 4), "data:new");
  assert.equal(cache.get("page", 3), undefined, "and the old version's picture is gone");
});

test("subscribers hear about new snapshots", () => {
  const cache = new FrameSnapshotCache();
  let heard = 0;
  const stop = cache.subscribe(() => (heard += 1));
  cache.set("a", 0, "data:a");
  stop();
  cache.set("b", 0, "data:b");
  assert.equal(heard, 1);
});

test("capturing asks main for the frame's rectangle and stores the picture", async () => {
  const calls = installBotTestIpc({
    "designCanvas:capture": () => ({ dataUrl: "data:image/png;base64,AAAA" }),
  });
  const cache = new FrameSnapshotCache();
  const url = await captureFrameSnapshot(cache, "page", 2, { x: 10.4, y: 20, width: 300, height: 200 });
  assert.equal(url, "data:image/png;base64,AAAA");
  assert.equal(cache.get("page", 2), url);
  const capture = calls.find((call) => call.channel === "designCanvas:capture");
  assert.deepEqual(capture?.args, [{ x: 10.4, y: 20, width: 300, height: 200 }]);
});

test("a failed capture keeps the snapshot the frame already had", async () => {
  const cache = new FrameSnapshotCache();
  cache.set("page", 2, "data:kept");
  installBotTestIpc({ "designCanvas:capture": () => ({ error: "unavailable" }) });
  assert.equal(await captureFrameSnapshot(cache, "page", 2, { x: 0, y: 0, width: 10, height: 10 }), undefined);
  installBotTestIpc({
    "designCanvas:capture": () => {
      throw new Error("window closed");
    },
  });
  assert.equal(await captureFrameSnapshot(cache, "page", 2, { x: 0, y: 0, width: 10, height: 10 }), undefined);
  assert.equal(cache.get("page", 2), "data:kept");
});

test("a capture still on its way when the frame's picture is forgotten is not kept", async () => {
  let answer: (value: { dataUrl: string }) => void = () => undefined;
  installBotTestIpc({ "designCanvas:capture": () => new Promise((resolve) => (answer = resolve)) });
  const cache = new FrameSnapshotCache();
  const capture = captureFrameSnapshot(cache, "page", 2, { x: 0, y: 0, width: 10, height: 10 });
  // The page is edited in place while the capture runs.
  cache.forget("page");
  answer({ dataUrl: "data:before-the-edit" });
  assert.equal(await capture, undefined);
  assert.equal(cache.get("page", 2), undefined, "the picture from before the edit is not kept");

  // A capture that starts after the edit is kept as usual.
  installBotTestIpc({ "designCanvas:capture": () => ({ dataUrl: "data:after-the-edit" }) });
  assert.equal(await captureFrameSnapshot(cache, "page", 2, { x: 0, y: 0, width: 10, height: 10 }), "data:after-the-edit");
  assert.equal(cache.get("page", 2), "data:after-the-edit");
});

test("a capture that ends after a later picture was kept leaves that picture in place", async () => {
  let answer: (value: { dataUrl: string }) => void = () => undefined;
  installBotTestIpc({ "designCanvas:capture": () => new Promise((resolve) => (answer = resolve)) });
  const cache = new FrameSnapshotCache();
  const capture = captureFrameSnapshot(cache, "page", 2, { x: 0, y: 0, width: 10, height: 10 });
  // The page reloaded as version 3 and was pictured while the first capture ran.
  cache.set("page", 3, "data:newer");
  answer({ dataUrl: "data:older" });
  assert.equal(await capture, undefined);
  assert.equal(cache.get("page", 3), "data:newer");
});
