import assert from "node:assert/strict";
import test from "node:test";
import {
  browserUrl,
  browserDisplayUrl,
  browserRedactPreviewUrls,
  browserPageCaptureBounds,
  browserPartition,
  browserDeadline,
  browserResult,
  browserLocalServers,
  BrowserActionQueue,
} from "./core.js";
import { playwrightInjectedSource } from "./playwright-source.generated.js";

test("navigation normalizes public and loopback hosts but refuses privileged schemes and credentials", () => {
  assert.equal(browserUrl("example.com/path"), "https://example.com/path");
  assert.equal(browserUrl("localhost:5173"), "http://localhost:5173/");
  assert.equal(browserUrl("[::1]:4000/path"), "http://[::1]:4000/path");
  assert.equal(browserUrl("about:blank"), "about:blank");
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,test",
    "http://user:pass@example.com",
    "chrome://settings",
    "https://",
  ]) {
    assert.throws(() => browserUrl(url));
  }
});
test("profile partitions isolate persistent, ephemeral, and unusual identity bytes", () => {
  assert.match(browserPartition("one", false), /^persist:aiden-browser-profile-/);
  assert.doesNotMatch(browserPartition("one", true), /^persist:/);
  assert.notEqual(browserPartition("one", false), browserPartition("two", false));
  assert.notEqual(browserPartition("p\ud800", false), browserPartition("p\ufffd", false));
  assert.notEqual(browserPartition("p\\ud800", false), browserPartition("p\ud800", false));
});
test("local preview capabilities are omitted from exported URLs without changing ordinary queries", () => {
  assert.equal(
    browserDisplayUrl("http://127.0.0.1:3000/report.html?__aiden_preview=secret&tab=one"),
    "http://127.0.0.1:3000/report.html?tab=one",
  );
  assert.equal(
    browserDisplayUrl("https://example.com/?__aiden_preview=site-value"),
    "https://example.com/?__aiden_preview=site-value",
  );
});
test("responsive captures exclude mismatched-aspect native slot letterboxing", () => {
  assert.deepEqual(
    browserPageCaptureBounds(
      { width: 400, height: 500 },
      { mode: "responsive", width: 1280, height: 720 },
    ),
    { x: 0, y: 0, width: 400, height: 225 },
  );
  assert.deepEqual(
    browserPageCaptureBounds(
      { width: 900, height: 400 },
      { mode: "responsive", width: 390, height: 844 },
    ),
    { x: 0, y: 0, width: 185, height: 400 },
  );
  assert.deepEqual(
    browserPageCaptureBounds(
      { width: 400, height: 500 },
      { mode: "fill", width: 1280, height: 720 },
    ),
    { x: 0, y: 0, width: 400, height: 500 },
  );
});

test("nested accessibility and diagnostic URL properties do not expose preview capabilities", () => {
  const source = { nodes: [{ properties: [{ name: "url", value: { value: "http://127.0.0.1:3000/doc.html?__aiden_preview=secret" } }] }], title: "Preview" };
  const redacted = browserRedactPreviewUrls(source);
  assert.equal(redacted.nodes[0].properties[0].value.value, "http://127.0.0.1:3000/doc.html");
  assert.equal(redacted.title, "Preview");
  assert.match(source.nodes[0].properties[0].value.value, /secret/);
});
test("queued actions serialize and human intervention revokes active and already queued work", async () => {
  const queue = new BrowserActionQueue();
  let release!: () => void;
  const first = queue.run(async (check) => {
    await new Promise<void>((resolve) => (release = resolve));
    check();
    return 1;
  });
  const second = queue.run(async () => 2);
  await Promise.resolve();
  await Promise.resolve();
  queue.interrupt();
  assert.equal(queue.signal?.aborted, true);
  release();
  await assert.rejects(first, /interrupted/);
  await assert.rejects(second, /interrupted/);
  assert.equal(await queue.run(async () => 3), 3);
});
test("action deadlines cancel pending operations and preserve rejection cleanup", async () => {
  const controller = new AbortController();
  const pending = browserDeadline(new Promise(() => {}), 10000, controller.signal);
  controller.abort(new Error("generation stopped"));
  await assert.rejects(pending, /generation stopped/);
  await assert.rejects(browserDeadline(new Promise(() => {}), 1), /timed out/);
  assert.equal(await browserDeadline(Promise.resolve(42), 10), 42);
});
test("page evaluations are bounded and Playwright's complete locator runtime ships offline", () => {
  assert.deepEqual(browserResult({ ok: true }), { ok: true });
  assert.throws(() => browserResult({ text: "x".repeat(300000) }), /too large/);
  assert.ok(playwrightInjectedSource.length > 100000);
  assert.ok(playwrightInjectedSource.includes("generateSelectorSimple"));
  assert.ok(playwrightInjectedSource.includes("querySelector"));
  assert.ok(playwrightInjectedSource.includes("strictModeViolationError"));
});
test("terminal server discovery recognizes only printed loopback URLs without probing", () => {
  const servers = browserLocalServers(
    "\u001b[32mLocal: http://localhost:5173/\u001b[0m\nListening http://0.0.0.0:3000\nRemote: https://example.com:443/\nhttp://[::1]:8080/test",
  );
  assert.deepEqual(
    servers.map((server) => server.url),
    ["http://localhost:5173/", "http://localhost:3000/", "http://[::1]:8080/test"],
  );
  assert.deepEqual(browserLocalServers("localhost password=secret 3000"), []);
});
