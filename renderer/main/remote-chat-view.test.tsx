import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import type { PeerRunEvent } from "../shared/peer-host";
import type { ChatMessage } from "../lib/types";
import type { SidebarHost } from "../lib/sidebar-remote-groups";
import type { RemoteChatSnapshot } from "../lib/hosts/remote-chat-session";
import { applyRemoteRunEvents, initialRemoteRunView, type RemoteRunView } from "../lib/hosts/remote-stream-translator";
import { RemoteChatPane, type RemoteChatPaneProps } from "./remote-chat-view";

const noop = () => undefined;
const reconnect = async () => undefined;

const online: SidebarHost = { id: "host-b", label: "Studio", availability: "online" };
const offline: SidebarHost = { id: "host-b", label: "Studio", availability: "offline" };
const blocked: SidebarHost = { id: "host-b", label: "Studio", availability: "blocked", blockedReason: "auth" };

function event(sequence: number, type: string, payload: Record<string, unknown> = {}): PeerRunEvent {
  return {
    protocolVersion: 1,
    streamId: "run-1",
    sequence,
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    type,
    terminal: false,
    payload,
  };
}

function run(events: PeerRunEvent[]): RemoteRunView {
  return applyRemoteRunEvents(initialRemoteRunView(null, "chat-1"), events).view;
}

const messages: ChatMessage[] = [
  { id: "m1", role: "user", content: "Summarise the release notes", createdAt: 1 },
  { id: "m2", role: "assistant", content: "Here is the summary so far", createdAt: 2 },
];

function snapshot(host: SidebarHost, patch: Partial<RemoteChatSnapshot> = {}): RemoteChatSnapshot {
  return {
    hostId: host.id,
    chatId: "chat-1",
    status: { availability: host.availability, generation: 1 },
    transcript: { chatId: "chat-1", revision: "r1", messages, hasOlder: false },
    loaded: true,
    loading: false,
    loadingOlder: false,
    stale: host.availability !== "online",
    error: null,
    run: initialRemoteRunView(null, "chat-1"),
    ...patch,
  };
}

function render(props: Partial<RemoteChatPaneProps> & Pick<RemoteChatPaneProps, "host" | "snapshot">) {
  const markup = renderToStaticMarkup(
    <RemoteChatPane title="Release notes" onLoadOlder={noop} onReconnect={reconnect} onManage={noop} {...props} />,
  );
  const document = new DOMParser().parseFromString(`<!doctype html><html><body>${markup}</body></html>`, "text/html");
  const all = Array.from(document.getElementsByTagName("*"));
  const text = (document.documentElement?.textContent ?? "").replace(/\s+/g, " ");
  const buttons = all.filter((node) => node.tagName.toLowerCase() === "button");
  const button = (label: RegExp) => buttons.find((node) => label.test(node.textContent ?? ""));
  return { markup, all, text, buttons, button };
}

test("a run started on the host streams into the open chat without a composer", () => {
  const live = run([
    event(1, "run.started", { runId: "run-1", chatId: "chat-1", origin: "device" }),
    event(2, "text_delta", { text: "Streaming from Studio" }),
  ]);
  const view = render({ host: online, snapshot: snapshot(online, { run: live }) });

  assert.match(view.text, /Release notes/);
  assert.match(view.text, /Studio · Connected/);
  assert.match(view.text, /Summarise the release notes/);
  // The live row follows the host's run (its text reveals client-side).
  assert.match(view.text, /Responding…/);
  assert.match(view.text, /Sending from this Mac arrives in a later update/);
  // Viewing only: nothing to type into and no stale notice while connected.
  assert.equal(view.all.filter((node) => ["textarea", "input"].includes(node.tagName.toLowerCase())).length, 0);
  assert.doesNotMatch(view.text, /last-known transcript/);
  assert.equal(view.button(/Reconnect/), undefined);
});

test("an offline host keeps the last-known transcript visible and offers a reconnect", () => {
  const view = render({
    host: offline,
    snapshot: snapshot(offline, {
      transcript: { chatId: "chat-1", revision: "r1", messages, hasOlder: true },
    }),
  });

  assert.match(view.text, /Summarise the release notes/);
  assert.match(view.text, /Here is the summary so far/);
  assert.match(view.text, /Studio · Offline/);
  assert.match(view.text, /Showing the last-known transcript/);
  const status = view.all.find((node) => node.getAttribute("role") === "status" && node.getAttribute("data-host-availability"));
  assert.equal(status?.getAttribute("data-host-availability"), "offline");
  assert.ok(view.button(/Reconnect/), "the status row reconnects the host");
  // Older pages cannot be read while the host is away.
  assert.ok(view.button(/Load older messages/)?.hasAttribute("disabled"));
  const marker = view.all.find((node) => node.getAttribute("role") === "img");
  assert.equal(marker?.getAttribute("aria-label"), "On Studio, offline");
});

