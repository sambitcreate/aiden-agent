import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalPrompt } from "./ipc";
import type {
  LiveSubagentTranscripts,
  SubagentTranscriptUpdateV1,
  SubagentTranscriptV1,
} from "../shared/subagent-transcript";
import {
  combineLiveSubagentTranscripts,
  createSubagentHelperChatStore,
  mainChatWaitingFor,
  subagentHelperChatTranscript,
  subagentHelperTranscriptsRecovered,
} from "./subagent-helper-chat-store";

function saved(runId: string, revision: number, texts: string[]): SubagentTranscriptV1 {
  return {
    version: 1,
    runId,
    revision,
    trimmed: false,
    entries: [
      { kind: "task", text: "Find the parser." },
      ...texts.map((text) => ({ kind: "message" as const, text, steps: [], startedAt: 1_000 })),
    ],
  };
}

function update(
  runId: string,
  baseRevision: number,
  revision: number,
  index: number,
  text: string,
): SubagentTranscriptUpdateV1 {
  return {
    version: 1,
    runId,
    baseRevision,
    revision,
    trimmed: false,
    entryCount: index + 1,
    changes: [{ index, entry: { kind: "message", text, steps: [], startedAt: 2_000 } }],
  };
}

const live = (...updates: SubagentTranscriptUpdateV1[]): LiveSubagentTranscripts =>
  new Map(updates.map((value) => [value.runId, value]));

function messageTexts(transcript: SubagentTranscriptV1 | null): string[] {
  return (transcript?.entries ?? []).flatMap((entry) =>
    entry.kind === "message" ? [entry.text] : [],
  );
}

test("a window that joins late merges what streamed after the saved copy", () => {
  const store = createSubagentHelperChatStore();
  store.rememberSaved("chat-1", saved("run-1", 3, ["First look."]));
  store.syncLive("chat-1", live(update("run-1", 3, 4, 2, "Found it.")));

  const merged = subagentHelperChatTranscript(store.getState(), "run-1");
  assert.equal(merged.complete, true);
  assert.equal(merged.transcript?.revision, 4);
  assert.deepEqual(messageTexts(merged.transcript), ["First look.", "Found it."]);
});

test("a gap between the saved copy and the live updates keeps the saved copy and asks for a refetch", () => {
  const store = createSubagentHelperChatStore();
  store.rememberSaved("chat-1", saved("run-1", 3, ["First look."]));
  store.syncLive("chat-1", live(update("run-1", 6, 7, 2, "Much later.")));

  const gap = subagentHelperChatTranscript(store.getState(), "run-1");
  assert.equal(gap.complete, false);
  assert.deepEqual(messageTexts(gap.transcript), ["First look."]);

  // The refetched copy closes the gap, and the live update applies on top.
  store.rememberSaved("chat-1", saved("run-1", 6, ["First look.", "Midway."]));
  const closed = subagentHelperChatTranscript(store.getState(), "run-1");
  assert.equal(closed.complete, true);
  assert.deepEqual(messageTexts(closed.transcript), ["First look.", "Much later."]);
});

test("a failed read stops mattering once the helper's whole conversation arrives another way", () => {
  const store = createSubagentHelperChatStore();
  store.reset("chat-1");
  const failed = ["run-1", "run-2"];
  let before = store.getState();

  // A live update that starts beyond anything here is still a gap: the failure stands.
  store.syncLive("chat-1", live(update("run-1", 4, 5, 1, "Later.")));
  assert.deepEqual(subagentHelperTranscriptsRecovered(before, store.getState(), failed), []);

  // The first update of a helper that just started streams here whole.
  before = store.getState();
  const firstUpdate: SubagentTranscriptUpdateV1 = {
    version: 1,
    runId: "run-2",
    baseRevision: 0,
    revision: 1,
    trimmed: false,
    entryCount: 1,
    changes: [{ index: 0, entry: { kind: "task", text: "Read the notes." } }],
  };
  store.syncLive("chat-1", live(update("run-1", 4, 5, 1, "Later."), firstUpdate));
  assert.deepEqual(subagentHelperTranscriptsRecovered(before, store.getState(), failed), ["run-2"]);

  // A saved copy read by the saved run's own detail closes the gap.
  before = store.getState();
  store.rememberSaved("chat-1", saved("run-1", 4, ["Earlier.", "Midway.", "More."]));
  assert.deepEqual(subagentHelperTranscriptsRecovered(before, store.getState(), failed), ["run-1"]);

  // Nothing changed for either run: nothing recovers.
  before = store.getState();
  store.syncApprovals("chat-1", [], null, () => undefined);
  assert.deepEqual(subagentHelperTranscriptsRecovered(before, store.getState(), failed), []);
});

