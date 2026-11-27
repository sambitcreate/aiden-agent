import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolStep } from "./generation-timeline.js";
import {
  accumulateSubagentTranscriptUpdate,
  foldLiveSubagentTranscript,
  MAX_LIVE_SUBAGENT_TRANSCRIPTS,
  MAX_SUBAGENT_TRANSCRIPT_BYTES,
  MAX_SUBAGENT_TRANSCRIPT_TEXT_CHARS,
  mergeSubagentTranscript,
  parseSubagentHistoryDetailWithTranscript,
  parseSubagentTranscript,
  parseSubagentTranscriptNotification,
  parseSubagentTranscriptUpdate,
  subagentTranscriptBytes,
  trimSubagentTranscriptToBytes,
  type SubagentTranscriptEntry,
  type SubagentTranscriptUpdateV1,
  type SubagentTranscriptV1,
} from "./subagent-transcript.js";

function toolStep(order: number, overrides: Partial<AgentToolStep> = {}): AgentToolStep {
  return {
    id: `tool-${order + 1}`,
    order,
    kind: "tool",
    toolCallId: `call-${order + 1}`,
    toolName: "read_file",
    label: "Read file",
    status: "completed",
    startedAt: 1_000 + order,
    updatedAt: 1_001 + order,
    finishedAt: 1_001 + order,
    contentOffset: 0,
    ...overrides,
  };
}

function message(text: string, steps: AgentToolStep[] = [], finished = true): SubagentTranscriptEntry {
  return {
    kind: "message",
    text,
    steps,
    startedAt: 1_000,
    ...(finished ? { finishedAt: 2_000 } : {}),
  };
}

function transcript(entries: SubagentTranscriptEntry[], revision = 1, runId = "run-1"): SubagentTranscriptV1 {
  return {
    version: 1,
    runId,
    revision,
    trimmed: false,
    entries: [{ kind: "task", text: "Find where the setting is read." }, ...entries],
  };
}

function update(
  baseRevision: number,
  revision: number,
  entryCount: number,
  changes: SubagentTranscriptUpdateV1["changes"],
  runId = "run-1",
): SubagentTranscriptUpdateV1 {
  return { version: 1, runId, baseRevision, revision, trimmed: false, entryCount, changes };
}

