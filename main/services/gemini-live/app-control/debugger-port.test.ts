import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSharedDebuggerPort, type DebuggableContents } from "./debugger-port.js";
import { AidenWindowInspectedError } from "./provider.js";

// A stand-in for Electron's WebContents and its debugger: one debugger per
// window, DevTools that can open and close, and a log of what was sent.
class FakeContents extends EventEmitter implements DebuggableContents {
  devToolsOpen = false;
  destroyed = false;
  attachedBy: "live" | "other" | null = null;
  readonly sent: string[] = [];
  readonly debugger = Object.assign(new EventEmitter(), {
    attach: () => {
      if (this.attachedBy) throw new Error("Another debugger is already attached");
      this.attachedBy = "live";
    },
    detach: () => {
      if (!this.attachedBy) throw new Error("Not attached");
      this.attachedBy = null;
      this.debugger.emit("detach");
    },
    isAttached: () => this.attachedBy !== null,
    sendCommand: async (method: string) => {
      if (this.attachedBy !== "live") throw new Error("Not attached");
      this.sent.push(method);
      return {};
    },
  });

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isDevToolsOpened(): boolean {
    return this.devToolsOpen;
  }

  openDevTools(): void {
    this.devToolsOpen = true;
    this.emit("devtools-opened");
  }
}

test("sessions share one attachment: a new session never sees the old one's debugger as an inspector", async () => {
  const contents = new FakeContents();
  const first = createSharedDebuggerPort(contents)!;
  await first.call("Accessibility.enable");
  // A restarted session starts before the old one finishes closing.
  const second = createSharedDebuggerPort(contents)!;
  await second.call("Accessibility.getRootAXNode");
  first.close();
  assert.equal(contents.attachedBy, "live", "the open session keeps the window");
  await second.call("Accessibility.getRootAXNode");
  second.close();
  assert.equal(contents.attachedBy, null, "the last session to close detaches");
  const third = createSharedDebuggerPort(contents)!;
  await third.call("Accessibility.enable");
  third.close();
  assert.deepEqual(contents.sent, [
    "Accessibility.enable",
    "Accessibility.getRootAXNode",
    "Accessibility.getRootAXNode",
    "Accessibility.enable",
  ]);
});

test("DevTools open, or another debugger, means the window is inspected; Live lets go and comes back after", async () => {
  const contents = new FakeContents();
  const port = createSharedDebuggerPort(contents)!;
  await port.call("Accessibility.enable");
  contents.openDevTools();
  assert.equal(contents.attachedBy, null, "Live let go of the window when DevTools opened");
  await assert.rejects(port.call("Accessibility.enable"), AidenWindowInspectedError);
  contents.devToolsOpen = false;
  await port.call("Accessibility.enable");
  assert.equal(contents.attachedBy, "live");
  port.close();

  contents.attachedBy = "other";
  const blocked = createSharedDebuggerPort(contents)!;
  await assert.rejects(blocked.call("Accessibility.enable"), AidenWindowInspectedError);
  blocked.close();
  assert.equal(contents.attachedBy, "other", "a stranger's debugger is never detached");
});