test("the conversation stays after the turn ends and its live updates are dropped", () => {
  const store = createSubagentHelperChatStore();
  const first: SubagentTranscriptUpdateV1 = {
    ...update("run-1", 0, 1, 1, "Hello"),
    changes: [
      { index: 0, entry: { kind: "task", text: "Find the parser." } },
      { index: 1, entry: { kind: "message", text: "Hello", steps: [], startedAt: 2_000 } },
    ],
  };
  store.syncLive("chat-1", live(first));
  store.syncLive("chat-1", new Map());
  const kept = subagentHelperChatTranscript(store.getState(), "run-1");
  assert.equal(kept.transcript?.revision, 1);
  assert.deepEqual(messageTexts(kept.transcript), ["Hello"]);
});

test("switching chats forgets the previous chat's helpers and closes the expanded chat", () => {
  const store = createSubagentHelperChatStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  store.rememberSaved("chat-1", saved("run-1", 2, ["Hi"]));
  store.expand("run-1", null);
  assert.equal(store.getState().expandedRunId, "run-1");

  store.reset("chat-2");
  assert.equal(store.getState().chatId, "chat-2");
  assert.equal(store.getState().expandedRunId, null);
  assert.equal(subagentHelperChatTranscript(store.getState(), "run-1").transcript, null);

  // A late write for the old chat cannot leak into the new one's state.
  const before = notifications;
  store.reset("chat-2");
  assert.equal(notifications, before, "resetting to the same chat is a no-op");
});

test("an answer from inside a helper chat goes to the main chat's approval handler", () => {
  const store = createSubagentHelperChatStore();
  const prompt: ApprovalPrompt = {
    approvalId: "approval-1",
    toolCallId: "call-1",
    toolName: "edit",
    summary: "Edit",
  };
  const decisions: Array<[string, string]> = [];
  store.syncApprovals("chat-1", [prompt], null, (value, decision) => {
    decisions.push([value.approvalId, decision]);
  });
  store.decide(prompt, "deny");
  assert.deepEqual(decisions, [["approval-1", "deny"]]);

  // After a chat switch the old handler is gone, so a stale click does nothing.
  store.reset("chat-2");
  store.decide(prompt, "allow");
  assert.deepEqual(decisions, [["approval-1", "deny"]]);
});

test("the chat stream and a detached run's projection combine by newest revision", () => {
  const fromStream = live(update("run-1", 0, 2, 0, "stream"), update("run-2", 0, 5, 0, "stream"));
  const fromProjection = live(
    update("run-1", 0, 3, 0, "projection"),
    update("run-2", 0, 4, 0, "projection"),
  );
  const combined = combineLiveSubagentTranscripts(fromStream, fromProjection);
  assert.equal(combined.get("run-1")?.revision, 3);
  assert.equal(combined.get("run-2")?.revision, 5);
  assert.equal(combineLiveSubagentTranscripts(fromStream, undefined), fromStream);
});

test("a late saved copy for a chat that is no longer presented is dropped", () => {
  const store = createSubagentHelperChatStore();
  store.reset("chat-2");
  store.rememberSaved("chat-1", saved("run-1", 2, ["From the old chat."]));
  assert.equal(store.getState().chatId, "chat-2");
  assert.equal(subagentHelperChatTranscript(store.getState(), "run-1").transcript, null);
});

test("on a chat switch the old chat's live updates and approvals are not taken as the new chat's", () => {
  const store = createSubagentHelperChatStore();
  const oldLive = live(update("run-1", 0, 1, 1, "Old chat's helper."));
  const oldApprovals: ApprovalPrompt[] = [
    { approvalId: "approval-old", toolCallId: "call-1", toolName: "edit", summary: "Edit" },
  ];
  store.syncLive("chat-1", oldLive);
  store.syncApprovals("chat-1", oldApprovals, null, null);

  // The new chat's first render still carries the old chat's maps.
  store.syncLive("chat-2", oldLive);
  store.syncApprovals("chat-2", oldApprovals, null, null);
  assert.equal(store.getState().chatId, "chat-2");
  assert.equal(store.getState().live.size, 0);
  assert.equal(store.getState().approvals.length, 0);
  assert.equal(subagentHelperChatTranscript(store.getState(), "run-1").transcript, null);
});

test("the main chat waits beyond a helper for a question or another approval, not the helper's own", () => {
  const own: ApprovalPrompt = {
    approvalId: "own",
    toolCallId: "c1",
    toolName: "edit",
    summary: "Edit",
  };
  const own2: ApprovalPrompt = {
    approvalId: "own-2",
    toolCallId: "c3",
    toolName: "bash",
    summary: "Run",
  };
  const other: ApprovalPrompt = {
    approvalId: "other",
    toolCallId: "c2",
    toolName: "bash",
    summary: "Run",
  };
  const mine = new Set(["own", "own-2"]);
  const none = new Set<string>();
  assert.equal(mainChatWaitingFor({ approvals: [own], questionPending: false }, mine), null);
  // Two approvals from the same helper (parallel tool calls) are both its own.
  assert.equal(mainChatWaitingFor({ approvals: [own, own2], questionPending: false }, mine), null);
  assert.equal(
    mainChatWaitingFor({ approvals: [own, other], questionPending: false }, mine),
    "approval",
  );
  assert.equal(
    mainChatWaitingFor({ approvals: [other], questionPending: false }, none),
    "approval",
  );
  assert.equal(mainChatWaitingFor({ approvals: [], questionPending: true }, none), "question");
  assert.equal(mainChatWaitingFor({ approvals: [], questionPending: false }, none), null);
  // The main card shows the helper's own approval first, so the question is what to go to.
  assert.equal(mainChatWaitingFor({ approvals: [own], questionPending: true }, mine), "question");
  // Another approval at the front of the queue is what the main card shows.
  assert.equal(
    mainChatWaitingFor({ approvals: [other, own], questionPending: true }, mine),
    "approval",
  );
});

