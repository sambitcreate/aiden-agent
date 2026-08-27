import assert from "node:assert/strict";
import test from "node:test";
import type { SkillCatalogEntry } from "../shared/slash-commands.js";
import {
  consumeSlashToken,
  deriveSlashSession,
  dismissSlashSession,
  failedSendAttachments,
  failedSendDraft,
  moveSlashSelection,
  pageSlashSelection,
  rankSlashResults,
  selectedSkillComposerReducer,
  selectedSkillStatus,
  successfulSendAttachmentRemainder,
  slashActionCommitIsCurrent,
  slashActionDraftCommitIsCurrent,
  slashPalettePresenceState,
  slashTabAcceptsSelection,
  updateSlashSessionTracker,
} from "./slash-command-core.js";

const invocationId = (index: number) => `sk1_${index.toString(36).padStart(43, "0")}`;
const input = (draft: string, caret = draft.length) => ({
  draft,
  selectionStart: caret,
  selectionEnd: caret,
  composing: false,
  tracker: updateSlashSessionTracker(undefined, draft),
});

test("selected skills revalidate by exact opaque ID and workspace without rebinding", () => {
  const selected = {
    workspaceId: "workspace-a",
    invocation: {
      version: 1 as const,
      invocationId: invocationId(1),
      displayName: "Review",
      source: "workspace" as const,
    },
  };
  const exact: SkillCatalogEntry = {
    invocationId: invocationId(1),
    name: "Review",
    description: "Review changes",
    source: "workspace",
    available: true,
  };
  assert.equal(
    selectedSkillStatus(selected, "workspace-a", undefined, "loading").state,
    "checking",
  );
  assert.equal(selectedSkillStatus(selected, "workspace-a", [exact], "ready").state, "valid");
  assert.equal(selectedSkillStatus(selected, "workspace-a", [exact], "loading").state, "checking");
  assert.equal(selectedSkillStatus(selected, "workspace-b", [exact], "ready").state, "invalid");
  assert.equal(selectedSkillStatus(selected, "workspace-a", [exact], "error").state, "invalid");
  assert.equal(
    selectedSkillStatus(
      selected,
      "workspace-a",
      [{ ...exact, invocationId: invocationId(2) }],
      "ready",
    ).state,
    "invalid",
  );
});

test("selected skill interactions replace, remove, and clear only the accepted snapshot", () => {
  const first = {
    workspaceId: "workspace-a",
    invocation: {
      version: 1 as const,
      invocationId: invocationId(1),
      displayName: "Review",
      source: "workspace" as const,
    },
  };
  const second = {
    ...first,
    invocation: { ...first.invocation, invocationId: invocationId(2), displayName: "Test" },
  };
  let state = selectedSkillComposerReducer({ revision: 0 }, { type: "select", selected: first });
  assert.equal(state.selected, first);
  const submittedRevision = state.revision;
  state = selectedSkillComposerReducer(state, { type: "select", selected: second });
  assert.equal(state.selected, second, "a second palette choice replaces the first");
  assert.equal(
    selectedSkillComposerReducer(state, { type: "send-succeeded", submittedRevision }).selected,
    second,
    "a late send success cannot erase a replacement",
  );
  const removed = selectedSkillComposerReducer(state, { type: "remove" });
  assert.equal(removed.selected, undefined);
  state = selectedSkillComposerReducer(removed, { type: "select", selected: first });
  assert.equal(
    selectedSkillComposerReducer(state, {
      type: "send-succeeded",
      submittedRevision: state.revision,
    }).selected,
    undefined,
    "an accepted send consumes its exact selected skill",
  );
});

test("optimistic skill clearing restores only the rejected send it still owns", () => {
  const selected = {
    workspaceId: "workspace-a",
    invocation: {
      version: 1 as const,
      invocationId: invocationId(1),
      displayName: "Review",
      source: "workspace" as const,
    },
  };
  const replacement = {
    ...selected,
    invocation: { ...selected.invocation, invocationId: invocationId(2), displayName: "Test" },
  };
  let state = selectedSkillComposerReducer({ selected, revision: 4 }, {
    type: "send-started",
    submittedRevision: 4,
  });
  assert.deepEqual(state, { selected: undefined, revision: 5 });
  assert.deepEqual(
    selectedSkillComposerReducer(state, {
      type: "send-failed",
      optimisticRevision: 5,
      submitted: selected,
    }),
    { selected, revision: 6 },
  );

  state = selectedSkillComposerReducer(state, { type: "select", selected: replacement });
  assert.equal(
    selectedSkillComposerReducer(state, {
      type: "send-failed",
      optimisticRevision: 5,
      submitted: selected,
    }).selected,
    replacement,
    "a rejected send cannot overwrite a newer skill choice",
  );
});

