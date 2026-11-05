import assert from "node:assert/strict";
import test from "node:test";
import {
  decideGenerationTerminal,
  runAdmittedGeneration,
  runEveryStep,
  settleGenerationOwnership,
  type GenerationOwnershipEntry,
  type GenerationOwnershipPorts,
  type GenerationTerminalInput,
} from "./generation-settlement.js";

function harness() {
  const held = new Set(["skill", "bot", "artifacts", "owner-listener", "approvals", "questions"]);
  const owners = new Map<string, GenerationOwnershipEntry>();
  const broadcasts: string[] = [];
  const entry: GenerationOwnershipEntry = {
    releaseSkillReservation: () => held.delete("skill"),
    releaseBotAuthority: () => held.delete("bot"),
    removeOwnerInvalidation: () => held.delete("owner-listener"),
  };
  owners.set("stream-1", entry);
  const ports: GenerationOwnershipPorts = {
    forgetApprovedArtifacts: () => held.delete("artifacts"),
    releaseApprovals: () => held.delete("approvals"),
    releaseQuestionnaires: () => held.delete("questions"),
    broadcastSettled: () => {
      broadcasts.push("settled");
    },
  };
  const settle = (overrides: Partial<GenerationOwnershipPorts> = {}) =>
    settleGenerationOwnership("stream-1", entry, owners, { ...ports, ...overrides });
  return { held, owners, broadcasts, entry, settle };
}

test("settling releases everything the run held and announces it once", () => {
  const { held, owners, broadcasts, settle } = harness();
  assert.equal(settle(), true);
  assert.equal(settle(), false);
  assert.deepEqual([...held], []);
  assert.equal(owners.size, 0);
  assert.deepEqual(broadcasts, ["settled"]);
});

test("the chat stops being busy before anyone is told it settled", () => {
  const { owners, settle } = harness();
  let busyAtBroadcast: boolean | undefined;
  settle({
    broadcastSettled: () => {
      busyAtBroadcast = owners.has("stream-1");
    },
  });
  assert.equal(busyAtBroadcast, false);
});

test("a failing step leaves nothing held and still surfaces the first failure", () => {
  const { held, owners, broadcasts, entry, settle } = harness();
  entry.releaseSkillReservation = () => {
    throw new Error("skill release failed");
  };
  assert.throws(
    () => settle({
      releaseApprovals: () => {
        throw new Error("approvals failed");
      },
    }),
    /skill release failed/u,
  );
  assert.deepEqual([...held].sort(), ["approvals", "skill"]);
  assert.equal(owners.size, 0, "A failed step cannot keep the chat busy");
  assert.deepEqual(broadcasts, ["settled"]);
});

test("a late settle from the old run cannot end its replacement on the same stream", () => {
  for (const settledBeforeReplacement of [true, false]) {
    const { owners, settle } = harness();
    if (settledBeforeReplacement) settle();
    const replacement: GenerationOwnershipEntry = {
      releaseSkillReservation: () => {},
      releaseBotAuthority: () => {},
      removeOwnerInvalidation: () => {},
    };
    owners.set("stream-1", replacement);
    settle();
    assert.equal(owners.get("stream-1"), replacement);
  }
});

test("a throw after admission ends the run instead of leaving the chat busy", async () => {
  const { owners, settle } = harness();
  const reported: unknown[] = [];
  await assert.rejects(
    runAdmittedGeneration(
      async () => {
        throw new Error("the accepted callback failed");
      },
      async () => {
        settle();
      },
      (error) => reported.push(error),
    ),
    /the accepted callback failed/u,
  );
  assert.equal(owners.size, 0);
  assert.deepEqual(reported, []);
});

test("a run that settled itself before failing is not settled twice", async () => {
  const { broadcasts, settle } = harness();
  await assert.rejects(
    runAdmittedGeneration(
      async () => {
        settle();
        throw new Error("initialization failed");
      },
      async () => {
        settle();
      },
      () => assert.fail("Nothing failed while settling"),
    ),
    /initialization failed/u,
  );
  assert.deepEqual(broadcasts, ["settled"]);
});

