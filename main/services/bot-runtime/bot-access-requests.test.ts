import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotAccessRequests, type BotAccessRequestPrompt } from "./bot-access-requests.js";
import { createBotAccessAuthorizer } from "./bot-access-authorization.js";
import { createBotRunAccess } from "./bot-run-access.js";

const prompt: Omit<BotAccessRequestPrompt, "waitId"> = {
  botId: "ada",
  toolCallId: "call",
  logicalRequestId: "logical-1",
  target: "folder",
  label: "Taxes",
  place: "~/Taxes",
  why: "Prepare a return",
  choices: ["not_now", "always", "once"],
  grant: { folderPath: "/Taxes" },
  authorization: {
    policyRevision: "rev1",
    requestIds: ["r1"],
    target: "folder",
    root: "/Taxes",
    identity: { device: "1", inode: "2" },
    choices: ["not_now", "always", "once"],
  },
};
test("first answer claims the attempt, immutable authorization runs before settlement and public cards hide it", async () => {
  const bridge = createBotAccessRequests();
  bridge.onChange(() => {
    throw new Error("listener failure");
  });
  const waiting = bridge.request({ ...prompt, signal: undefined });
  const card = bridge.pending("ada")[0]!;
  assert.deepEqual(
    Object.keys(card).sort(),
    ["botId", "choices", "label", "place", "target", "toolCallId", "waitId", "why"].sort(),
  );
  let release!: () => void,
    started = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = bridge.answer("ada", card.waitId, "always", async (captured) => {
    started = true;
    assert.equal(captured.authorization.policyRevision, "rev1");
    await gate;
  });
  assert.equal(started, true);
  assert.equal(
    await bridge.answer("ada", card.waitId, "once", async () => {
      throw new Error("must not authorize twice");
    }),
    "not_waiting",
  );
  release();
  assert.equal(await answer, "answered");
  assert.deepEqual(await waiting, { choice: "always", waitId: card.waitId });
  assert.equal(await bridge.answer("ada", card.waitId, "always", async () => {}), "not_waiting");
});
test("unoffered answers and failing authorization keep the card available", async () => {
  const bridge = createBotAccessRequests();
  const waiting = bridge.request({
    ...prompt,
    choices: ["not_now", "once"],
    authorization: { ...prompt.authorization, choices: ["not_now", "once"] },
    grant: undefined,
    signal: undefined,
  });
  const id = bridge.pending()[0]!.waitId;
  assert.equal(
    await bridge.answer("ada", id, "always", async () => {
      throw new Error("must not run");
    }),
    "invalid",
  );
  await assert.rejects(
    bridge.answer("ada", id, "once", async () => {
      throw new Error("policy stale");
    }),
    /policy stale/u,
  );
  assert.equal(bridge.pending()[0]!.waitId, id);
  assert.equal(await bridge.answer("ada", id, "not_now", async () => {}), "answered");
  await waiting;
});
test("live retries reuse an attempt, abort preserves its reason, and reapproval always has a fresh id", async () => {
  const bridge = createBotAccessRequests();
  const controller = new AbortController();
  const first = bridge.request({ ...prompt, signal: controller.signal });
  const retry = bridge.request({ ...prompt, signal: controller.signal });
  const oldId = bridge.pending()[0]!.waitId;
  assert.equal(bridge.pending().length, 1);
  const error = new Error("quit");
  controller.abort(error);
  await assert.rejects(first, (reason) => reason === error);
  await assert.rejects(retry, (reason) => reason === error);
  const restarted = bridge.request({ ...prompt, signal: undefined });
  const newId = bridge.pending()[0]!.waitId;
  assert.notEqual(oldId, newId);
  assert.equal(await bridge.answer("ada", oldId, "once", async () => {}), "not_waiting");
  await bridge.answer("ada", newId, "once", async () => {});
  await restarted;
  const again = bridge.request({ ...prompt, signal: undefined });
  assert.notEqual(bridge.pending()[0]!.waitId, newId);
  await bridge.answer("ada", bridge.pending()[0]!.waitId, "not_now", async () => {});
  await again;
});
test("changed authorization withdraws an old attempt and caller mutation cannot alter its captured snapshot", async () => {
  const bridge = createBotAccessRequests();
  const mutable = structuredClone(prompt);
  const old = bridge.request({ ...mutable, signal: undefined });
  const refused = assert.rejects(old, /changed|asked again/u);
  const oldId = bridge.pending()[0]!.waitId;
  mutable.authorization.policyRevision = "rev2";
  const fresh = bridge.request({ ...mutable, signal: undefined });
  const id = bridge.pending()[0]!.waitId;
  assert.notEqual(oldId, id);
  await refused;
  mutable.authorization.policyRevision = "rev3";
  await bridge.answer("ada", id, "once", async (snapshot) => {
    assert.equal(snapshot.authorization.policyRevision, "rev2");
    assert.throws(() => {
      snapshot.authorization.policyRevision = "tampered";
    });
  });
  await fresh;
});

