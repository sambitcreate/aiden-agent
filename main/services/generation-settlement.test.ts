import assert from "node:assert/strict";
import test from "node:test";
import {
  decideGenerationTerminal,
  runAdmittedGeneration,
  settleGenerationOwnership,
  type GenerationOwnershipEntry,
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
  const ports = {
    forgetApprovedArtifacts: () => held.delete("artifacts"),
    removeOwnerEntry: () => owners.delete("stream-1"),
    releaseApprovals: () => held.delete("approvals"),
    releaseQuestionnaires: () => held.delete("questions"),
    broadcastSettled: () => broadcasts.push("settled"),
  };
  return { held, owners, broadcasts, entry, ports };
}

test("settling releases everything the run held and announces it once", () => {
  const { held, owners, broadcasts, entry, ports } = harness();
  assert.equal(settleGenerationOwnership(entry, ports), true);
  assert.equal(settleGenerationOwnership(entry, ports), false);
  assert.deepEqual([...held], []);
  assert.equal(owners.size, 0);
  assert.deepEqual(broadcasts, ["settled"]);
});

test("the chat stops being busy before anyone is told it settled", () => {
  const { owners, entry, ports } = harness();
  let busyAtBroadcast: boolean | undefined;
  settleGenerationOwnership(entry, {
    ...ports,
    broadcastSettled: () => {
      busyAtBroadcast = owners.has("stream-1");
    },
  });
  assert.equal(busyAtBroadcast, false);
});

test("a failing step leaves nothing held and still surfaces the first failure", () => {
  const { held, owners, broadcasts, entry, ports } = harness();
  entry.releaseSkillReservation = () => {
    throw new Error("skill release failed");
  };
  assert.throws(
    () => settleGenerationOwnership(entry, {
      ...ports,
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
  const { owners, entry, ports } = harness();
  settleGenerationOwnership(entry, ports);
  const replacement: GenerationOwnershipEntry = {
    releaseSkillReservation: () => {},
    releaseBotAuthority: () => {},
    removeOwnerInvalidation: () => {},
  };
  owners.set("stream-1", replacement);
  settleGenerationOwnership(entry, ports);
  assert.equal(owners.get("stream-1"), replacement);
});

test("a throw after admission ends the run instead of leaving the chat busy", async () => {
  const { owners, entry, ports } = harness();
  const reported: unknown[] = [];
  await assert.rejects(
    runAdmittedGeneration(
      async () => {
        throw new Error("the accepted callback failed");
      },
      async () => {
        settleGenerationOwnership(entry, ports);
      },
      (error) => reported.push(error),
    ),
    /the accepted callback failed/u,
  );
  assert.equal(owners.size, 0);
  assert.deepEqual(reported, []);
});

test("a run that settled itself before failing is not settled twice", async () => {
  const { broadcasts, entry, ports } = harness();
  await assert.rejects(
    runAdmittedGeneration(
      async () => {
        settleGenerationOwnership(entry, ports);
        throw new Error("initialization failed");
      },
      async () => {
        settleGenerationOwnership(entry, ports);
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

const clean: GenerationTerminalInput = {
  runtime: { kind: "completed" },
  emergencyError: null,
  spendingRefusal: undefined,
  wasCancelled: false,
  hasVisibleOutput: true,
};

test("a completed or stopped reply finishes with the matching timeline", () => {
  assert.deepEqual(decideGenerationTerminal(clean), { kind: "finished", timeline: "completed" });
  assert.deepEqual(
    decideGenerationTerminal({ ...clean, runtime: { kind: "app_cancelled" }, wasCancelled: true, hasVisibleOutput: false }),
    { kind: "finished", timeline: "cancelled" },
    "A Stop before any output is not an empty response",
  );
});

test("an empty reply is its own failure only when nobody stopped it", () => {
  assert.deepEqual(decideGenerationTerminal({ ...clean, hasVisibleOutput: false }), { kind: "empty" });
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
