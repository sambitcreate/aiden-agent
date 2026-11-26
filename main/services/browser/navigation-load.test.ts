import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { loadBrowserUrl } from "./navigation-load.js";

const OLD = "http://127.0.0.1:4000/start";
const NEW = "http://127.0.0.1:4000/held";

/**
 * A guest whose loadURL starts its main-frame navigation synchronously, as
 * Chromium does unless a beforeunload handler defers it, and whose own promise
 * settles as Electron's does: on the first main-frame finish, failure or stop
 * after the call, whichever document sent it.
 */
class FakeGuest extends EventEmitter {
  loading = false;
  defersStart = false;
  isLoading() { return this.loading; }
  loadURL(url: string, startsNavigation = !this.defersStart): Promise<void> {
    const native = new Promise<void>((resolve, reject) => {
      this.once("did-finish-load", () => resolve());
      this.once("did-fail-load", (_event, code: number, description: string, failedUrl: string) =>
        reject(new Error(`${description} (${code}) loading '${failedUrl}'`)));
      this.once("did-stop-loading", () =>
        reject(Object.assign(new Error(`ERR_FAILED (-2) loading '${url}'`), { errno: -2 })));
    });
    if (startsNavigation) this.emit("did-start-navigation", {}, url, false, true);
    return native;
  }
  stopLoading() { this.loading = false; this.emit("did-stop-loading"); }
  commit(url = NEW) { this.emit("did-navigate", {}, url, 200, "OK"); }
  finish() { this.emit("did-finish-load", {}); }
  fail(code: number, description: string, url: string, isMainFrame = true) {
    this.emit("did-fail-load", {}, code, description, url, isMainFrame);
  }
}

const outcome = async (promise: Promise<void>) => {
  let result: string = "pending";
  promise.then(() => { result = "loaded"; }, (error: unknown) => { result = String(error); });
  await new Promise((resolve) => setImmediate(resolve));
  return result;
};

test("replacing a still-loading document waits for the requested page, not the replaced one", async () => {
  const guest = new FakeGuest();
  const load = loadBrowserUrl(guest, NEW);
  // The replaced document stops loading and reports its own abort and finish.
  guest.fail(-3, "", OLD);
  guest.finish();
  assert.equal(await outcome(load), "pending", "the replaced document cannot settle the new load");
  guest.commit();
  assert.equal(await outcome(load), "pending", "a committed page has not finished loading yet");
  guest.finish();
  assert.equal(await outcome(load), "loaded");
});

test("a still-loading document that completes before a deferred start cannot settle the new load", async () => {
  for (const completion of ["finish", "fail", "stop"] as const) {
    const guest = new FakeGuest();
    guest.loading = true;
    guest.defersStart = true; // beforeunload runs before the navigation starts
    const load = loadBrowserUrl(guest, NEW);
    if (completion === "finish") guest.finish();
    if (completion === "fail") guest.fail(-102, "ERR_CONNECTION_REFUSED", OLD);
    guest.stopLoading();
    assert.equal(await outcome(load), "pending", completion);
    guest.loading = true;
    guest.emit("did-start-navigation", {}, NEW, false, true);
    guest.commit();
    guest.finish();
    assert.equal(await outcome(load), "loaded", completion);
  }
});

test("a deferred load still fails on its own stop, and on a stop with nothing else loading", async () => {
  const guest = new FakeGuest();
  guest.loading = true;
  guest.defersStart = true;
  const load = loadBrowserUrl(guest, NEW);
  guest.stopLoading(); // the replaced document's
  guest.loading = true;
  guest.emit("did-start-navigation", {}, NEW, false, true);
  guest.stopLoading(); // this load's, before it committed
  assert.equal(await outcome(load), `Error: ERR_FAILED (-2) loading '${NEW}'`);

  const idle = new FakeGuest();
  idle.defersStart = true;
  const stopped = loadBrowserUrl(idle, NEW);
  idle.stopLoading();
  assert.equal(await outcome(stopped), `Error: ERR_FAILED (-2) loading '${NEW}'`);
});

test("the requested page's own failures still reject", async () => {
  const provisional = new FakeGuest();
  const unresolved = loadBrowserUrl(provisional, NEW);
  provisional.fail(-105, "ERR_NAME_NOT_RESOLVED", NEW);
  provisional.finish(); // The error page loads without a did-navigate.
  assert.equal(await outcome(unresolved), `Error: ERR_NAME_NOT_RESOLVED (-105) loading '${NEW}'`);

  const stopped = new FakeGuest();
  const aborted = loadBrowserUrl(stopped, NEW);
  stopped.commit();
  stopped.fail(-3, "", NEW);
  stopped.emit("did-stop-loading");
  assert.equal(await outcome(aborted), `Error:  (-3) loading '${NEW}'`);
});

test("a newer navigation supersedes the load, and subframe failures do not", async () => {
  const guest = new FakeGuest();
  const load = loadBrowserUrl(guest, NEW);
  guest.fail(-3, "", "http://127.0.0.1:4000/frame", false);
  guest.emit("did-start-navigation", {}, "http://127.0.0.1:4000/start#again", true, true);
  assert.equal(await outcome(load), "pending");
  guest.emit("did-start-navigation", {}, "http://127.0.0.1:4000/newer", false, true);
  assert.equal(await outcome(load), "Error: ERR_ABORTED (-3) loading 'http://127.0.0.1:4000/newer'");
});

test("a same-document load finishes on its in-page commit", async () => {
  const guest = new FakeGuest();
  const load = new Promise<void>((resolve, reject) => {
    const original = guest.loadURL.bind(guest);
    guest.loadURL = (url: string) => {
      const native = original(url, false);
      guest.emit("did-start-navigation", {}, url, true, true);
      return native;
    };
    loadBrowserUrl(guest, `${OLD}#section`).then(resolve, reject);
  });
  assert.equal(await outcome(load), "pending");
  guest.emit("did-navigate-in-page", {}, `${OLD}#section`, true);
  assert.equal(await outcome(load), "loaded");
});

test("a load that never starts reports Electron's own rejection, and the guest is left unobserved", async () => {
  const guest = new FakeGuest();
  guest.loadURL = () => Promise.reject(new Error("ERR_INVALID_URL (-300) loading 'bad'"));
  assert.equal(await outcome(loadBrowserUrl(guest, "bad")), "Error: ERR_INVALID_URL (-300) loading 'bad'");
  for (const event of ["did-start-navigation", "did-navigate", "did-fail-load", "did-finish-load", "did-stop-loading", "destroyed"])
    assert.equal(guest.listenerCount(event), 0, event);

  const destroyed = new FakeGuest();
  const load = loadBrowserUrl(destroyed, NEW);
  destroyed.emit("destroyed");
  assert.equal(await outcome(load), `Error: ERR_FAILED (-2) loading '${NEW}'`);
});
