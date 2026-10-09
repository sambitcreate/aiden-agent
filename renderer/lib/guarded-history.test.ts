import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryHistory } from "@tanstack/react-router";
import { guardHistoryTraversal } from "./guarded-history.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function visited(...paths: string[]) {
  const history = guardHistoryTraversal(createMemoryHistory({ initialEntries: ["/"] }));
  for (const path of paths) history.push(path);
  return history;
}

test("a blocker can stop Back and sees the entry it would lead to", async () => {
  const history = visited("/chat/a", "/images/workflow");
  const seen: string[] = [];
  history.block({
    blockerFn: ({ currentLocation, nextLocation, action }) => {
      seen.push(`${action} ${currentLocation.pathname} -> ${nextLocation.pathname}`);
      return true;
    },
  });
  history.back();
  await settle();
  assert.equal(history.location.pathname, "/images/workflow");
  assert.deepEqual(seen, ["BACK /images/workflow -> /chat/a"]);
});

test("traversal proceeds once every blocker allows it, and a released blocker no longer runs", async () => {
  const history = visited("/a", "/b");
  let blocked = true;
  const release = history.block({ blockerFn: () => blocked });
  history.back();
  await settle();
  assert.equal(history.location.pathname, "/b");

  blocked = false;
  history.back();
  await settle();
  assert.equal(history.location.pathname, "/a");

  release();
  history.block({ blockerFn: () => false });
  history.forward();
  await settle();
  assert.equal(history.location.pathname, "/b");
});

test("Forward targets reflect a new push that discarded the old forward entries", async () => {
  const history = visited("/a", "/b");
  history.back();
  await settle();
  history.push("/c");
  history.back();
  await settle();
  const targets: string[] = [];
  history.block({
    blockerFn: ({ nextLocation }) => {
      targets.push(nextLocation.pathname);
      return false;
    },
  });
  history.forward();
  await settle();
  assert.deepEqual(targets, ["/c"]);
  assert.equal(history.location.pathname, "/c");
});

test("a navigation that lands while a blocker is deciding wins over the stale traversal", async () => {
  const history = visited("/a", "/b");
  let decide!: (block: boolean) => void;
  history.block({ blockerFn: () => new Promise<boolean>((resolve) => (decide = resolve)) });
  history.back();
  await settle();
  history.replace("/elsewhere");
  decide(false);
  await settle();
  assert.equal(history.location.pathname, "/elsewhere");
});