test("a saved helper conversation survives a JSON round trip through the strict parser", () => {
  const saved = transcript([
    message("I will look at the config loader.", [toolStep(0), toolStep(1, { status: "failed" })]),
    message("The setting is read in src/config.ts."),
  ]);
  const parsed = parseSubagentTranscript(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(parsed, saved);
});

test("the parser rejects malformed helper conversations", () => {
  const valid = transcript([message("Done.", [toolStep(0)])]);
  const variants: Array<[string, unknown]> = [
    ["not an object", "transcript"],
    ["an unknown version", { ...valid, version: 2 }],
    ["an unsafe run id", { ...valid, runId: "../run-1" }],
    ["revision zero", { ...valid, revision: 0 }],
    ["a fractional revision", { ...valid, revision: 1.5 }],
    ["an extra top-level key", { ...valid, extra: true }],
    ["a non-boolean trimmed flag", { ...valid, trimmed: "no" }],
    ["no entries", { ...valid, entries: [] }],
    ["a message where the task belongs", { ...valid, entries: [message("hi")] }],
    ["a second task", { ...valid, entries: [valid.entries[0], { kind: "task", text: "again" }] }],
    ["a message with an extra key", { ...valid, entries: [valid.entries[0], { ...message("x"), html: "<b>" }] }],
    [
      "a message that finished before it started",
      { ...valid, entries: [valid.entries[0], { ...message("x"), startedAt: 5_000, finishedAt: 4_000 }] },
    ],
    [
      "oversized text",
      { ...valid, entries: [valid.entries[0], message("x".repeat(MAX_SUBAGENT_TRANSCRIPT_TEXT_CHARS + 1))] },
    ],
    [
      "a step with an absolute target",
      { ...valid, entries: [valid.entries[0], message("x", [toolStep(0, { target: "/etc/passwd" })])] },
    ],
    [
      "a step with an unknown field",
      { ...valid, entries: [valid.entries[0], message("x", [{ ...toolStep(0), command: "rm -rf /" } as AgentToolStep])] },
    ],
    [
      "steps out of order",
      { ...valid, entries: [valid.entries[0], message("x", [toolStep(1)])] },
    ],
  ];
  for (const [name, value] of variants) {
    assert.equal(parseSubagentTranscript(value), undefined, name);
  }
});

test("live updates and stream notifications are parsed strictly", () => {
  const good = update(1, 2, 2, [{ index: 1, entry: message("Working.", [], false) }]);
  assert.deepEqual(parseSubagentTranscriptUpdate(JSON.parse(JSON.stringify(good))), good);
  assert.deepEqual(parseSubagentTranscriptNotification({ streamId: "gen-1", update: good }), {
    streamId: "gen-1",
    update: good,
  });
  assert.equal(parseSubagentTranscriptUpdate({ ...good, revision: 1 }), undefined, "revision must advance");
  assert.equal(
    parseSubagentTranscriptUpdate({ ...good, changes: [{ index: 2, entry: message("x") }] }),
    undefined,
    "a change past the entry count",
  );
  assert.equal(
    parseSubagentTranscriptUpdate({
      ...good,
      entryCount: 3,
      changes: [
        { index: 2, entry: message("b") },
        { index: 1, entry: message("a") },
      ],
    }),
    undefined,
    "changes out of order",
  );
  assert.equal(
    parseSubagentTranscriptUpdate({ ...good, changes: [{ index: 0, entry: message("x") }] }),
    undefined,
    "index 0 must be the task",
  );
  assert.equal(parseSubagentTranscriptNotification({ streamId: "", update: good }), undefined);
  assert.equal(parseSubagentTranscriptNotification({ streamId: "gen-1", update: good, extra: 1 }), undefined);
});

test("a reader that joins mid-run converges on the saved copy plus later live updates", () => {
  // The recorder's revisions, in full, as it saved them.
  const r1 = transcript([], 1);
  const r2 = transcript([message("Looking", [], false)], 2);
  const r3 = transcript([message("Looking at the loader.", [toolStep(0, { status: "running", finishedAt: undefined })], false)], 3);
  delete (r3.entries[1] as { steps: AgentToolStep[] }).steps[0]!.finishedAt;
  const r4 = transcript([message("Looking at the loader.", [toolStep(0)]), message("It is read in src/config.ts.")], 4);

  const live: SubagentTranscriptUpdateV1[] = [
    update(0, 1, 1, [{ index: 0, entry: r1.entries[0]! }]),
    update(1, 2, 2, [{ index: 1, entry: r2.entries[1]! }]),
    update(2, 3, 2, [{ index: 1, entry: r3.entries[1]! }]),
    update(3, 4, 3, [
      { index: 1, entry: r4.entries[1]! },
      { index: 2, entry: r4.entries[2]! },
    ]),
  ];

  // A reader that saw every update from the start rebuilds the final copy alone.
  let fromStart: SubagentTranscriptUpdateV1 | undefined;
  for (const next of live) fromStart = accumulateSubagentTranscriptUpdate(fromStart, next);
  assert.deepEqual(mergeSubagentTranscript(null, fromStart), { transcript: r4, complete: true });

  // A reader that subscribed after revision 2 and then read the saved copy
  // (which may already be at revision 3) still meets the stream.
  let joined: SubagentTranscriptUpdateV1 | undefined;
  for (const next of live.slice(2)) joined = accumulateSubagentTranscriptUpdate(joined, next);
  assert.deepEqual(mergeSubagentTranscript(r2, joined), { transcript: r4, complete: true });
  assert.deepEqual(mergeSubagentTranscript(r3, joined), { transcript: r4, complete: true });

  // A saved copy newer than anything streamed wins.
  assert.deepEqual(mergeSubagentTranscript(r4, live[2]), { transcript: r4, complete: true });

  // Repeated or stale updates change nothing.
  assert.equal(accumulateSubagentTranscriptUpdate(joined, live[2]!), joined);
});

test("a gap between the saved copy and the live stream is reported, not papered over", () => {
  const r1 = transcript([], 1);
  const afterGap = update(3, 4, 3, [{ index: 2, entry: message("Second message.") }]);
  const merged = mergeSubagentTranscript(r1, afterGap);
  assert.equal(merged.complete, false);
  assert.deepEqual(merged.transcript, r1);
  // Another run's updates never touch this transcript.
  const other = update(1, 2, 2, [{ index: 1, entry: message("Other.") }], "run-2");
  assert.deepEqual(mergeSubagentTranscript(r1, other), { transcript: r1, complete: true });
});

test("a window keeps live state for its newest helpers only", () => {
  let live = foldLiveSubagentTranscript(undefined, update(0, 1, 1, [{ index: 0, entry: transcript([]).entries[0]! }], "run-0"));
  for (let index = 1; index <= MAX_LIVE_SUBAGENT_TRANSCRIPTS; index += 1) {
    live = foldLiveSubagentTranscript(
      live,
      update(0, 1, 1, [{ index: 0, entry: transcript([]).entries[0]! }], `run-${index}`),
    );
  }
  assert.equal(live.size, MAX_LIVE_SUBAGENT_TRANSCRIPTS);
  assert.equal(live.has("run-0"), false);
  assert.equal(live.has(`run-${MAX_LIVE_SUBAGENT_TRANSCRIPTS}`), true);
  // A stale update hands back the same state.
  const before = live;
  assert.equal(
    foldLiveSubagentTranscript(live, update(0, 1, 1, [{ index: 0, entry: transcript([]).entries[0]! }], "run-5")),
    before,
  );
});

test("a conversation over 2 MB loses its oldest steps first and says so", () => {
  const steps = Array.from({ length: 200 }, (_value, order) =>
    toolStep(order, { label: `Read file number ${order} of the project tree`, target: `src/module-${order}/index.ts` }),
  );
  const text = "x".repeat(190_000);
  const entries = Array.from({ length: 10 }, () => message(text, steps));
  const big = transcript(entries);
  assert.ok(subagentTranscriptBytes(big) > MAX_SUBAGENT_TRANSCRIPT_BYTES);

  const trimmed = trimSubagentTranscriptToBytes(big);
  assert.equal(trimmed.trimmed, true);
  assert.ok(subagentTranscriptBytes(trimmed) <= MAX_SUBAGENT_TRANSCRIPT_BYTES);
  const messages = trimmed.entries.slice(1) as Array<Extract<SubagentTranscriptEntry, { kind: "message" }>>;
  // Every message's words survive; only steps were dropped, oldest first.
  assert.ok(messages.every((entry) => entry.text === text));
  assert.equal(messages[0]!.steps.length, 0);
  assert.equal(messages[messages.length - 1]!.steps.length, 200);
  const counts = messages.map((entry) => entry.steps.length);
  assert.deepEqual(counts, [...counts].sort((left, right) => left - right));
  // What is left of a partly trimmed message is its newest steps, renumbered.
  const partial = messages.find((entry) => entry.steps.length > 0 && entry.steps.length < 200);
  if (partial) {
    const newest = partial.steps[partial.steps.length - 1]!;
    assert.equal(newest.kind === "tool" && newest.toolCallId, "call-200");
    assert.deepEqual(
      partial.steps.map((step) => step.order),
      partial.steps.map((_step, index) => index),
    );
  }
  assert.deepEqual(parseSubagentTranscript(trimmed), trimmed);
  // The input is left alone.
  assert.equal(big.trimmed, false);
  assert.equal((big.entries[1] as { steps: unknown[] }).steps.length, 200);
});

test("when steps are not enough, older text gives way before the newest message", () => {
  const text = "y".repeat(150_000);
  const big = transcript(Array.from({ length: 16 }, () => message(text)));
  const trimmed = trimSubagentTranscriptToBytes(big);
  assert.equal(trimmed.trimmed, true);
  assert.ok(subagentTranscriptBytes(trimmed) <= MAX_SUBAGENT_TRANSCRIPT_BYTES);
  assert.equal(trimmed.entries.length, big.entries.length);
  assert.equal(trimmed.entries[0]!.text, big.entries[0]!.text);
  assert.equal(trimmed.entries[trimmed.entries.length - 1]!.text, text);
  assert.notEqual(trimmed.entries[1]!.text, text);
});

test("a history reply carries a transcript only for the same run", () => {
  const detail = {
    version: 1,
    snapshot: {
      version: 1,
      runId: "run-1",
      groupId: "group-1",
      generationId: "generation-1",
      childId: "child-1",
      chatId: "chat-1",
      workspaceId: "workspace-1",
      revision: 1,
      role: "reviewer",
      label: "Review",
      taskPreview: "Review the loader.",
      state: "completed",
      finishedAt: 2_000,
      terminalMarkdown: "Complete.",
      startedAt: 1_000,
      updatedAt: 2_000,
      modelId: "test-model",
      turns: 2,
      tools: 3,
      tokens: 100,
      warnings: [],
    },
    effects: [],
  };
  const parsedDetail = parseSubagentHistoryDetailWithTranscript(detail);
  assert.ok(parsedDetail, "a reply without a transcript still parses");
  assert.equal(parsedDetail.transcript, undefined);

  const saved = transcript([message("Done.")]);
  assert.deepEqual(parseSubagentHistoryDetailWithTranscript({ ...detail, transcript: saved })?.transcript, saved);
  assert.equal(
    parseSubagentHistoryDetailWithTranscript({ ...detail, transcript: transcript([], 1, "run-2") }),
    undefined,
    "another run's transcript",
  );
  assert.equal(
    parseSubagentHistoryDetailWithTranscript({ ...detail, transcript: { ...saved, version: 9 } }),
    undefined,
    "a malformed transcript",
  );
});