test("once and Always revalidate immutable policy, inode and owner before issuing their one run grant", async () => {
  for (const choice of ["once", "always"] as const)
    for (const race of [
      "none",
      "policy",
      "inode",
      "late-inode",
      "expired",
      "abort",
      "publish-race",
    ] as const) {
      let revision = "rev1",
        now = 1,
        inode = "2",
        changes = 0,
        saves = 0;
      let revalidations = 0;
      const controller = new AbortController(),
        store = createBotRunAccess({ now: () => now });
      const card: BotAccessRequestPrompt = {
        ...structuredClone(prompt),
        waitId: "attempt-1",
        owner: { signal: controller.signal, deadline: 100, validate: async () => {} },
      };
      const authorize = createBotAccessAuthorizer({
        now: () => now,
        audienceId: "desktop",
        runAccess: store,
        revalidate: async (_id, expected) => {
          if (revision !== expected) throw new Error("policy changed");
          if (++revalidations === 2 && race === "late-inode") inode = "3";
        },
        resolveTarget: async () => ({
          kind: "folder",
          root: "/Taxes",
          label: "Taxes",
          place: "/Taxes",
          device: "1",
          inode,
          always: { kind: "new" },
        }),
        grantFolder: async (input, owner) => {
          assert.equal(input.operationId, "attempt-1");
          assert.equal(input.expectedRevision, "rev1");
          owner.assertCurrent();
          saves++;
          revision = race === "publish-race" ? "rev3" : "rev2";
          return "rev2";
        },
        changed: () => {
          changes++;
        },
      });
      if (race === "policy") revision = "changed";
      if (race === "inode") inode = "3";
      if (race === "expired") now = 100;
      if (race === "abort") controller.abort(new Error("stop"));
      const fails =
        !["none", "publish-race"].includes(race) ||
        (choice === "always" && race === "publish-race");
      if (fails) {
        await assert.rejects(authorize(card, choice), /changed|active/u);
        assert.equal(store.location("ada", ["r1"], revision), undefined);
        assert.equal(changes, 0);
        assert.equal(
          saves,
          choice === "always" && (race === "publish-race" || race === "late-inode") ? 1 : 0,
        );
      } else {
        await authorize(card, choice);
        assert.equal(store.location("ada", ["r1"], revision)?.root, "/Taxes");
        assert.equal(changes, 1);
        assert.equal(saves, choice === "always" ? 1 : 0);
        now = 100;
        assert.equal(
          store.location("ada", ["r1"], revision),
          undefined,
          "owner deadline bounds a grant before 60 minutes",
        );
      }
    }
});
test("abort during asynchronous authorization cannot issue a late run grant", async () => {
  const bridge = createBotAccessRequests(),
    controller = new AbortController();
  const store = createBotRunAccess({ now: () => 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = bridge.request({
    ...prompt,
    owner: { signal: controller.signal, deadline: Date.now() + 60_000, validate: async () => {} },
    signal: controller.signal,
  });
  const rejected = assert.rejects(waiting, /stop/u);
  const id = bridge.pending()[0]!.waitId;
  const answer = bridge.answer(
    "ada",
    id,
    "once",
    createBotAccessAuthorizer({
      now: () => 1,
      audienceId: "desktop",
      runAccess: store,
      revalidate: async () => {},
      resolveTarget: async () => {
        await gate;
        return {
          kind: "folder",
          root: "/Taxes",
          label: "Taxes",
          place: "/Taxes",
          device: "1",
          inode: "2",
          always: { kind: "new" },
        };
      },
      grantFolder: async () => {
        throw new Error("not called");
      },
      changed() {},
    }),
  );
  controller.abort(new Error("stop"));
  release();
  await assert.rejects(answer, /active/u);
  await rejected;
  assert.equal(store.location("ada", ["r1"], "rev1"), undefined);
  assert.deepEqual(bridge.pending(), []);
});