test("rejected send reconciliation retains submitted and newer composer payloads", () => {
  assert.equal(failedSendDraft("First message", ""), "First message");
  assert.equal(failedSendDraft("First message", "First message"), "First message");
  assert.equal(
    failedSendDraft("First message", "Next message"),
    "First message\n\nNext message",
  );
  assert.deepEqual(
    failedSendAttachments(
      [{ id: "sent" }, { id: "shared" }],
      [{ id: "shared" }, { id: "new" }],
    ),
    [{ id: "sent" }, { id: "shared" }, { id: "new" }],
  );
});

test("successful send cleanup preserves only payload fields changed while start was pending", () => {
  const sent = [{ id: "sent" }];
  assert.deepEqual(successfulSendAttachmentRemainder(sent, sent, true), []);
  assert.deepEqual(successfulSendAttachmentRemainder([...sent, { id: "new" }], sent, false), [
    { id: "new" },
  ]);
  assert.deepEqual(successfulSendAttachmentRemainder([], sent, false), []);
});

test("slash trigger requires the first non-whitespace token and a collapsed caret inside it", () => {
  assert.equal(deriveSlashSession(input("hello /model")), null);
  assert.equal(deriveSlashSession({ ...input("/model"), composing: true }), null);
  assert.equal(
    deriveSlashSession({ ...input("/model"), selectionStart: 1, selectionEnd: 2 }),
    null,
  );
  assert.equal(deriveSlashSession(input("/model later", 9)), null);
  assert.deepEqual(deriveSlashSession(input("  /model task", 5)), {
    kind: "command",
    trigger: "/",
    tokenStart: 2,
    tokenEnd: 8,
    token: "/model",
    query: "model",
    argument: " task",
    sessionKey: "1:/model",
  });
  assert.deepEqual(deriveSlashSession(input("  $review task", 5)), {
    kind: "skill",
    trigger: "$",
    tokenStart: 2,
    tokenEnd: 9,
    token: "$review",
    query: "review",
    argument: " task",
    sessionKey: "1:$review",
  });
  assert.ok(deriveSlashSession(input("\n\t/Users/private")));
  assert.equal(deriveSlashSession(input("ordinary prose")), null);
});

test("escape remains sticky through caret and leading-space changes but a changed or retyped token resets it", () => {
  let tracker = updateSlashSessionTracker(undefined, "/mod");
  tracker = dismissSlashSession(tracker);
  assert.equal(deriveSlashSession({ ...input("/mod"), tracker }), null);

  tracker = updateSlashSessionTracker(tracker, "  /mod");
  assert.equal(deriveSlashSession({ ...input("  /mod", 4), tracker }), null);

  tracker = updateSlashSessionTracker(tracker, "/mode");
  assert.ok(deriveSlashSession({ ...input("/mode"), tracker }));
  tracker = dismissSlashSession(tracker);
  tracker = updateSlashSessionTracker(tracker, "");
  tracker = updateSlashSessionTracker(tracker, "/mode");
  assert.ok(deriveSlashSession({ ...input("/mode"), tracker }));
});

test("token consumption preserves exact whitespace, newlines, and indentation", () => {
  const draft = "  $review\n\n    Keep indentation";
  const session = deriveSlashSession(input(draft, 5));
  assert.ok(session);
  assert.equal(session.argument, "\n\n    Keep indentation");
  assert.equal(consumeSlashToken(draft, session), "  \n\n    Keep indentation");
  assert.equal(consumeSlashToken("changed", session), "changed");
});

test("commands and skills rank only inside their explicit trigger namespace", () => {
  const skills: SkillCatalogEntry[] = [
    {
      invocationId: invocationId(1),
      name: "Model auditor",
      description: "Review model metadata",
      source: "workspace",
      available: true,
    },
  ];
  assert.equal(
    rankSlashResults("models", skills, "command").results[0]?.id,
    "slash-option-command-model",
  );
  assert.equal(
    rankSlashResults("rev", skills, "command").results[0]?.id,
    "slash-option-command-review",
  );
  assert.equal(
    rankSlashResults("auditor", skills, "skill").results[0]?.id,
    `slash-option-skill-${invocationId(1)}`,
  );
  assert.ok(rankSlashResults("mdl", skills, "command").results.length > 0);
  assert.equal(rankSlashResults("model", skills, "skill").results.length, 1);
  assert.ok(
    rankSlashResults("", skills, "command").results.every((result) => result.kind === "command"),
  );
  assert.ok(
    rankSlashResults("", skills, "skill").results.every((result) => result.kind === "skill"),
  );
  const astral: SkillCatalogEntry = {
    invocationId: invocationId(2),
    name: "😀 alpha xray",
    description: "",
    source: "workspace",
    available: true,
  };
  assert.equal(
    rankSlashResults("😀x", [astral], "skill").results[0]?.id,
    `slash-option-skill-${invocationId(2)}`,
  );
});

