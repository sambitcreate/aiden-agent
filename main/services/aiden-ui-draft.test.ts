import assert from "node:assert/strict";
import test from "node:test";
import type { ChatArtifactEventV1 } from "../../renderer/shared/chat-artifacts.js";
import { parseChatArtifactEventV1 } from "../../renderer/shared/chat-artifacts.js";
import { createUiDraftSession } from "./aiden-ui-draft.js";

function fakeSession(enabled = true) {
  const events: ChatArtifactEventV1[] = [];
  const timers: Array<() => void> = [];
  const session = createUiDraftSession({
    enabled,
    publicToolCallId: (raw) => ({ raw1: "call-1", raw2: "call-2" } as Record<string, string>)[raw],
    send: (event) => events.push(event),
    schedule: (run) => {
      timers.push(run);
      return timers.length;
    },
    cancelScheduled: () => undefined,
  });
  const flush = () => {
    while (timers.length) timers.shift()!();
  };
  return { session, events, flush };
}

const MARKUP = `<Visual title="Board"><Stat label="Total" value={3} /><Text>Hello</Text></Visual>`;

test("streaming markup becomes throttled, valid draft visuals at the call's row", () => {
  const { session, events, flush } = fakeSession();
  session.delta("raw1", "render_ui", { title: "Board", markup: MARKUP.slice(0, 40) });
  session.delta("raw1", "render_ui", { title: "Board", markup: MARKUP.slice(0, 70) });
  assert.equal(events.length, 0);
  flush();
  assert.equal(events.length, 1);
  const first = events[0]!;
  assert.equal(first.operation, "ui_draft");
  assert.ok(parseChatArtifactEventV1(first), "the event survives the renderer's parser");
  assert.equal(first.operation === "ui_draft" && first.toolCallId, "call-1");
  session.delta("raw1", "render_ui", { title: "Board", layout: "wide", markup: MARKUP });
  flush();
  const last = events[events.length - 1]!;
  assert.equal(last.operation === "ui_draft" && last.visual.layout, "wide");
  assert.match(last.operation === "ui_draft" ? last.visual.fallbackText : "", /Hello/u);
});

test("unchanged markup is not re-sent, and other tools or unknown calls are ignored", () => {
  const { session, events, flush } = fakeSession();
  session.delta("raw1", "render_ui", { title: "Board", markup: MARKUP });
  flush();
  session.delta("raw1", "render_ui", { title: "Board", markup: MARKUP });
  flush();
  session.delta("raw1", "render_artifact", { title: "x", html: "<p>" });
  session.delta("unknown", "render_ui", { title: "x", markup: MARKUP });
  flush();
  assert.equal(events.length, 1);
});

test("end flushes the final draft; cancel and dispose retract it", () => {
  const { session, events, flush } = fakeSession();
  session.delta("raw1", "render_ui", { title: "Board", markup: MARKUP });
  session.end("raw1");
  assert.equal(events.length, 1);
  session.cancel("raw1");
  assert.deepEqual(events[events.length - 1], { version: 1, operation: "draft_end", toolCallId: "call-1" });
  session.delta("raw2", "render_ui", { title: "Other", markup: MARKUP });
  flush();
  session.dispose();
  assert.deepEqual(events[events.length - 1], { version: 1, operation: "draft_end", toolCallId: "call-2" });
  flush();
});

test("a disabled session never emits", () => {
  const { session, events, flush } = fakeSession(false);
  session.delta("raw1", "render_ui", { title: "Board", markup: MARKUP });
  flush();
  session.end("raw1");
  session.dispose();
  assert.deepEqual(events, []);
});
