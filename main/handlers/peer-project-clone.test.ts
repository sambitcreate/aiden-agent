import assert from "node:assert/strict";
import test from "node:test";
import { registerPeerProjectCloneHandlers } from "./peer-project-clone.js";

function fixture() {
  const handlers = new Map<string, (event: string, ...args: unknown[]) => unknown>();
  const invalidations = new Map<string, () => void>();
  const calls: Array<{ host: unknown; input: unknown; signal?: AbortSignal }> = [];
  let reads = 0;
  const dependencies = {
    handle: (channel: string, handler: (event: string, ...args: unknown[]) => unknown) => { handlers.set(channel, handler); },
    owner: (event: string) => ({ key: event, isDestroyed: () => event === "stale", onInvalidated: (listener: () => void) => { invalidations.set(event, listener); return () => { invalidations.delete(event); }; } }),
    source: { preview: async () => ({ name: "Widget", url: "https://example.invalid/widget.git", repositoryName: "widget", files: [{ name: ".env", bytes: 3 }] }), read: async (_id: string, selected: unknown) => { reads++; return { source: { name: "Widget", url: "https://example.invalid/widget.git", repositoryName: "widget", files: [] }, files: (selected as string[]).map(name => ({ name, content: "A=1" })) }; } },
    hosts: async () => [{ id: "host", name: "Studio", enabled: true, state: "connected" as const, features: ["workspace-clone-v1"], capabilities: ["workspace:manage", "workspace:browse"] }],
    manager: () => ({ call: async (host: unknown, input: unknown, signal?: AbortSignal) => { calls.push({ host, input, signal }); return { ok: true as const, value: { id: "remote", name: "Widget" } }; } }),
  };
  registerPeerProjectCloneHandlers(dependencies);
  return { dependencies, handlers, calls, invalidations, reads: () => reads };
}
const request = { cloneId: "clone-test-001", hostId: "host", workspaceId: "project", selection: `sel_${"s".repeat(43)}`, files: [] };
test("project transfer reads no file content by default and only sends selected files through main", async () => {
  const fixture_ = fixture();
  await fixture_.handlers.get("workspaces:peerClonePreview")!("owner", "project");
  assert.equal(fixture_.reads(), 0);
  await fixture_.handlers.get("workspaces:peerClone")!("owner", request);
  assert.deepEqual((fixture_.calls[0]!.input as { body: unknown }).body, { mode: "clone", selection: request.selection, url: "https://example.invalid/widget.git", files: [] });
  await fixture_.handlers.get("workspaces:peerClone")!("owner", { ...request, cloneId: "clone-test-002", files: [".env"] });
  assert.deepEqual((fixture_.calls[1]!.input as { body: { files: unknown } }).body.files, [{ name: ".env", content: "A=1" }]);
  assert.throws(() => fixture_.handlers.get("workspaces:peerClonePreview")!("stale", "project"), /document changed/);
});

test("only the owning document can cancel its clone, and document invalidation aborts it", async () => {
  const fixture_ = fixture();
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  fixture_.dependencies.manager = () => ({ call: async (host, input, signal) => { fixture_.calls.push({ host, input, signal }); await pending; return { ok: true, value: { id: "remote", name: "Widget" } }; } });
  const cloning = fixture_.handlers.get("workspaces:peerClone")!("owner", request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture_.handlers.get("workspaces:peerCloneCancel")!("other", request.cloneId), false);
  assert.equal(fixture_.calls[0]!.signal!.aborted, false);
  fixture_.invalidations.get("owner")!();
  assert.equal(fixture_.calls[0]!.signal!.aborted, true);
  complete(); await cloning;
});

test("an unsupported host cannot read selected environment files", async () => {
  const fixture_ = fixture();
  fixture_.dependencies.hosts = async () => [];
  await assert.rejects(Promise.resolve(fixture_.handlers.get("workspaces:peerClone")!("owner", { ...request, files: [".env"] })), /Update the paired/);
  assert.equal(fixture_.reads(), 0);
  assert.equal(fixture_.calls.length, 0);
});


test("Stop during the initial host lookup prevents reading environment contents or starting a clone", async () => {
  const fixture_ = fixture();
  const hosts = await fixture_.dependencies.hosts();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture_.dependencies.hosts = async () => { await gate; return hosts; };
  const cloning = fixture_.handlers.get("workspaces:peerClone")!("owner", request);
  assert.equal(fixture_.handlers.get("workspaces:peerCloneCancel")!("owner", request.cloneId), true);
  release();
  await assert.rejects(Promise.resolve(cloning), /stopped/);
  assert.equal(fixture_.reads(), 0);
  assert.equal(fixture_.calls.length, 0);
});
