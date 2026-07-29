import assert from "node:assert/strict";
import test from "node:test";
import {
  admitRendererOwnedWorkspaceOperation,
  WorkspaceOperationRegistry,
} from "./workspace-operation-registry.js";

test("workspace authority changes abort and drain the complete admitted operation", async () => {
  const registry = new WorkspaceOperationRegistry();
  const operation = registry.admit("workspace-1");
  let settled = false;
  const draining = registry.cancelAndSettle("workspace-1").then(() => {
    settled = true;
  });

  assert.equal(operation.signal.aborted, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  operation.release();
  await draining;
  assert.equal(settled, true);
});

test("managed deletion drains sibling operations without waiting on itself", async () => {
  const registry = new WorkspaceOperationRegistry();
  const deletion = registry.admit("workspace-1");
  const sibling = registry.admit("workspace-1");
  const draining = registry.cancelAndSettle("workspace-1", {
    exceptSignal: deletion.signal,
  });

  assert.equal(deletion.signal.aborted, false);
  assert.equal(sibling.signal.aborted, true);
  sibling.release();
  await draining;
  deletion.release();
});

test("a non-cooperative operation fails closed before workspace authority changes", async () => {
  const registry = new WorkspaceOperationRegistry();
  const operation = registry.admit("workspace-1");
  await assert.rejects(
    registry.cancelAndSettle("workspace-1", { timeoutMs: 5 }),
    /workspace was not changed/u,
  );
  operation.release();
});

test("renderer document invalidation aborts and drains its admitted workspace capability", async () => {
  const registry = new WorkspaceOperationRegistry();
  let invalidated = false;
  let listener: (() => void) | undefined;
  let listenerRemoved = false;
  const operation = admitRendererOwnedWorkspaceOperation(
    registry,
    {
      isDestroyed: () => invalidated,
      onInvalidated: (nextListener) => {
        listener = nextListener;
        return () => {
          listener = undefined;
          listenerRemoved = true;
        };
      },
    },
    "workspace-1",
  );

  invalidated = true;
  listener?.();

  assert.equal(operation.signal.aborted, true);
  assert.match(String(operation.signal.reason), /document is no longer active/u);
  const draining = registry.cancelAndSettle("workspace-1");
  operation.release();
  await draining;
  assert.equal(listenerRemoved, true);
});

test("an already-invalid renderer document never receives live workspace authority", async () => {
  const registry = new WorkspaceOperationRegistry();
  const operation = admitRendererOwnedWorkspaceOperation(
    registry,
    {
      isDestroyed: () => true,
      onInvalidated: (listener) => {
        listener();
        return () => undefined;
      },
    },
    "workspace-1",
  );

  assert.equal(operation.signal.aborted, true);
  operation.release();
  await registry.cancelAndSettle("workspace-1");
});
