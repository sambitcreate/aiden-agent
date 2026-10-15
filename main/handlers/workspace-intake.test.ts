import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { WorkspaceCloneProgress } from "../../renderer/shared/workspace-intake.js";
import type { Workspace } from "../services/types.js";
import { createWorkspaceApplicationService, type WorkspaceApplicationDependencies } from "../services/workspace-application-service.js";
import { createWorkspaceIntakeService, type GitCloneRequest } from "../services/workspace-intake.js";
import { registerWorkspaceIntakeHandlers, type WorkspaceIntakeOwner } from "./workspace-intake.js";

/** One renderer main-frame document; `navigate` invalidates it like a reload. */
class FakeDocument implements WorkspaceIntakeOwner {
  readonly received: WorkspaceCloneProgress[] = [];
  private destroyed = false;
  private readonly listeners = new Set<() => void>();
  constructor(readonly key: string) {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  onInvalidated(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(channel: "workspaces:clone-progress", payload: WorkspaceCloneProgress): void {
    assert.equal(channel, "workspaces:clone-progress");
    this.received.push(payload);
  }
  navigate(): void {
    this.destroyed = true;
    for (const listener of [...this.listeners]) {
      this.listeners.delete(listener);
      listener();
    }
  }
}

type FakeEvent = { document: FakeDocument | null };

/** A clone that reports progress, then waits until released or cancelled. */
function controllableClone() {
  const started: GitCloneRequest[] = [];
  let release: (() => void) | undefined;
  const runClone = async (request: GitCloneRequest) => {
    started.push(request);
    request.onProgress({ phase: "Receiving objects", percent: 40 });
    const outcome = await new Promise<"done" | "cancelled">((resolve) => {
      release = () => resolve("done");
      request.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });
    if (outcome === "cancelled") return { ok: false as const, reason: "cancelled" as const, stderrTail: "" };
    await fs.mkdir(path.join(request.destination, ".git"), { recursive: true });
    return { ok: true as const };
  };
  return { runClone, started, release: () => release?.() };
}

async function setup(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-intake-ipc-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaces: Workspace[] = [];
  let nextId = 0;
  const application = createWorkspaceApplicationService({
    configStore: {
      listWorkspaces: async () => [...workspaces],
      saveWorkspace: async (workspace: Workspace) => {
        workspaces.push(workspace);
        return workspace;
      },
    },
    realpath: (value: string) => fs.realpath(value),
    stat: (value: string) => fs.stat(value),
    createId: () => `w-${++nextId}`,
    now: () => 1,
  } as unknown as WorkspaceApplicationDependencies);
  const clone = controllableClone();
  const service = createWorkspaceIntakeService({
    home: root,
    stat: (target) => fs.stat(target),
    realpath: (target) => fs.realpath(target),
    readdir: (target) => fs.readdir(target),
    mkdir: async (target) => {
      await fs.mkdir(target);
    },
    rmdir: (target) => fs.rmdir(target),
    removeTree: (target) => fs.rm(target, { recursive: true, force: true }),
    listWorkspaces: async () => [...workspaces],
    getWorkspace: async (id) => workspaces.find((workspace) => workspace.id === id) ?? null,
    createFromFolder: (folderPath) => application.createFromFolder(folderPath),
    runClone: clone.runClone,
  });
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  let changed = 0;
  registerWorkspaceIntakeHandlers<FakeEvent>({
    handle: (channel, handler) => handlers.set(channel, handler),
    owner: (event) => {
      if (!event.document) throw new Error("Workspace access requires the active renderer document.");
      return event.document;
    },
    service: () => service,
    notifyChanged: () => {
      changed += 1;
    },
  });
  const invoke = (channel: string, document: FakeDocument | null, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} is registered`);
    return Promise.resolve().then(() => handler({ document }, ...args));
  };
  return { root, workspaces, clone, invoke, changed: () => changed };
}

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check());
}

test("path IPC inspects read-only and opens with validated options", async (t) => {
  const { root, workspaces, invoke, changed } = await setup(t);
  const document = new FakeDocument("window-1");
  const target = path.join(root, "new-app");

  assert.deepEqual(await invoke("workspaces:inspectPath", document, target), { kind: "creatable", path: target });
  await assert.rejects(invoke("workspaces:inspectPath", document, target, 42), /relativeToWorkspaceId/u);
  await assert.rejects(invoke("workspaces:inspectPath", null, target), /active renderer document/u);
  await assert.rejects(invoke("workspaces:openPath", document, target, { create: "yes" }), /boolean "create"/u);
  await assert.rejects(invoke("workspaces:openPath", document, target, "create"), /object/u);

  const missing = await invoke("workspaces:openPath", document, target, { create: false });
  assert.deepEqual(missing, { ok: false, code: "missing", reason: "That folder doesn't exist yet." });
  assert.equal(changed(), 0);

  const created = (await invoke("workspaces:openPath", document, target, { create: true })) as {
    ok: true;
    workspace: Workspace;
  };
  assert.equal(created.ok, true);
  assert.equal(created.workspace.folderPath, target);
  assert.equal(changed(), 1, "a new workspace is announced");

  // Relative to that workspace, `.` is the workspace itself.
  assert.deepEqual(await invoke("workspaces:inspectPath", document, ".", created.workspace.id), {
    kind: "existing-workspace",
    workspaceId: created.workspace.id,
    path: target,
  });
  const reopened = (await invoke("workspaces:openPath", document, ".", {
    create: false,
    relativeToWorkspaceId: created.workspace.id,
  })) as { ok: true; existing: boolean };
  assert.equal(reopened.existing, true);
  assert.equal(changed(), 1, "re-selecting an existing workspace is not a change");
  assert.equal(workspaces.length, 1);
});

test("clone IPC routes progress to its document and registers the result", async (t) => {
  const { root, clone, invoke, changed, workspaces } = await setup(t);
  const document = new FakeDocument("window-1");
  const other = new FakeDocument("window-2");

  assert.deepEqual(await invoke("workspaces:clonePreview", document, "acme/widget"), {
    ok: true,
    url: "https://github.com/acme/widget.git",
    repoName: "widget",
    destination: path.join(root, "widget"),
  });
  await assert.rejects(invoke("workspaces:clone", document, { cloneId: "bad id", url: "acme/widget" }), /clone identifier/u);

  const running = invoke("workspaces:clone", document, { cloneId: "clone-0001", url: "acme/widget" });
  await eventually(() => clone.started.length === 1);
  await assert.rejects(
    invoke("workspaces:clone", document, { cloneId: "clone-0001", url: "acme/other" }),
    /already running/u,
  );
  assert.equal(await invoke("workspaces:cloneCancel", other, "clone-0001"), false, "another document cannot cancel");
  clone.release();
  const result = (await running) as { ok: true; workspace: Workspace; destination: string };
  assert.equal(result.ok, true);
  assert.equal(result.destination, path.join(root, "widget"));
  assert.deepEqual(document.received, [{ cloneId: "clone-0001", phase: "Receiving objects", percent: 40 }]);
  assert.deepEqual(other.received, []);
  assert.equal(changed(), 1);
  assert.deepEqual(workspaces.map((workspace) => workspace.folderPath), [path.join(root, "widget")]);
  assert.equal(await invoke("workspaces:cloneCancel", document, "clone-0001"), false, "finished clones are gone");
});

test("clone IPC cancels on request and when its document goes away", async (t) => {
  const { root, clone, invoke, changed } = await setup(t);
  const document = new FakeDocument("window-1");

  const cancelled = invoke("workspaces:clone", document, { cloneId: "clone-0002", url: "acme/widget" });
  await eventually(() => clone.started.length === 1);
  assert.equal(await invoke("workspaces:cloneCancel", document, "clone-0002"), true);
  assert.deepEqual(await cancelled, { ok: false, code: "cancelled", reason: "Clone cancelled." });

  const reloaded = invoke("workspaces:clone", document, { cloneId: "clone-0003", url: "acme/gadget" });
  await eventually(() => clone.started.length === 2);
  document.navigate();
  assert.deepEqual(await reloaded, { ok: false, code: "cancelled", reason: "Clone cancelled." });
  assert.equal(changed(), 0);
  assert.deepEqual(await fs.readdir(root), [], "cancelled clones leave nothing behind");
  await assert.rejects(invoke("workspaces:cloneCancel", document, "clone-0003"), /document changed/u);
});
