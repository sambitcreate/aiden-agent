import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDesignGenerationPublicationFailure,
  commitDecidedDesignGeneration,
  decideDesignGenerationPublication,
  keepCancelledDesignDraft,
  settleDecidedDesignGeneration,
  shouldPromptToKeepCancelledDesignDraft,
  type DesignGenerationPublicationPort,
} from "./design-generation-publication.js";

function harness() {
  const events: string[] = [];
  const revisions: DesignGenerationPublicationPort = {
    async markSuccessfulCandidate() {
      events.push("eligible");
    },
    async discardCandidates(_chatId, generationId, mediaIds) {
      events.push(`discarded:${generationId}:${mediaIds.join(",")}`);
    },
    async suppressCandidates() {
      events.push("suppressed");
    },
    async publishEligible() {
      events.push("published");
    },
  };
  return { events, revisions };
}

test("failed or discarded Design output is exact-deleted without committing", async () => {
  const { events, revisions } = harness();
  const decision = await decideDesignGenerationPublication({
    chatId: "chat:design",
    generationId: "generation:failed",
    mediaIds: ["design:artifact"],
    completed: false,
    revisions,
  });
  events.push("message-durable");
  await commitDecidedDesignGeneration({
    chatId: "chat:design",
    mediaIds: ["design:artifact"],
    publish: decision.publish,
    revisions,
    artifacts: {
      async commit() {
        events.push("committed");
      },
    },
  });
  assert.deepEqual(decision, { publish: false, cleanupPending: false });
  assert.deepEqual(events, ["discarded:generation:failed:design:artifact", "message-durable"]);
});

test("a persistent failed-turn cleanup error stays non-publishable after one retry", async () => {
  let discards = 0;
  const { revisions } = harness();
  revisions.discardCandidates = async () => {
    discards += 1;
    throw new Error("artifact store unavailable");
  };
  const decision = await decideDesignGenerationPublication({
    chatId: "chat:design",
    generationId: "generation:failed",
    mediaIds: ["design:artifact"],
    completed: false,
    revisions,
  });
  assert.equal(decision.publish, false);
  assert.equal(decision.cleanupPending, true);
  assert.equal(discards, 2);
  if (decision.cleanupPending) assert.match(String(decision.cause), /artifact store unavailable/u);
});

test("only an explicit Keep draft questionnaire answer preserves cancelled output", () => {
  assert.equal(
    keepCancelledDesignDraft({
      cancelled: false,
      answers: [{ questionIndex: 0, kind: "option", answer: "Keep draft" }],
    }),
    true,
  );
  for (const response of [
    { cancelled: false, answers: [{ questionIndex: 0, kind: "option", answer: "Discard" }] },
    { cancelled: true, answers: [] },
    { cancelled: false, answers: [] },
  ]) {
    assert.equal(keepCancelledDesignDraft(response), false);
  }
});

test("an explicitly kept cancelled draft crosses the successful publication barrier", async () => {
  const { events, revisions } = harness();
  const keep = keepCancelledDesignDraft({
    cancelled: false,
    answers: [{ questionIndex: 0, kind: "option", answer: "Keep draft" }],
  });
  const decision = await decideDesignGenerationPublication({
    chatId: "chat:design",
    generationId: "generation:cancelled",
    mediaIds: ["design:artifact"],
    completed: keep,
    revisions,
  });
  assert.deepEqual(decision, { publish: true, cleanupPending: false });
  assert.deepEqual(events, ["eligible"]);
});

test("only explicit user-stop cancellation with Design artifacts prompts for a draft decision", () => {
  const base = {
    design: true,
    interactiveOwner: true,
    artifactCount: 1,
    status: "cancelled",
    cancellationOrigin: "user_stop",
  };
  assert.equal(shouldPromptToKeepCancelledDesignDraft(base), true);
  assert.equal(
    shouldPromptToKeepCancelledDesignDraft({ ...base, cancellationOrigin: "application_shutdown" }),
    false,
  );
  assert.equal(shouldPromptToKeepCancelledDesignDraft({ ...base, status: "failed" }), false);
  assert.equal(shouldPromptToKeepCancelledDesignDraft({ ...base, design: false }), false);
  assert.equal(
    shouldPromptToKeepCancelledDesignDraft({ ...base, interactiveOwner: false }),
    false,
  );
  assert.equal(shouldPromptToKeepCancelledDesignDraft({ ...base, artifactCount: 0 }), false);
});

test("publication failures distinguish durable retry eligibility from terminal suppression", () => {
  assert.equal(
    classifyDesignGenerationPublicationFailure(["a", "b"], ["b", "a"]),
    "retryable",
  );
  assert.equal(
    classifyDesignGenerationPublicationFailure(["a", "b"], ["a"]),
    "suppressed",
  );
  assert.equal(
    classifyDesignGenerationPublicationFailure(["a", "a"], ["a"]),
    "suppressed",
  );
});
test("completed Design turns cross eligibility, message, commit, and publication in order", async () => {
  const { events, revisions } = harness();
  const decision = await decideDesignGenerationPublication({
    chatId: "chat:design",
    generationId: "generation:completed",
    mediaIds: ["design:artifact"],
    completed: true,
    revisions,
  });
  events.push("message-durable");
  await commitDecidedDesignGeneration({
    chatId: "chat:design",
    mediaIds: ["design:artifact"],
    publish: decision.publish,
    revisions,
    artifacts: {
      async commit() {
        events.push("committed");
      },
    },
  });
  assert.deepEqual(events, ["eligible", "message-durable", "committed", "published"]);
});

test("completed Design publication retries once and reports a persistent project-store failure", async () => {
  let commits = 0;
  let publications = 0;
  const result = await settleDecidedDesignGeneration({
    chatId: "chat:design",
    mediaIds: ["design:artifact"],
    publish: true,
    artifacts: {
      async commit() {
        commits += 1;
      },
    },
    revisions: {
      async markSuccessfulCandidate() {},
      async discardCandidates() {},
      async suppressCandidates() {},
      async publishEligible() {
        publications += 1;
        throw new Error("project store unavailable");
      },
    },
  });
  assert.equal(result.pending, true);
  assert.equal(commits, 2);
  assert.equal(publications, 2);
  if (result.pending) assert.match(String(result.cause), /project store unavailable/u);
});

test("completed Design publication recovers from one ambiguous project-store response", async () => {
  let publications = 0;
  const result = await settleDecidedDesignGeneration({
    chatId: "chat:design",
    mediaIds: ["design:artifact"],
    publish: true,
    artifacts: { async commit() {} },
    revisions: {
      async markSuccessfulCandidate() {},
      async discardCandidates() {},
      async suppressCandidates() {},
      async publishEligible() {
        publications += 1;
        if (publications === 1) throw new Error("response lost");
      },
    },
  });
  assert.deepEqual(result, { pending: false });
  assert.equal(publications, 2);
});
