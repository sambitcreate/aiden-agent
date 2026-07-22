import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { closeRendererBeforeShutdown, type RendererQuitWindow } from "./quit-barrier.js";

class FakeQuitWindow extends EventEmitter implements RendererQuitWindow {
  readonly webContents = new EventEmitter();
  destroyed = false;
  preventUnload = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  close(): void {
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
