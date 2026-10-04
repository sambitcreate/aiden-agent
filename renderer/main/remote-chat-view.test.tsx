import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandSystemProvider } from "../lib/command-system";
import { ChatIntentLedger } from "../lib/hosts/chat-intent-ledger";
import { ChatSessionControl } from "../lib/hosts/chat-session-control";
import {
  HostChatControlError,
  type HostChatAdapter,
  type HostChatApprovalResult,
  type HostChatCapability,
  type HostChatInput,
  type HostChatStatus,
} from "../lib/hosts/host-chat-adapter";
import type { ChatSession } from "../lib/hosts/use-chat-session";
import type { PeerHostStatus, PeerHostView, PeerRunEvent } from "../shared/peer-host";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import type { ChatMessage } from "../lib/types";
import type { SidebarHost } from "../lib/sidebar-remote-groups";
import type { RemoteChatSnapshot } from "../lib/hosts/remote-chat-session";
import { applyRemoteRunEvents, initialRemoteRunView, type RemoteRunView } from "../lib/hosts/remote-stream-translator";
import type { ChatRunInputAdmissionResult } from "../shared/chat-run-input";
import { RemoteChatPane, RemoteChatRoute, remoteComposerActions, type RemoteChatPaneProps } from "./remote-chat-view";

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

const CONTROL: HostChatCapability[] = ["messagesWindow", "observe", "markRead", "send", "rename", "remove"];
const RUN_CONTROL: HostChatCapability[] = [...CONTROL, "cancel", "respondApproval", "answerQuestion", "steer"];

/** A paired host as the pane's session control sees it. */
class StubHost implements HostChatAdapter {
  readonly hostId = "host-b";
  readonly granted: Set<HostChatCapability>;
  readonly current: HostChatStatus;
  sendFails: HostChatControlError | null = null;
  /** While set, a send waits for it before the host answers. */
  sendHeld: Promise<void> | null = null;
  approval: HostChatApprovalResult = { resolution: "applied" };
  input: ChatRunInputAdmissionResult = { admitted: true, committed: true };
  inputs: string[] = [];

  constructor(host: SidebarHost, granted: HostChatCapability[]) {
    this.granted = new Set(granted);
    this.current = { availability: host.availability, generation: 1 };
  }
  capabilities() {
    return this.granted;
  }
  ready() {
    return Promise.resolve();
  }
  status() {
    return this.current;
  }
  onStatus() {
    return noop;
  }
  onChatChanged() {
    return noop;
  }
  getMessagesWindow(): never {
    throw new Error("unused");
  }
  observe() {
    return noop;
  }
  async markRead() {
    return { ok: true as const, value: undefined };
  }
  async send() {
    if (this.sendHeld) await this.sendHeld;
    if (this.sendFails) throw this.sendFails;
    return { turnId: "turn-1", streamId: "run-2" };
  }
  async cancel() {
    return true;
  }
  async respondApproval() {
    return this.approval;
  }
  async answerQuestion() {
    return { status: "answered" as const };
  }
  async submitInput(_chatId: string, input: HostChatInput) {
    this.inputs.push(input.text);
    return this.input;
  }
  async rename() {}
  async remove() {}
  dispose() {}
}

function session(host: SidebarHost, granted: HostChatCapability[] = RUN_CONTROL) {
  const adapter = new StubHost(host, granted);
  const control = new ChatSessionControl(adapter, { hostId: "host-b", chatId: "chat-1" }, new ChatIntentLedger());
  control.attach();
  return { control, adapter, chat: (): ChatSession => ({ control, snapshot: control.getSnapshot() }) };
}

function parse(markup: string) {
  const document = new DOMParser().parseFromString(`<!doctype html><html><body>${markup}</body></html>`, "text/html");
  return (document.documentElement?.textContent ?? "").replace(/\s+/g, " ");
}

