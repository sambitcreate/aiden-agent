import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDesignProjectActionParams,
  parseDesignProjectConnectParams,
  parseDesignProjectBindSelectionParams,
  parseDesignProjectContentUpdateEnvelope,
  parseDesignProjectCreateParams,
  parseDesignProjectPreflightParams,
  parseDesignProjectPreviewParams,
  parseDesignProjectStartPreviewParams,
} from "./design-project-params.js";

test("Design Project creation separates Prototype storage from Connected App authority", () => {
  assert.deepEqual(
    parseDesignProjectCreateParams({ title: " Checkout ", connectionState: "prototype-only" }),
    { title: "Checkout", connectionState: "prototype-only" },
  );
  assert.deepEqual(
    parseDesignProjectCreateParams({
      title: "Checkout",
      connectionState: "connected",
      workspaceId: "workspace-1",
    }),
    { title: "Checkout", connectionState: "connected", workspaceId: "workspace-1" },
  );
  assert.throws(
    () =>
      parseDesignProjectCreateParams({
        title: "Forged Prototype",
        connectionState: "prototype-only",
        workspaceId: "workspace-1",
      }),
    /workspace connection/u,
  );
  assert.throws(
    () => parseDesignProjectCreateParams({ title: "Missing", connectionState: "connected" }),
    /workspace connection/u,
  );
  assert.throws(
    () =>
      parseDesignProjectCreateParams({
        title: "Legacy authority",
        connectionState: "connected",
        chatWorkspaceId: "workspace-1",
        connectedWorkspaceId: "workspace-1",
      }),
    /invalid design project request/iu,
  );
});

test("connection and preflight IPC accept identities, never paths", () => {
  assert.deepEqual(
    parseDesignProjectConnectParams({
      projectId: "project:one",
      expectedRevision: 3,
      workspaceId: "workspace-2",
    }),
    { projectId: "project:one", expectedRevision: 3, workspaceId: "workspace-2" },
  );
  assert.deepEqual(parseDesignProjectPreflightParams({ projectId: "project:one" }), {
    projectId: "project:one",
  });
  assert.throws(
    () =>
      parseDesignProjectConnectParams({
        projectId: "project:one",
        expectedRevision: 3,
        workspaceId: "/Users/example/app",
      }),
    /identity/u,
  );
});

test("generic content updates reject forged workspace bindings and transitions", () => {
  const update = {
    id: "project:one",
    expectedRevision: 2,
    canvas: { viewport: "desktop", flowViewport: { x: 0, y: 0, zoom: 1 }, nodes: [] },
    referenceAssetIds: [],
  };
  assert.deepEqual(parseDesignProjectContentUpdateEnvelope(update), update);
  assert.throws(
    () =>
      parseDesignProjectContentUpdateEnvelope({
        ...update,
        connectionState: "connected",
        workspaceId: "forged-workspace",
      }),
    /invalid design project request/iu,
  );
});

test("source preview IPC is project-bound and rejects renderer workspace claims", () => {
  assert.deepEqual(parseDesignProjectPreviewParams({ projectId: "project:one" }), {
    projectId: "project:one",
  });
  assert.deepEqual(
    parseDesignProjectStartPreviewParams({ projectId: "project:one", scriptId: "dev" }),
    { projectId: "project:one", scriptId: "dev" },
  );
  assert.deepEqual(
    parseDesignProjectBindSelectionParams({
      projectId: "project:one",
      sessionId: "preview:one",
      descriptor: { selector: "main" },
    }),
    {
      projectId: "project:one",
      sessionId: "preview:one",
      descriptor: { selector: "main" },
    },
  );
  for (const request of [
    { projectId: "project:one", workspaceId: "forged" },
    { projectId: "project:one", scriptId: "dev", workspaceId: "forged" },
    {
      projectId: "project:one",
      sessionId: "preview:one",
      descriptor: {},
      workspaceId: "forged",
    },
  ]) {
    assert.throws(
      () =>
        "scriptId" in request
          ? parseDesignProjectStartPreviewParams(request)
          : "sessionId" in request
            ? parseDesignProjectBindSelectionParams(request)
            : parseDesignProjectPreviewParams(request),
      /invalid design project request/iu,
    );
  }
});

test("single-file Designer Action IPC accepts only project-owned requests", () => {
  assert.deepEqual(
    parseDesignProjectActionParams({ projectId: "project:one", actionId: "action:one" }),
    { projectId: "project:one", actionId: "action:one" },
  );
  assert.throws(
    () =>
      parseDesignProjectActionParams({
        projectId: "project:one",
        actionId: "action:one",
        workspaceId: "forged",
      }),
    /invalid design project request/iu,
  );
});
