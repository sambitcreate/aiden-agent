import assert from "node:assert/strict";
import test from "node:test";
import { commitSubagentFileMutation } from "./subagent-file-mutation-transaction.js";
import { SubagentFileMutatorError } from "./subagent-file-mutator-io.js";

type Step = "ok" | "conflict" | "indeterminate";

/** A helper whose commit, finalize and preserve answer as scripted, with the client states the real one reports. */
function helper(script: { commit: Step; finalize?: Step; preserve?: Step; recovery?: boolean }) {
  const calls: string[] = [];
  const client = {
    currentState: "prepared" as string,
    async commit() {
      calls.push("commit");
      if (script.commit === "conflict") {
        client.currentState = "closed";
        throw new SubagentFileMutatorError("conflict");
      }
      if (script.commit === "indeterminate") {
        client.currentState = "indeterminate";
        throw new SubagentFileMutatorError("indeterminate");
      }
      client.currentState = "committed";
      return script.recovery === false ? {} : { recoveryName: ".aiden-subagent-file-effect-recovery" };
    },
    async finalize() {
      calls.push("finalize");
      if ((script.finalize ?? "ok") !== "ok") throw new SubagentFileMutatorError("indeterminate");
    },
    async preserve() {
      calls.push("preserve");
      if ((script.preserve ?? "ok") !== "ok") throw new SubagentFileMutatorError("indeterminate");
    },
  };
  return { client: client as unknown as Parameters<typeof commitSubagentFileMutation>[0], calls };
}

const run = (script: Parameters<typeof helper>[0]) => {
  const { client, calls } = helper(script);
  return commitSubagentFileMutation(client, "effect", new AbortController().signal).then((outcome) => ({
    kind: outcome.kind,
    calls,
  }));
};

test("a clean commit removes its recovery file and reports success", async () => {
  assert.deepEqual(await run({ commit: "ok" }), { kind: "committed", calls: ["commit", "finalize"] });
});

test("creating a new file has no recovery file to finalize", async () => {
  assert.deepEqual(await run({ commit: "ok", recovery: false }), { kind: "committed", calls: ["commit"] });
});

test("a refusal before publishing touches nothing further", async () => {
  assert.deepEqual(await run({ commit: "conflict" }), { kind: "not_committed", calls: ["commit"] });
});

test("an unknown commit keeps recovery evidence and never reads as a clean failure", async () => {
  assert.deepEqual(await run({ commit: "indeterminate" }), { kind: "unknown", calls: ["commit", "preserve"] });
  assert.deepEqual(await run({ commit: "indeterminate", preserve: "indeterminate" }), {
    kind: "unknown",
    calls: ["commit", "preserve"],
  });
});

test("a cleanup failure after publishing is still a committed write", async () => {
  assert.deepEqual(await run({ commit: "ok", finalize: "indeterminate" }), {
    kind: "recovery_kept",
    calls: ["commit", "finalize", "preserve"],
  });
  assert.deepEqual(await run({ commit: "ok", finalize: "indeterminate", preserve: "indeterminate" }), {
    kind: "cleanup_unknown",
    calls: ["commit", "finalize", "preserve"],
  });
});