function render(props: Partial<RemoteChatPaneProps> & Pick<RemoteChatPaneProps, "host" | "snapshot">) {
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <CommandSystemProvider>
        <RemoteChatPane
          title="Release notes"
          chat={null}
          onLoadOlder={noop}
          onReconnect={reconnect}
          onManage={noop}
          onRemoved={noop}
          {...props}
        />
      </CommandSystemProvider>
    </QueryClientProvider>,
  );
  const document = new DOMParser().parseFromString(`<!doctype html><html><body>${markup}</body></html>`, "text/html");
  const all = Array.from(document.getElementsByTagName("*"));
  const text = (document.documentElement?.textContent ?? "").replace(/\s+/g, " ");
  const buttons = all.filter((node) => node.tagName.toLowerCase() === "button");
  const button = (label: RegExp) =>
    buttons.find((node) => label.test(node.textContent ?? "") || label.test(node.getAttribute("aria-label") ?? ""));
  const typing = all.filter((node) => ["textarea", "input"].includes(node.tagName.toLowerCase()));
  const choices = buttons
    .filter((node) => node.getAttribute("role") === "radio")
    .map((node) => node.getElementsByTagName("span")[1]?.firstChild?.textContent ?? "");
  return { markup, all, text, buttons, button, typing, choices };
}