test("ranking is deterministic, DOM-safe, source ordered, and capped after all 500 entries", () => {
  const skills: SkillCatalogEntry[] = Array.from({ length: 500 }, (_, index) => ({
    invocationId: invocationId(index),
    name: index === 499 ? "Exact last match" : `Skill ${String(index).padStart(3, "0")}`,
    description: "",
    source: index % 3 === 0 ? "configured" : index % 2 ? "global" : "workspace",
    available: true,
  }));
  const ranked = rankSlashResults("", [...skills].reverse(), "skill");
  const reranked = rankSlashResults("", skills, "skill");
  assert.deepEqual(
    ranked.results.map((result) => result.id),
    reranked.results.map((result) => result.id),
  );
  assert.equal(ranked.results.length, 100);
  assert.equal(ranked.truncated, true);
  assert.ok(ranked.results.every((result) => /^slash-option-[A-Za-z0-9_-]+$/u.test(result.id)));
  assert.equal(
    rankSlashResults("Exact last match", skills, "skill").results[0]?.id,
    `slash-option-skill-${invocationId(499)}`,
  );
  assert.throws(() => rankSlashResults("", [...skills, skills[0]!], "skill"));
});

test("oversized Unicode queries do not open or rank", () => {
  assert.equal(deriveSlashSession(input(`/${"😀".repeat(257)}`)), null);
  assert.equal(deriveSlashSession(input(`$${"😀".repeat(257)}`)), null);
  assert.throws(() => rankSlashResults("😀".repeat(257), [], "command"));
});

test("keyboard selection wraps while skipping unavailable results", () => {
  const results = rankSlashResults("", [], "command").results;
  const selectable = (result: (typeof results)[number]) =>
    result.kind === "command" && result.command.name !== "new";
  const first = moveSlashSelection(results, undefined, 1, selectable);
  assert.ok(first);
  assert.notEqual(first, "slash-option-command-new");
  const previous = moveSlashSelection(results, first, -1, selectable);
  assert.ok(previous);
  assert.notEqual(previous, first);
  const selectableResults = results.filter(selectable);
  assert.equal(
    pageSlashSelection(results, undefined, -1, selectable),
    selectableResults[selectableResults.length - 1]?.id,
  );
});

test("an async action only commits against the exact unblocked draft session it started from", () => {
  const expected = {
    draft: "/copy",
    epoch: 3,
    interactionRevision: 7,
    blocked: false,
  };
  assert.equal(slashActionCommitIsCurrent(expected, expected), true);
  assert.equal(
    slashActionCommitIsCurrent(expected, {
      draft: "/copy later",
      epoch: 4,
      interactionRevision: 8,
      blocked: false,
    }),
    false,
  );
  assert.equal(
    slashActionCommitIsCurrent(expected, {
      draft: "/copy",
      epoch: 3,
      interactionRevision: 8,
      blocked: false,
    }),
    false,
  );
  assert.equal(
    slashActionCommitIsCurrent(expected, {
      ...expected,
      blocked: true,
    }),
    false,
  );
});

test("a session action may own focus while never consuming a changed draft", () => {
  const expected = { draft: "/export", epoch: 4 };
  assert.equal(slashActionDraftCommitIsCurrent(expected, expected), true);
  assert.equal(
    slashActionDraftCommitIsCurrent(expected, { draft: "/export later", epoch: 5 }),
    false,
  );
});

test("Tab never accepts a slash option while its action is pending", () => {
  assert.equal(slashTabAcceptsSelection(1, false), true);
  assert.equal(slashTabAcceptsSelection(1, true), false);
  assert.equal(slashTabAcceptsSelection(2, false), false);
});

test("palette presence closes synchronously and reopens visibly", () => {
  assert.equal(
    slashPalettePresenceState({
      present: false,
      retained: true,
      immediate: true,
      reduceMotion: false,
    }),
    "hidden",
  );
  assert.equal(
    slashPalettePresenceState({
      present: false,
      retained: true,
      immediate: false,
      reduceMotion: true,
    }),
    "hidden",
  );
  assert.equal(
    slashPalettePresenceState({
      present: false,
      retained: true,
      immediate: false,
      reduceMotion: false,
    }),
    "exiting",
  );
  assert.equal(
    slashPalettePresenceState({
      present: true,
      retained: true,
      immediate: false,
      reduceMotion: false,
    }),
    "visible",
  );
});