test("a host that needs re-pairing points to Connections instead of reconnecting", () => {
  const view = render({ host: blocked, snapshot: snapshot(blocked) });
  assert.match(view.text, /Studio · Needs re-pairing/);
  assert.match(view.text, /Here is the summary so far/);
  assert.ok(view.button(/Connections/));
  assert.equal(view.button(/Reconnect/), undefined);
});

test("Load older appears only while the host has older messages, and waits for the page in flight", () => {
  const more = { chatId: "chat-1", revision: "r1", messages, hasOlder: true };
  const ready = render({ host: online, snapshot: snapshot(online, { transcript: more }) }).button(/Load older messages/);
  assert.ok(ready);
  assert.equal(ready.hasAttribute("disabled"), false);

  const loading = render({ host: online, snapshot: snapshot(online, { transcript: more, loadingOlder: true }) });
  assert.ok(loading.button(/Load older messages/)?.hasAttribute("disabled"));

  const complete = render({ host: online, snapshot: snapshot(online) });
  assert.equal(complete.button(/Load older messages/), undefined);
});

test("a pending approval and question are shown read-only, to be answered on the host", () => {
  const waiting = run([
    event(1, "run.started", { runId: "run-1", chatId: "chat-1" }),
    event(2, "approval_required", {
      approvalId: "ap-1",
      summary: "Run the release script",
      toolCallId: "call-1",
      toolName: "run_shell",
    }),
    event(3, "question_required", {
      promptId: "q-1",
      toolCallId: "call-2",
      questions: [
        {
          question: "Which branch should I tag?",
          header: "Branch",
          multiSelect: false,
          options: [
            { label: "main", description: "The default branch" },
            { label: "release", description: "The release branch" },
          ],
        },
      ],
    }),
  ]);
  const view = render({ host: online, snapshot: snapshot(online, { run: waiting }) });

  assert.match(view.text, /run shell needs approval/);
  assert.match(view.text, /Run the release script/);
  assert.match(view.text, /Approve or deny it on Studio\./);
  assert.match(view.text, /Which branch should I tag\?/);
  assert.match(view.text, /Answer it on Studio\./);
  // No control reaches the host from this Mac: no allow, deny or answer buttons.
  for (const label of [/Allow/i, /Deny/i, /Always/i, /^main$/, /^release$/, /Submit/i, /Skip/i]) {
    assert.equal(view.button(label), undefined, `unexpected ${label} button`);
  }
  const cards = view.all.filter(
    (node) => node.getAttribute("data-remote-approval") || node.getAttribute("data-remote-question"),
  );
  assert.equal(cards.length, 2);
  for (const card of cards) assert.equal(card.getElementsByTagName("button").length, 0);
  // The only actions left are the transcript's own, which stay on this Mac.
  assert.deepEqual(
    [...new Set(view.buttons.map((node) => node.getAttribute("aria-label")))],
    ["Copy message"],
  );
});

test("a run that has not started on the host shows no live row", () => {
  const view = render({ host: online, snapshot: snapshot(online) });
  assert.doesNotMatch(view.text, /Responding…/);
});

test("a finished run leaves no prompts behind", () => {
  const settled = run([
    event(1, "run.started", { runId: "run-1", chatId: "chat-1" }),
    event(2, "approval_required", { approvalId: "ap-1", summary: "Run it", toolCallId: "c1", toolName: "shell" }),
    { ...event(3, "done", { messageId: "m2" }), terminal: true },
  ]);
  const view = render({ host: online, snapshot: snapshot(online, { run: settled }) });
  assert.doesNotMatch(view.text, /needs approval/);
  assert.match(view.text, /Here is the summary so far/);
});

test("the pane shows loading before the first window and the read failure when nothing loaded", () => {
  assert.match(render({ host: online, snapshot: null }).text, /Loading…/);
  const failed = render({
    host: online,
    snapshot: snapshot(online, {
      loaded: false,
      transcript: { chatId: "chat-1", revision: null, messages: [], hasOlder: false },
      error: "This chat is no longer on Studio.",
    }),
  });
  assert.match(failed.text, /This chat could not be opened/);
  assert.match(failed.text, /This chat is no longer on Studio\./);
});