const waitingRun = () =>
  run([
    event(1, "run.started", { runId: "run-1", chatId: "chat-1" }),
    event(2, "approval_required", {
      approvalId: "ap-1",
      summary: "Run the release script",
      toolCallId: "call-1",
      toolName: "run_shell",
      details: { command: "npm run release" },
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

test("a run started on the host streams into the open chat, and its composer can steer or stop it", () => {
  const live = run([
    event(1, "run.started", { runId: "run-1", chatId: "chat-1", origin: "device" }),
    event(2, "text_delta", { text: "Streaming from Studio" }),
  ]);
  const view = render({ host: online, snapshot: snapshot(online, { run: live }), chat: session(online).chat() });

  assert.match(view.text, /Release notes/);
  assert.match(view.text, /Studio · Connected/);
  assert.match(view.text, /Summarise the release notes/);
  // The live row follows the host's run (its text reveals client-side).
  assert.match(view.text, /Responding…/);
  assert.equal(view.typing.length, 1, "one composer for this chat");
  const stop = view.button(/Stop generating/);
  assert.ok(stop, "a run started on the host can be stopped from here");
  assert.equal(stop.hasAttribute("disabled"), false);
  assert.ok(view.button(/Queue message|Steer response/), "typing while it runs goes to the host's run");
  // Nothing on this Mac is offered for a chat that runs elsewhere.
  for (const label of [/Attach files/i, /Workspace access/i, /terminal/i, /Open in/i, /Reveal/i]) {
    assert.equal(view.button(label), undefined, `unexpected ${label} control`);
  }
  assert.doesNotMatch(view.text, /last-known transcript/);
  assert.equal(view.button(/Reconnect/), undefined);
  assert.ok(view.button(/Chat actions/), "rename and delete act on the host");
});

test("a host that grants reading only shows no composer and says why", () => {
  const view = render({
    host: online,
    snapshot: snapshot(online),
    chat: session(online, ["messagesWindow", "observe"]).chat(),
  });
  assert.equal(view.typing.length, 0);
  assert.match(view.text, /This chat runs on Studio\. That Mac doesn't allow sending from here\./);
  assert.equal(view.button(/Chat actions/), undefined);
});

test("an offline host keeps the composer but refuses to send, stop or answer until it is back", () => {
  const view = render({
    host: offline,
    snapshot: snapshot(offline, { run: waitingRun() }),
    chat: session(offline).chat(),
  });

  assert.match(view.text, /That Mac is offline\. Nothing is sent until it is back online\./);
  assert.ok(view.button(/Stop generating/)?.hasAttribute("disabled"), "no stop is queued for later");
  // The approval stays visible, disabled with the reason, never answered locally.
  assert.ok(view.button(/Allow once/)?.hasAttribute("disabled"));
  assert.ok(view.button(/^Deny$/)?.hasAttribute("disabled"));
  assert.match(view.text, /Run the release script/);
  // The question cannot be answered offline: it is shown with the reason instead.
  assert.match(view.text, /Which branch should I tag\?/);
  assert.deepEqual(view.choices, []);
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

test("a host that does not grant run control shows its prompts read-only, to be answered there", () => {
  const view = render({
    host: online,
    snapshot: snapshot(online, { run: waitingRun() }),
    chat: session(online, ["messagesWindow", "observe"]).chat(),
  });

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

test("with run control, the approval and the question are answered from this Mac", () => {
  const view = render({ host: online, snapshot: snapshot(online, { run: waitingRun() }), chat: session(online).chat() });

  const allow = view.button(/Allow once/);
  assert.ok(allow);
  assert.equal(allow.hasAttribute("disabled"), false);
  assert.equal(view.button(/^Deny$/)?.hasAttribute("disabled"), false);
  // The question takes the composer's place, with the host's options.
  assert.deepEqual(view.choices, ["main", "release"]);
  assert.doesNotMatch(view.text, /Answer it on Studio/);
});

test("an approval whose details the host left out can only be denied", () => {
  const omitted = run([
    event(1, "run.started", { runId: "run-1", chatId: "chat-1" }),
    event(2, "approval_required", {
      approvalId: "ap-2",
      summary: "Write the changelog",
      toolCallId: "call-1",
      toolName: "write_file",
      detailsOmitted: true,
    }),
  ]);
  const view = render({ host: online, snapshot: snapshot(online, { run: omitted }), chat: session(online).chat() });
  assert.ok(view.button(/^Deny$/));
  assert.equal(view.button(/Allow/), undefined);
});

test("a lost send acknowledgement holds the message for a same-key retry and blocks new sends", async () => {
  const { control, adapter, chat } = session(online);
  adapter.sendFails = new HostChatControlError({ code: "outcome_unknown", message: "The answer was lost." });
  await assert.rejects(control.send("Tag the release"), { code: "outcome_unknown" });

  const view = render({ host: online, snapshot: snapshot(online), chat: chat() });
  const banner = view.all.find((node) => node.getAttribute("data-remote-unresolved"));
  assert.ok(banner, "the reconciliation state is shown");
  assert.equal(banner.getAttribute("role"), "alert");
  assert.match(banner.textContent ?? "", /Your message may not have been sent\./);
  assert.match(banner.textContent ?? "", /Tag the release/);
  assert.ok(view.button(/^Retry$/));
  assert.ok(view.button(/^Dismiss$/));
  assert.match(view.text, /Retry or dismiss the message above before sending another\./);
  assert.ok(view.button(/Send message/)?.hasAttribute("disabled"));
});

test("a reopened chat offers no composer until the host answers the message sent from its earlier pane", async () => {
  const ledger = new ChatIntentLedger();
  const adapter = new StubHost(online, RUN_CONTROL);
  const ref = { hostId: "host-b", chatId: "chat-1" };
  let answer!: () => void;
  adapter.sendHeld = new Promise((resolve) => {
    answer = resolve;
  });
  const earlier = new ChatSessionControl(adapter, ref, ledger);
  const detach = earlier.attach();
  const sent = earlier.send("Tag the build");
  detach();

  const reopened = new ChatSessionControl(adapter, ref, ledger);
  reopened.attach();
  const view = () => render({ host: online, snapshot: snapshot(online), chat: { control: reopened, snapshot: reopened.getSnapshot() } });
  const waiting = view();
  assert.equal(waiting.button(/Send message|Queue/), undefined, "the text cannot be sent again under a new key");
  assert.match(waiting.text, /Waiting for Studio to confirm your last message\./);

  answer();
  await sent;
  // A pane opened after the answer has nothing to wait for.
  const later = new ChatSessionControl(adapter, ref, ledger);
  later.attach();
  const ready = render({ host: online, snapshot: snapshot(online), chat: { control: later, snapshot: later.getSnapshot() } });
  assert.ok(ready.button(/Send message/));
  assert.doesNotMatch(ready.text, /Waiting for/);
});

test("guidance keeps the composer's text only when the host did not save it", async () => {
  const { control, adapter } = session(online);
  const steer = remoteComposerActions(control, "run-1", "Studio Mac").submitInput("steer");

  // The run ended before the guidance landed, but the host saved it to the chat.
  adapter.input = { admitted: false, reason: "cancelled", committed: true, messageId: "message-9" };
  await steer("Use the release branch");

  // Rejected outright: the composer must keep the text for the person to resend.
  adapter.input = { admitted: false, reason: "cancelled", committed: false };
  await assert.rejects(steer("Use main instead"), /.+/);

  assert.deepEqual(adapter.inputs, ["Use the release branch", "Use main instead"]);
});

test("an approval answered first on another device says so", async () => {
  const { control, adapter, chat } = session(online);
  adapter.approval = { resolution: "elsewhere", decision: "deny" };
  const result = await control.respondApproval({ runId: "run-1", approvalId: "ap-1", decision: "allow" });
  assert.deepEqual(result, { resolution: "elsewhere", decision: "deny" });

  const view = render({ host: online, snapshot: snapshot(online), chat: chat() });
  const notice = view.all.find((node) => node.getAttribute("data-remote-elsewhere") === "approval");
  assert.ok(notice);
  assert.match(notice.textContent ?? "", /Already answered elsewhere/);
  assert.match(notice.textContent ?? "", /Another device denied it first\. Your decision was not applied\./);
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

const studioView: PeerHostView = {
  id: "host-b",
  name: "Studio",
  enabled: true,
  state: "connected",
  features: [],
  capabilities: [],
};

/** The route as it renders against the host queries the sidebar fills in. */
function route(seed: (client: QueryClient) => unknown = noop) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return Promise.resolve(seed(client)).then(() =>
    parse(
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <RemoteChatRoute hostId="host-b" chatId="chat-1" onManage={noop} onRemoved={noop} />
        </QueryClientProvider>,
      ),
    ),
  );
}

test("opening a remote chat directly waits for the paired hosts before calling the Mac disconnected", async () => {
  const cold = await route();
  assert.doesNotMatch(cold, /not connected/);
  assert.match(cold, /Loading…/);

  // The hosts are known but this one has not reported a status yet.
  const listed = await route((client) => client.setQueryData(hostQueryKeys.list(), [studioView]));
  assert.doesNotMatch(listed, /not connected/);
  assert.match(listed, /Studio · Connecting…/);

  const connected: PeerHostStatus = {
    hostId: "host-b",
    generation: 3,
    state: { kind: "connected", since: 1 },
    feed: "live",
    stale: false,
  };
  const live = await route((client) => {
    client.setQueryData(hostQueryKeys.list(), [studioView]);
    client.setQueryData(hostQueryKeys.statuses(), [connected]);
  });
  assert.match(live, /Studio · Connected/);
});

test("a remote chat whose Mac is unpaired, turned off or unreadable says so once the hosts are known", async () => {
  const unpaired = await route((client) => client.setQueryData(hostQueryKeys.list(), []));
  assert.match(unpaired, /This Mac is not connected/);

  const off = await route((client) => client.setQueryData(hostQueryKeys.list(), [{ ...studioView, enabled: false }]));
  assert.match(off, /This Mac is not connected/);

  const failed = await route((client) =>
    client.prefetchQuery({ queryKey: hostQueryKeys.list(), queryFn: () => Promise.reject(new Error("Keychain locked")) }),
  );
  assert.doesNotMatch(failed, /Loading…/);
  assert.match(failed, /Paired Macs could not be read/);
  assert.match(failed, /Keychain locked/);
});
