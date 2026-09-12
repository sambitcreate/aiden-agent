import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { LinuxDictationPortal, linuxDictationDesktopEntryAvailable } from "./linux-dictation-portal.js";

function child() {
  const result = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stdin: new PassThrough(), exitCode: null, killed: false,
    kill() { this.killed = true; return true; },
  });
  return result;
}
function setup(timeout = 1000) {
  const events: string[] = [];
  const children: ReturnType<typeof child>[] = [];
  const portal = new LinuxDictationPortal({ activated: () => events.push("down"), deactivated: () => events.push("up"), lost: () => events.push("lost") }, () => {
    const process = child(); children.push(process); return process as unknown as ChildProcess;
  }, timeout);
  const send = (type: string, index = children.length - 1) => children[index].stdout.write(JSON.stringify({ type, triggerDescription: "Ctrl+Space" }) + "\n");
  return { portal, events, children, send };
}
test("portal binds explicitly and deduplicates down/up edges", async () => {
  const h = setup(); assert.equal(h.children.length, 0);
  const bound = h.portal.bind(); h.send("bound");
  assert.equal((await bound).triggerDescription, "Ctrl+Space");
  h.send("activated"); h.send("activated"); h.send("deactivated"); h.send("deactivated");
  assert.deepEqual(h.events, ["down", "up"]); h.portal.close();
});
test("portal accepts an empty desktop trigger description as unknown display text", async () => {
  const h = setup();
  const bound = h.portal.bind();
  h.children[0].stdout.write('{"type":"bound","triggerDescription":"  "}\n');
  assert.equal((await bound).triggerDescription, null);
  assert.equal(h.portal.active, true);
  h.portal.close();
});
test("portal setup availability requires discoverable installed desktop metadata", () => {
  const visited: string[] = [];
  const exists = (candidate: string) => { visited.push(candidate); return candidate.startsWith("/home/aiden/"); };
  assert.equal(linuxDictationDesktopEntryAvailable("/home/aiden", exists), true);
  assert.equal(visited[visited.length - 1], "/home/aiden/.local/share/applications/com.sambitcreate.aiden-agent.desktop");
  assert.equal(linuxDictationDesktopEntryAvailable(undefined, () => false), false);
});
test("cancelled setup cannot activate from delayed stale process messages", async () => {
  const h = setup(); const first = h.portal.bind();
  const rejected = assert.rejects(first, /cancelled/); h.portal.close(); await rejected;
  const second = h.portal.bind(); h.send("bound", 0); h.send("activated", 0);
  assert.equal(h.portal.active, false); h.send("bound"); await second;
  h.children[0].emit("exit", 1); assert.equal(h.portal.active, true);
  assert.deepEqual(h.events, []); h.portal.close();
});
test("session loss fires once and ignores all following events", async () => {
  const h = setup(); const bound = h.portal.bind(); h.send("bound"); await bound;
  h.send("activated"); h.children[0].emit("exit", 1); h.send("deactivated"); h.children[0].emit("error", new Error());
  assert.deepEqual(h.events, ["down", "lost"]); assert.equal(h.portal.active, false);
});
test("unbound events and oversized protocol messages fail closed", async () => {
  for (const input of ['{"type":"activated"}\n', 'x'.repeat(4097)]) {
    const h = setup(); const bound = h.portal.bind(); const rejection = assert.rejects(bound);
    h.children[0].stdout.write(input); await rejection;
    assert.equal(h.portal.active, false); assert.deepEqual(h.events, []);
  }
});
test("permission request timeout kills its owner", async () => {
  const h = setup(5); await assert.rejects(h.portal.bind(), /timed out/);
  assert.equal(h.children[0].killed, true); assert.equal(h.portal.active, false);
});

test("stdin failure ends bound authority without an unhandled stream error", async () => {
  const h = setup(); const bound = h.portal.bind(); h.send("bound"); await bound;
  h.children[0].stdin.emit("error", new Error("broken pipe"));
  assert.equal(h.portal.active, false); assert.deepEqual(h.events, ["lost"]);
});
test("closing a helper that ignores graceful shutdown escalates to SIGKILL", async () => {
  const h = setup(); const bound = h.portal.bind(); h.send("bound"); await bound;
  const signals: Array<string | undefined> = [];
  h.children[0].kill = (signal?: string) => { signals.push(signal); return true; };
  h.portal.close();
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.deepEqual(signals, [undefined, "SIGKILL"]);
});
