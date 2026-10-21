import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";
import { AidenRemoteWorkspaceBrowserService } from "./aiden-remote-workspace-browser.js";
import { AidenRemoteWorkspaceService } from "./aiden-remote-workspaces.js";
import { createWorkspaceApplicationService } from "./workspace-application-service.js";
import { WorkspaceMutationGate } from "./workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "./workspace-operation-registry.js";
import type { Workspace } from "./types.js";

test("HTTP client completes approved-folder selection and revision-checked workspace CRUD", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-workspace-http-"));
  const approvedDirectory = path.join(temporary, "Approved");
  await fs.mkdir(approvedDirectory);
  const approvedPath = await fs.realpath(approvedDirectory);
  await fs.mkdir(path.join(approvedPath, "Selected"));
  const selectedMarker = path.join(approvedPath, "Selected", "kept-after-unregister.txt");
  await fs.writeFile(selectedMarker, "workspace files stay on disk");
  const approvedIdentity = await fs.stat(approvedPath, { bigint: true });
  let sequence = 0;
  let workspaces: Workspace[] = [{
    id: "default",
    name: "Default",
    permission: "ask",
    createdAt: 1,
    updatedAt: 1,
  }];
  const application = createWorkspaceApplicationService({
    configStore: {
      listWorkspaces: async () => structuredClone(workspaces),
      getWorkspace: async (id) => structuredClone(workspaces.find((workspace) => workspace.id === id)),
      saveWorkspace: async (workspace) => {
        const saved = { ...workspace, updatedAt: workspace.updatedAt + 1 };
        const index = workspaces.findIndex((candidate) => candidate.id === saved.id);
        if (index >= 0) workspaces[index] = saved;
        else workspaces.push(saved);
        return structuredClone(saved);
      },
      removeWorkspace: async (id) => {
        workspaces = workspaces.filter((workspace) => workspace.id !== id);
      },
    },
    llmClient: { cancelWorkspaceAndSettle: async () => undefined },
    scheduleService: {
      cancelWorkspace: async () => undefined,
      resumeWorkspace: async () => undefined,
    },
    terminalService: { closeForWorkspace: () => undefined },
    workspaceMutationGate: new WorkspaceMutationGate(),
    workspaceOperationRegistry: new WorkspaceOperationRegistry(),
    createScratchWorkspaceDirectory: async () => {
      const scratch = path.join(temporary, `Scratch-${sequence}`);
      await fs.mkdir(scratch);
      return { name: "Scratch", folderPath: scratch };
    },
    realpath: (value) => fs.realpath(value),
    stat: (value) => fs.stat(value),
    removeEmptyDirectory: (value) => fs.rmdir(value),
    createId: () => `workspace-${++sequence}`,
    now: () => 10_000 + sequence,
    logError: () => undefined,
  });
  const state = {
    snapshot: async () => ({
      approvedRoots: [{
        id: "root-1",
        label: "Projects",
        folderPath: approvedPath,
        device: approvedIdentity.dev.toString(),
        inode: approvedIdentity.ino.toString(),
        policyRevision: "remote-browser-v1:no-hidden-system",
        createdAt: 1,
      }],
    }) as never,
  };
  const browser = new AidenRemoteWorkspaceBrowserService({
    instanceId: "instance-1",
    state,
    approvalStore: approvedPath,
  });
  const workspaceService = new AidenRemoteWorkspaceService({
    application,
    browser,
  });
  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance-1",
    displayName: () => "Studio Mac",
    appVersion: "test",
    devices: {
      acquireDeviceAuthorization: () => () => undefined,
      authenticate: async () => ({
        id: "device-1",
        revoked: false,
        capabilities: new Set([
          "workspace:read" as const,
          "workspace:browse" as const,
          "workspace:manage" as const,
        ]),
      }),
    },
    pairing: { exchange: async () => { throw new Error("not used"); } },
    workspaces: workspaceService,
    workspaceBrowser: browser,
    connectionMode: () => "lan",
    now: Date.now,
    log: () => undefined,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
  const base = `http://127.0.0.1:${address.port}/api/aiden/v1`;
  const headers = {
    authorization: `Bearer ${"a".repeat(43)}`,
    "aiden-protocol-version": "1",
  };
  try {
    const roots = await (await fetch(`${base}/workspace-browser/roots`, { headers })).json();
    const page = await (
      await fetch(
        `${base}/workspace-browser/children?location=${roots.roots[0].location}`,
        { headers },
      )
    ).json();
    assert.deepEqual(page.entries.map((entry: { name: string }) => entry.name), ["Selected"]);
    const selectionResponse = await fetch(`${base}/workspace-browser/selections`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ location: page.entries[0].location }),
    });
    assert.equal(selectionResponse.status, 201);
    const selection = await selectionResponse.json();

    const createResponse = await fetch(`${base}/workspaces`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "workspace-http-create-0001",
      },
      body: JSON.stringify({
        mode: "selected-folder",
        selection: selection.selection,
        name: "Remote Selected",
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.name, "Remote Selected");
    assert.equal(created.hasFolder, true);
    assert.equal(JSON.stringify(created).includes(approvedPath), false);

    const patchResponse = await fetch(`${base}/workspaces/${created.id}`, {
      method: "PATCH",
      headers: {
        ...headers,
        "content-type": "application/json",
        "if-match": created.revision,
      },
      body: JSON.stringify({ confirmedForeground: true, permission: "full" }),
    });
    assert.equal(patchResponse.status, 200);
    const updated = await patchResponse.json();
    assert.equal(updated.permission, "full");

    const deleteResponse = await fetch(`${base}/workspaces/${created.id}`, {
      method: "DELETE",
      headers: { ...headers, "if-match": updated.revision },
    });
    assert.equal(deleteResponse.status, 204);
    const listed = await (await fetch(`${base}/workspaces`, { headers })).json();
    assert.deepEqual(listed.workspaces.map((workspace: { id: string }) => workspace.id), ["default"]);
    assert.equal(await fs.readFile(selectedMarker, "utf8"), "workspace files stay on disk");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("project cloning is desktop-only, requires folder browsing, and cancels with its HTTP request", async t => {
  let type: "mac" | "iphone" = "iphone";
  let browse = true;
  let calls = 0;
  let captured: AbortSignal | undefined;
  let opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const handler = createAidenRemoteRequestHandler({
    instanceId: "instance", displayName: () => "Host", appVersion: "test", connectionMode: () => "lan", now: Date.now, log: () => undefined,
    pairing: { exchange: async () => { throw new Error("not used"); } },
    devices: { acquireDeviceAuthorization: () => () => undefined, authenticate: async () => ({ id: "device", type, revoked: false, capabilities: new Set(["workspace:manage" as const, ...(browse ? ["workspace:browse" as const] : [])]) }) },
    workspaces: {
      supportsClone: true, list: async () => ({ workspaces: [] }), get: async () => { throw new Error("not used"); }, update: async () => { throw new Error("not used"); }, remove: async () => undefined,
      create: async (_device, _key, _input, signal) => {
        calls++; captured = signal; opened();
        await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
        throw new Error("cancelled");
      },
    },
  });
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/api/aiden/v1/workspaces`;
  const options = { method: "POST", headers: { authorization: `Bearer ${"a".repeat(43)}`, "aiden-protocol-version": "1", "idempotency-key": "clone-http-request", "content-type": "application/json" }, body: JSON.stringify({ mode: "clone", selection: `sel_${"a".repeat(43)}`, url: "https://example.invalid/widget.git", files: [] }) };
  assert.equal((await fetch(endpoint, options)).status, 403);
  assert.equal(calls, 0);
  type = "mac"; browse = false;
  assert.equal((await fetch(endpoint, options)).status, 403);
  assert.equal(calls, 0);
  browse = true;
  const controller = new AbortController();
  const cloning = fetch(endpoint, { ...options, signal: controller.signal }).catch(() => undefined);
  await ready; controller.abort(); await cloning;
  await new Promise(resolve => setImmediate(resolve));
  // The server observes socket closure asynchronously.
  if (!captured?.aborted) await new Promise<void>(resolve => captured!.addEventListener("abort", () => resolve(), { once: true }));
  assert.equal(captured?.aborted, true);
  assert.equal(calls, 1);
});
