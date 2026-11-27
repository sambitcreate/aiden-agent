import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useTerminalCloseRequest } from "./terminal-close-request";

afterEach(cleanup);

function harness(initialIds: readonly string[] = ["t1", "t2"]) {
  const checks: Array<{ id: string; resolve: (command: string | null) => void; reject: (error: Error) => void }> = [];
  const closed: string[] = [];
  const foregroundCommand = (id: string) =>
    new Promise<string | null>((resolve, reject) => {
      checks.push({ id, resolve, reject });
    });
  const close = (id: string) => {
    closed.push(id);
  };
  const hook = renderHook(
    ({ sessionIds }: { sessionIds: readonly string[] }) => useTerminalCloseRequest({ sessionIds, foregroundCommand, close }),
    { initialProps: { sessionIds: initialIds } },
  );
  const answer = async (index: number, command: string | null) => {
    await act(async () => {
      checks[index]!.resolve(command);
    });
  };
  const request = async (id: string) => {
    await act(async () => {
      void hook.result.current.requestClose(id, id === "t1" ? "Terminal 1" : "Terminal 2");
    });
  };
  return { hook, checks, closed, answer, request };
}

test("closing an idle terminal closes it, and a busy one asks first", async () => {
  const { hook, checks, closed, answer, request } = harness();
  await request("t1");
  await answer(0, null);
  assert.deepEqual(closed, ["t1"]);

  await request("t2");
  await answer(1, "sleep");
  assert.deepEqual(hook.result.current.pending, { id: "t2", label: "Terminal 2", command: "sleep" });
  assert.deepEqual(closed, ["t1"]);
  act(() => hook.result.current.confirm());
  assert.deepEqual(closed, ["t1", "t2"]);
  assert.equal(hook.result.current.pending, null);
  assert.equal(checks.length, 2);
});

test("a second click while the first check runs, or while its question is open, does nothing", async () => {
  const { hook, checks, closed, answer, request } = harness();
  await request("t1");
  await request("t1");
  assert.equal(checks.length, 1);

  await answer(0, "zsh");
  assert.equal(hook.result.current.pending?.id, "t1");
  // Another click on the same tab must neither close it under the question nor ask again.
  await request("t1");
  assert.equal(checks.length, 1);
  assert.deepEqual(closed, []);

  act(() => hook.result.current.dismiss());
  assert.equal(hook.result.current.pending, null);
  await request("t1");
  assert.equal(checks.length, 2);
});

test("a slow check for one terminal never takes over the question about another", async () => {
  const { hook, closed, answer, request } = harness();
  await request("t1");
  await request("t2");
  await answer(1, "sleep");
  assert.equal(hook.result.current.pending?.id, "t2");

  // Terminal 1's answer arrives late: it was superseded and changes nothing.
  await answer(0, "zsh");
  assert.equal(hook.result.current.pending?.id, "t2");
  act(() => hook.result.current.confirm());
  assert.deepEqual(closed, ["t2"]);
});

test("a superseded check that finds nothing running does not close its terminal", async () => {
  const { hook, closed, answer, request } = harness();
  await request("t1");
  await request("t2");
  await answer(1, "sleep");
  await answer(0, null);
  assert.deepEqual(closed, []);
  assert.equal(hook.result.current.pending?.id, "t2");
});

test("a check that finishes after its terminal ended is ignored", async () => {
  const { hook, checks, closed, answer, request } = harness();
  await request("t1");
  hook.rerender({ sessionIds: ["t2"] });
  await answer(0, "zsh");
  assert.equal(hook.result.current.pending, null);

  await request("t2");
  hook.rerender({ sessionIds: [] });
  await answer(1, null);
  assert.deepEqual(closed, []);
  assert.equal(checks.length, 2);
});

test("a failed check closes the terminal, as there is no program to protect", async () => {
  const { checks, closed, request } = harness();
  await request("t1");
  await act(async () => {
    checks[0]!.reject(new Error("Terminal session is unavailable."));
  });
  assert.deepEqual(closed, ["t1"]);
});

test("a check still running when the drawer goes away closes nothing and asks nothing", async () => {
  const { hook, checks, closed, request } = harness();
  await request("t1");
  await request("t2");
  hook.unmount();
  await act(async () => {
    checks[0]!.resolve(null);
    checks[1]!.reject(new Error("Terminal session is unavailable."));
  });
  assert.deepEqual(closed, []);
});

test("clicking a tab again after a newer click superseded its check starts a fresh check", async () => {
  const { hook, checks, closed, answer, request } = harness();
  await request("t1");
  await request("t2");
  await answer(1, null);
  assert.deepEqual(closed, ["t2"]);
  hook.rerender({ sessionIds: ["t1"] });

  // Terminal 1's first check is still out but can no longer count; this click must.
  await request("t1");
  assert.equal(checks.length, 3);
  await answer(0, null);
  assert.deepEqual(closed, ["t2"]);
  await answer(2, "sleep");
  assert.deepEqual(hook.result.current.pending, { id: "t1", label: "Terminal 1", command: "sleep" });
});
