import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { closeRendererBeforeShutdown, joinInFlight, type RendererQuitWindow, withDeadline } from "./quit-barrier.js";

class FakeQuitWindow extends EventEmitter implements RendererQuitWindow {
  readonly webContents = new EventEmitter();
  destroyed = false;
  preventUnload = false;
  hung = false;
  destroyCalls = 0;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.emit("closed");
  }

  close(): void {
    if (this.hung) return;
    if (this.preventUnload) {
      this.webContents.emit("will-prevent-unload");
      return;
    }
    this.destroyed = true;
    this.emit("closed");
  }
}

test("closes the renderer before allowing irreversible service shutdown", async () => {
  const window = new FakeQuitWindow();
  assert.equal(await closeRendererBeforeShutdown(window), true);
  assert.equal(window.destroyed, true);
  assert.equal(window.listenerCount("closed"), 0);
  assert.equal(window.webContents.listenerCount("will-prevent-unload"), 0);
});

test("an unload veto blocks service shutdown and leaves the renderer alive", async () => {
  const window = new FakeQuitWindow();
  window.preventUnload = true;
  assert.equal(await closeRendererBeforeShutdown(window), false);
  assert.equal(window.destroyed, false);
  assert.equal(window.listenerCount("closed"), 0);
  assert.equal(window.webContents.listenerCount("will-prevent-unload"), 0);
});

test("a real close may invalidate the BrowserWindow webContents getter before cleanup", async () => {
  const contents = new EventEmitter();
  class DestroyingQuitWindow extends EventEmitter implements RendererQuitWindow {
    destroyed = false;

    get webContents(): EventEmitter {
      if (this.destroyed) throw new Error("Object has been destroyed");
      return contents;
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    close(): void {
      this.destroyed = true;
      this.emit("closed");
    }

    destroy(): void {
      this.close();
    }
  }

  const window = new DestroyingQuitWindow();
  assert.equal(await closeRendererBeforeShutdown(window), true);
  assert.equal(contents.listenerCount("will-prevent-unload"), 0);
});

test("a hung renderer that never answers beforeunload is destroyed after the deadline", async () => {
  const window = new FakeQuitWindow();
  window.hung = true;
  assert.equal(await closeRendererBeforeShutdown(window, 5), true);
  assert.equal(window.destroyed, true);
  assert.equal(window.destroyCalls, 1);
  assert.equal(window.listenerCount("closed"), 0);
  assert.equal(window.webContents.listenerCount("will-prevent-unload"), 0);
});

test("a prompt close or veto is never followed by a late destroy", async () => {
  const closing = new FakeQuitWindow();
  assert.equal(await closeRendererBeforeShutdown(closing, 5), true);
  const vetoing = new FakeQuitWindow();
  vetoing.preventUnload = true;
  assert.equal(await closeRendererBeforeShutdown(vetoing, 5), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closing.destroyCalls, 0);
  assert.equal(vetoing.destroyCalls, 0);
  assert.equal(vetoing.destroyed, false);
});

test("withDeadline reports fulfilled, rejected, and synchronous-throw outcomes", async () => {
  assert.deepEqual(await withDeadline(async () => 7, 1_000), { status: "fulfilled", value: 7 });
  assert.deepEqual(await withDeadline(() => "sync", 1_000), { status: "fulfilled", value: "sync" });
  const failure = new Error("flush failed");
  assert.deepEqual(
    await withDeadline(async () => {
      throw failure;
    }, 1_000),
    { status: "rejected", error: failure },
  );
  assert.deepEqual(
    await withDeadline(() => {
      throw failure;
    }, 1_000),
    { status: "rejected", error: failure },
  );
});

test("withDeadline stops waiting on work that never settles", async () => {
  const started = Date.now();
  const outcome = await withDeadline(() => new Promise<never>(() => undefined), 10);
  assert.deepEqual(outcome, { status: "timed-out" });
  assert.ok(Date.now() - started < 1_000, "the deadline, not the work, ended the wait");
});

test("withDeadline ignores a rejection that arrives after the deadline", async () => {
  let reject: (error: Error) => void = () => undefined;
  const outcome = await withDeadline(
    () =>
      new Promise<never>((_resolve, rejectWork) => {
        reject = rejectWork;
      }),
    5,
  );
  assert.deepEqual(outcome, { status: "timed-out" });
  reject(new Error("late"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("a call made while a run is in flight waits for that run's outcome", async () => {
  // Models the startup-failure path: destroying the last window starts the
  // shutdown from before-quit, then the catch calls it again and checks
  // whether Aiden really quit once it settles.
  let started = false;
  let release!: () => void;
  const runs: boolean[] = [];
  const shutdown = joinInFlight(async (settingsPrepared: boolean) => {
    if (started) return;
    started = true;
    runs.push(settingsPrepared);
    await new Promise<void>((resolve) => { release = resolve; });
    started = false; // the shutdown gave up and Aiden stayed open
  });

  const first = shutdown(false);
  let joinedSawStarted: boolean | undefined;
  const joined = shutdown(true).then(() => { joinedSawStarted = started; });
  await Promise.resolve();
  assert.equal(joinedSawStarted, undefined, "the second caller waits instead of returning at once");
  release();
  await Promise.all([first, joined]);
  assert.deepEqual(runs, [false], "only one shutdown ran");
  assert.equal(joinedSawStarted, false, "the joined caller sees that the shutdown gave up");

  // After it settles, a new call starts a fresh run.
  const again = shutdown(true);
  release();
  await again;
  assert.deepEqual(runs, [false, true]);
});
