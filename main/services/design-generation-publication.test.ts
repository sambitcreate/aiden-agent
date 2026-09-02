import assert from "node:assert/strict";
import test from "node:test";
import {
  commitDecidedDesignGeneration,
  decideDesignGenerationPublication,
  settleDecidedDesignGeneration,
  type DesignGenerationPublicationPort,
} from "./design-generation-publication.js";

function harness() {
  const events: string[] = [];
  const revisions: DesignGenerationPublicationPort = {
    async markSuccessfulCandidate() {
      events.push("eligible");
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

for (const terminalStatus of ["failed", "cancelled"] as const) {
  test(`${terminalStatus} Design turns are suppressed before a failing artifact commit`, async () => {
    const { events, revisions } = harness();
    const publish = await decideDesignGenerationPublication({
      chatId: "chat:design",
      mediaIds: ["design:artifact"],
      completed: false,
      revisions,
    });
    events.push("message-durable");
    await assert.rejects(
      commitDecidedDesignGeneration({
        chatId: "chat:design",
        mediaIds: ["design:artifact"],
        publish,
        revisions,
        artifacts: {
          async commit() {
            events.push("commit-failed");
            throw new Error("disk unavailable");
          },
        },
      }),
      /disk unavailable/iu,
    );
    assert.deepEqual(events, ["suppressed", "message-durable", "commit-failed"]);
  });
}

test("completed Design turns cross eligibility, message, commit, and publication in order", async () => {
  const { events, revisions } = harness();
  const publish = await decideDesignGenerationPublication({
    chatId: "chat:design",
    mediaIds: ["design:artifact"],
    completed: true,
    revisions,
  });
  events.push("message-durable");
  await commitDecidedDesignGeneration({
    chatId: "chat:design",
    mediaIds: ["design:artifact"],
    publish,
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