test("a failure while settling is reported and never replaces the run's error", async () => {
  const reported: unknown[] = [];
  await assert.rejects(
    runAdmittedGeneration(
      async () => {
        throw new Error("original");
      },
      async () => {
        throw new Error("settling failed");
      },
      (error) => reported.push(error),
    ),
    /original/u,
  );
  assert.match(String(reported[0]), /settling failed/u);
});

test("a run that starts normally is left to its completion task", async () => {
  assert.equal(
    await runAdmittedGeneration(
      async () => true,
      async () => assert.fail("A started run has an owner"),
      () => {},
    ),
    true,
  );
});

test("every teardown step runs and the first failure surfaces after them", () => {
  const ran: string[] = [];
  assert.throws(
    () => runEveryStep([
      () => ran.push("a"),
      () => {
        ran.push("b");
        throw new Error("first");
      },
      () => {
        ran.push("c");
        throw new Error("second");
      },
      () => ran.push("d"),
    ]),
    /first/u,
  );
  assert.deepEqual(ran, ["a", "b", "c", "d"]);
});

const clean: GenerationTerminalInput = {
  runtime: { kind: "completed" },
  emergencyError: null,
  spendingRefusal: undefined,
  wasCancelled: false,
  hasVisibleOutput: () => true,
};

test("a completed or stopped reply finishes with the matching timeline", () => {
  assert.deepEqual(decideGenerationTerminal(clean), { kind: "finished", timeline: "completed" });
  assert.deepEqual(
    decideGenerationTerminal({ ...clean, runtime: { kind: "app_cancelled" }, wasCancelled: true, hasVisibleOutput: () => false }),
    { kind: "finished", timeline: "cancelled" },
    "A Stop before any output is not an empty response",
  );
});

test("a failure is reported even if visible output cannot be read", () => {
  const decision = decideGenerationTerminal({
    ...clean,
    runtime: { kind: "provider_failed", reason: "output-limit" },
    hasVisibleOutput: () => {
      throw new Error("visible output unavailable");
    },
  });
  assert.equal(decision.kind === "failed" && decision.message, "The model reached its output limit.");
});

test("an empty reply is its own failure only when nobody stopped it", () => {
  assert.deepEqual(decideGenerationTerminal({ ...clean, hasVisibleOutput: () => false }), { kind: "empty" });
});

test("provider failures name their reason, and unknown reasons stay generic", () => {
  const message = (reason?: string) => {
    const decision = decideGenerationTerminal({ ...clean, runtime: { kind: "provider_failed", reason } });
    assert.equal(decision.kind, "failed");
    return decision.kind === "failed" ? decision.message : "";
  };
  assert.match(message("output-limit"), /output limit/u);
  assert.match(message("context-overflow"), /context was too large/u);
  assert.match(message("compaction-failed"), /could not be compacted/u);
  assert.match(message("interrupted"), /interrupted/u);
  assert.match(message("anything-else"), /could not complete this response/u);
  assert.match(message(), /could not complete this response/u);
});

test("a failure beats a Stop that arrived during it", () => {
  const decision = decideGenerationTerminal({ ...clean, runtime: { kind: "host_failed" }, wasCancelled: true });
  assert.equal(decision.kind, "failed");
});

test("the emergency error outranks a spending refusal, which outranks the provider's reason", () => {
  const providerFailed: GenerationTerminalInput = {
    ...clean,
    runtime: { kind: "provider_failed", reason: "output-limit" },
    spendingRefusal: "Spending limit reached.",
  };
  assert.deepEqual(decideGenerationTerminal(providerFailed), {
    kind: "failed",
    message: "Spending limit reached.",
    attachProviderFailure: false,
  });
  const emergency = decideGenerationTerminal({ ...providerFailed, emergencyError: "Too large." });
  assert.equal(emergency.kind === "failed" && emergency.message, "Too large.");
});

test("a stale spending refusal does not fail a reply the provider completed", () => {
  assert.deepEqual(
    decideGenerationTerminal({ ...clean, spendingRefusal: "Spending limit reached." }),
    { kind: "finished", timeline: "completed" },
  );
});