test("returning to what waits in the main chat closes the expanded chat, then focuses the waiting item", () => {
  const globals = globalThis as { window?: unknown };
  const hadWindow = "window" in globals;
  const previous = globals.window;
  const frames: Array<() => void> = [];
  globals.window = { requestAnimationFrame: (callback: () => void) => frames.push(callback) };
  try {
    const store = createSubagentHelperChatStore();
    const focused: string[] = [];
    store.rememberSaved("chat-1", saved("run-1", 2, ["Hi"]));
    store.syncMainWaiting("chat-1", true, (kind) => {
      focused.push(`${store.getState().expandedRunId ?? "main"}:${kind}`);
    });
    store.expand("run-1", null);
    assert.equal(store.getState().questionPending, true);

    store.returnToMainWaiting("question");
    assert.equal(store.getState().expandedRunId, null);
    assert.deepEqual(focused, [], "focus waits for the main chat to render");
    for (const frame of frames) frame();
    assert.deepEqual(focused, ["main:question"]);

    // From the side panel, focus moves without closing anything.
    store.expand("run-1", null);
    store.focusMainWaiting("approval");
    assert.equal(store.getState().expandedRunId, "run-1");
    assert.deepEqual(focused, ["main:question", "run-1:approval"]);
  } finally {
    if (hadWindow) globals.window = previous;
    else delete globals.window;
  }
});

test("closing the expanded chat focuses the side panel's new Expand button for the same helper, or else the message box", () => {
  const globals = globalThis as { window?: unknown; document?: unknown; Node?: unknown };
  const had = {
    window: "window" in globals,
    document: "document" in globals,
    Node: "Node" in globals,
  };
  const previous = { window: globals.window, document: globals.document, Node: globals.Node };
  const frames: Array<() => void> = [];
  const focused: string[] = [];
  const element = (name: string, attributes: Record<string, string>, isConnected = true) =>
    ({
      isConnected,
      closest: () => null,
      hasAttribute: (attribute: string) => attribute in attributes,
      getAttribute: (attribute: string) => attributes[attribute] ?? null,
      focus: () => focused.push(name),
    }) as unknown as HTMLElement;
  const expandFor = (runId: string, name: string, isConnected = true) =>
    element(name, { "data-subagent-helper-expand": runId }, isConnected);
  const composer = element("composer", {
    "data-focus-region": "composer",
    "data-focus-region-entry": "",
  });
  // The side panel's Expand buttons on screen after the expanded chat closes.
  let panelButtons: HTMLElement[] = [];
  globals.window = { requestAnimationFrame: (callback: () => void) => frames.push(callback) };
  globals.Node = { DOCUMENT_NODE: 9 };
  globals.document = {
    nodeType: 9,
    get activeElement() {
      return null;
    },
    querySelectorAll: (selector: string) =>
      selector === "[data-subagent-helper-expand]"
        ? panelButtons
        : selector === '[data-focus-region="composer"]'
          ? [composer]
          : [],
  };
  const runFrames = () => {
    for (const frame of frames.splice(0)) frame();
  };
  try {
    const store = createSubagentHelperChatStore();
    store.rememberSaved("chat-1", saved("run-1", 2, ["Hi"]));

    // The opener is still on screen: it gets focus straight away.
    store.expand("run-1", expandFor("run-1", "old Expand"));
    store.collapse();
    assert.deepEqual(focused, ["old Expand"]);

    // The placeholder replaced the opener: focus waits for the panel to render this helper's new button.
    panelButtons = [expandFor("run-2", "other helper's Expand"), expandFor("run-1", "new Expand")];
    store.expand("run-1", expandFor("run-1", "old Expand", false));
    store.collapse();
    assert.equal(store.getState().expandedRunId, null);
    assert.deepEqual(focused, ["old Expand"]);
    runFrames();
    assert.deepEqual(focused, ["old Expand", "new Expand"]);

    // The panel moved on to another helper: its Expand button is not where focus came from.
    panelButtons = [expandFor("run-2", "other helper's Expand")];
    store.expand("run-1", expandFor("run-1", "old Expand", false));
    store.collapse();
    runFrames();
    assert.deepEqual(focused, ["old Expand", "new Expand", "composer"]);
  } finally {
    for (const key of ["window", "document", "Node"] as const) {
      if (had[key]) globals[key] = previous[key];
      else delete globals[key];
    }
  }
});
