import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";

import {
  installStartupIpcAdmission,
  type InvokeHandlerTarget,
} from "./startup-ipc-admission.js";

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** Minimal ipcMain stand-in: records handlers and lets the test invoke them. */
function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  const target = {
    handle(channel: string, listener: Listener) {
      if (handlers.has(channel))
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, listener);
    },
  };
  const invoke = async (channel: string, ...args: unknown[]) => {
    const listener = handlers.get(channel);
    if (!listener) throw new Error(`No handler registered for '${channel}'`);
    return listener({} as IpcMainInvokeEvent, ...args);
  };
  return { target: target as unknown as InvokeHandlerTarget, invoke };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("holds invokes until startup admission opens, then answers them in arrival order", async () => {
  const ipc = fakeIpcMain();
  const admission = installStartupIpcAdmission(ipc.target);
  const reads: string[] = [];
  ipc.target.handle("chats:list", () => {
    reads.push("chats:list");
    return ["reconciled"];
  });
  ipc.target.handle("settings:get", (_event, key) => {
    reads.push(`settings:get:${String(key)}`);
    return { key };
  });

  const list = ipc.invoke("chats:list");
  const settings = ipc.invoke("settings:get", "appearance");
  await settle();
  assert.deepEqual(reads, [], "no handler may run before reconciliation");
  assert.equal(admission.isOpen(), false);

  admission.open();
  assert.deepEqual(await list, ["reconciled"]);
  assert.deepEqual(await settings, { key: "appearance" });
  assert.deepEqual(reads, ["chats:list", "settings:get:appearance"]);
});

test("handlers registered after admission opens run immediately", async () => {
  const ipc = fakeIpcMain();
  const admission = installStartupIpcAdmission(ipc.target);
  admission.open();
  admission.open();
  ipc.target.handle("app:version", () => "1.2.3");
  assert.equal(await ipc.invoke("app:version"), "1.2.3");
});

test("held invokes still surface handler failures to the caller", async () => {
  const ipc = fakeIpcMain();
  const admission = installStartupIpcAdmission(ipc.target);
  ipc.target.handle("chats:delete", () => {
    throw new Error("chat is locked");
  });
  const pending = ipc.invoke("chats:delete");
  admission.open();
  await assert.rejects(pending, /chat is locked/);
});

test("keeps duplicate registration errors from the underlying ipcMain", () => {
  const ipc = fakeIpcMain();
  installStartupIpcAdmission(ipc.target);
  ipc.target.handle("app:ready", () => true);
  assert.throws(() => ipc.target.handle("app:ready", () => false), /second handler/);
});
