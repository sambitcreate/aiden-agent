import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMImplementation, DOMParser } from "@xmldom/xmldom";
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
  type HostChatLineage,
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
import { forkSummaryHoldsSend, type ChatForkLineageV1, type ChatForkSummaryV1 } from "../shared/chat-copy-contract";
import {
  RemoteChatPane,
  RemoteChatRoute,
  remoteComposerActions,
  remoteForkErrorMessage,
  useRemoteForkLineage,
  type RemoteChatPaneProps,
} from "./remote-chat-view";

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
  // A question's options are the buttons in its labelled group.
  const inLabelledGroup = (node: Element) => {
    for (let parent = node.parentNode as Element | null; parent?.getAttribute; parent = parent.parentNode as Element | null) {
      if (parent.getAttribute("role") === "group" && parent.getAttribute("aria-label")) return true;
    }
    return false;
  };
  const choices = buttons
    .filter(inLabelledGroup)
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

  assert.match(view.text, /Run shell needs approval/);
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

test("several approvals are answered one at a time, the first with a count and the rest waiting behind it", () => {
  const two = run([
    event(1, "run.started", { runId: "run-1", chatId: "chat-1" }),
    event(2, "approval_required", { approvalId: "ap-1", summary: "Run the release script", toolCallId: "c1", toolName: "run_shell" }),
    event(3, "approval_required", { approvalId: "ap-2", summary: "Push the tag", toolCallId: "c2", toolName: "run_shell" }),
  ]);
  const view = render({ host: online, snapshot: snapshot(online, { run: two }), chat: session(online).chat() });

  assert.equal(view.buttons.filter((node) => /^Deny$/.test(node.textContent ?? "")).length, 1, "one decision at a time");
  assert.match(view.text, /1 of 2/);
  const waiting = view.all.find((node) => node.getAttribute("data-remote-approval") === "ap-2");
  assert.ok(waiting, "the second approval stays visible");
  assert.equal(waiting.getElementsByTagName("button").length, 0);
  assert.match(waiting.textContent ?? "", /Push the tag/);
  assert.match(waiting.textContent ?? "", /Answer the approval above first\./);
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

const FORKING: HostChatCapability[] = [...RUN_CONTROL, "fork", "forkSummary"];

function forkActions(view: ReturnType<typeof render>, label: string) {
  return view.buttons.filter((node) => node.getAttribute("aria-label") === label);
}

test("a listed chat on a Mac that forks offers Fork from here on replies and Edit in fork past the first prompt", () => {
  const forkable = render({ host: online, snapshot: snapshot(online), chat: session(online, FORKING).chat(), forkable: true });
  assert.equal(forkActions(forkable, "Fork from here").length, 1, "the settled reply forks after itself");
  assert.equal(forkActions(forkable, "Edit in fork").length, 0, "the host can't fork before a chat's first prompt");

  // With older messages above, the oldest prompt shown isn't the chat's first.
  const paged = snapshot(online, { transcript: { chatId: "chat-1", revision: "r1", messages, hasOlder: true } });
  const older = render({ host: online, snapshot: paged, chat: session(online, FORKING).chat(), forkable: true });
  assert.equal(forkActions(older, "Edit in fork").length, 1);
  assert.equal(forkActions(older, "Fork from here")[0]?.hasAttribute("aria-disabled"), false);

  // Bot chats are never listed; a host without the feature offers nothing.
  const unlisted = render({ host: online, snapshot: snapshot(online), chat: session(online, FORKING).chat() });
  assert.equal(forkActions(unlisted, "Fork from here").length, 0);
  const plain = render({ host: online, snapshot: snapshot(online), chat: session(online).chat(), forkable: true });
  assert.equal(forkActions(plain, "Fork from here").length, 0);
});

test("forking waits while a run on the host is still going", () => {
  const live = run([event(1, "run.started", { runId: "run-1", chatId: "chat-1", origin: "device" })]);
  const view = render({
    host: online,
    snapshot: snapshot(online, { run: live }),
    chat: session(online, FORKING).chat(),
    forkable: true,
  });
  const fork = forkActions(view, "Fork from here")[0];
  assert.equal(fork?.getAttribute("aria-disabled"), "true");
  assert.equal(fork?.getAttribute("title"), "Finish the current response or approval before forking");
});

test("a fork shows where it came from, and a pending summary holds the composer", () => {
  const view = render({
    host: online,
    snapshot: snapshot(online),
    chat: session(online, FORKING).chat(),
    forkable: true,
    onOpenChat: noop,
    lineage: {
      forkedFrom: {
        chatId: "chat-0",
        messageId: "m9",
        position: "after",
        at: 1,
        summary: { state: "pending", afterMessageId: "m2", instructions: "the parser" },
      },
      sourceTitle: "Release plan",
    },
  });
  assert.ok(view.button(/Forked from “Release plan”/), "the source opens from the lineage row");
  assert.match(view.text, /Summarizing the original chat…/);
  assert.ok(view.markup.indexOf('data-fork-summary="pending"') > view.markup.indexOf("Here is the summary so far"));
  assert.match(view.text, /This fork is waiting for its summary\./);
  assert.ok(view.button(/Send message/)?.hasAttribute("disabled"));

  const unlistedSource = render({
    host: online,
    snapshot: snapshot(online),
    chat: session(online, FORKING).chat(),
    lineage: { forkedFrom: { chatId: "chat-0", messageId: "m9", position: "after", at: 1 } },
  });
  assert.match(unlistedSource.text, /Forked from another chat/);
  assert.equal(unlistedSource.button(/Forked from/), undefined, "a source the host doesn't list can't be opened");
  assert.doesNotMatch(unlistedSource.text, /waiting for its summary/);
});

test("a failed remote fork says what to do next", () => {
  assert.match(
    remoteForkErrorMessage(new HostChatControlError({ code: "outcome_unknown", message: "lost" }), "Studio"),
    /Studio didn't confirm the fork\. Fork again to check; it won't make a second copy\./,
  );
  assert.equal(
    remoteForkErrorMessage(
      new HostChatControlError({ code: "failed", message: "busy", remoteCode: "operation_in_progress", retryable: true }),
      "Studio",
    ),
    "Finish the current response or approval before copying this chat.",
  );
  assert.equal(
    remoteForkErrorMessage(
      new HostChatControlError({ code: "failed", message: "Forking is turned off.", remoteCode: "operation_in_progress" }),
      "Studio",
    ),
    "Forking is turned off.",
    "a fork the host won't make at all isn't blamed on a running response",
  );
  assert.match(
    remoteForkErrorMessage(new HostChatControlError({ code: "failed", message: "x", remoteCode: "revision_conflict" }), "Studio"),
    /This chat changed on Studio\./,
  );
});

/** A minimal document for react-dom; the lineage harness renders nothing itself. */
function installDocument() {
  const document = new DOMImplementation().createDocument(null, "html", null) as unknown as Document;
  const container = document.createElement("div");
  document.documentElement.appendChild(container);
  const elementPrototype = Object.getPrototypeOf(container) as Record<string, unknown>;
  elementPrototype.addEventListener = noop;
  elementPrototype.removeEventListener = noop;
  Object.defineProperty(elementPrototype, "style", { configurable: true, get: () => ({}) });
  const documentPrototype = Object.getPrototypeOf(document) as Record<string, unknown>;
  documentPrototype.addEventListener = noop;
  documentPrototype.removeEventListener = noop;
  const windowValue = {
    document,
    event: undefined,
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener: noop,
    removeEventListener: noop,
  };
  Object.defineProperty(document, "defaultView", { configurable: true, value: windowValue });
  const keys = ["window", "document", "navigator", "Node", "Element", "HTMLElement"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const ElementConstructor = Object.getPrototypeOf(document.documentElement).constructor;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowValue },
    document: { configurable: true, value: document },
    navigator: { configurable: true, value: { userAgent: "remote-chat-view-test" } },
    Node: { configurable: true, value: ElementConstructor },
    Element: { configurable: true, value: ElementConstructor },
    HTMLElement: { configurable: true, value: ElementConstructor },
  });
  return {
    container,
    restore() {
      for (const key of keys) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

/** Lets the read, the query cache's batched notifications and React's renders land. */
async function settle(): Promise<void> {
  for (let step = 0; step < 10; step += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Mounts the fork-lineage hook for one chat; `show` renders it at a feed row revision. */
async function mountForkLineage(host: Parameters<typeof useRemoteForkLineage>[0], listed: ChatForkLineageV1) {
  let latest: ReturnType<typeof useRemoteForkLineage> = { beginUpdate: () => noop };
  function Harness({ rowRevision }: { rowRevision: string }) {
    latest = useRemoteForkLineage(host, "chat-1", listed, rowRevision);
    return null;
  }
  const dom = installDocument();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(dom.container);
  return {
    async show(rowRevision: string) {
      root.render(
        <QueryClientProvider client={client}>
          <Harness rowRevision={rowRevision} />
        </QueryClientProvider>,
      );
      await settle();
      return latest.forkedFrom;
    },
    latest: () => latest,
    async dispose() {
      flushSync(() => root.unmount());
      client.clear();
      await settle();
      dom.restore();
    },
  };
}

test("a fork's summary changed on another device reaches the open pane when its feed row moves", async () => {
  const listed: ChatForkLineageV1 = { chatId: "chat-0", messageId: "m9", position: "after", at: 1 };
  const failed: ChatForkSummaryV1 = { state: "failed", afterMessageId: "m2", error: "The model was unavailable." };
  // The host's copy of the fork; each read returns its lineage under a content revision.
  let summary: ChatForkSummaryV1 | undefined = failed;
  let reads = 0;
  const host = {
    hostId: "host-b",
    capabilities: () => new Set<HostChatCapability>(["messagesWindow"]),
    async forkLineage(): Promise<{ ok: true; value: HostChatLineage }> {
      reads += 1;
      return { ok: true, value: { revision: `content-${reads}`, forkedFrom: { ...listed, ...(summary ? { summary } : {}) } } };
    },
  };
  const mounted = await mountForkLineage(host, listed);
  const show = mounted.show;
  const seen: Array<ChatForkLineageV1 | undefined> = [];
  try {
    seen.push(await show("rev_1"));
    assert.equal(reads, 1);
    assert.equal(seen[0]?.summary?.state, "failed");
    await show("rev_1");
    assert.equal(reads, 1, "a render without a feed change reads nothing");

    // Another device retries the summary: the host's row moves.
    summary = { state: "pending", afterMessageId: "m2" };
    seen.push(await show("rev_2"));
    assert.equal(seen[1]?.summary?.state, "pending");
    assert.equal(reads, 2);

    // The retry fails again, then another device continues without the summary.
    summary = failed;
    seen.push(await show("rev_3"));
    assert.equal(seen[2]?.summary?.state, "failed");
    summary = undefined;
    seen.push(await show("rev_4"));
    assert.equal(seen[3]?.summary, undefined, "the skipped summary is gone from the lineage");
    assert.equal(reads, 4);

    // With nothing left to settle, later row changes don't read the chat again.
    await show("rev_5");
    assert.equal(reads, 4);
  } finally {
    await mounted.dispose();
  }

  const pane = (forkedFrom: ChatForkLineageV1 | undefined) =>
    render({
      host: online,
      snapshot: snapshot(online),
      chat: session(online, FORKING).chat(),
      ...(forkedFrom ? { lineage: { forkedFrom } } : {}),
    });
  const [stale, retried, , skipped] = seen.map(pane);
  assert.ok(stale!.button(/^Retry$/), "the failed summary offers Retry");
  assert.match(stale!.text, /This fork is waiting for its summary\./);
  assert.match(retried!.text, /Summarizing the original chat…/);
  assert.equal(retried!.button(/^Retry$/), undefined, "the stale Retry is gone once the summary is pending again");
  assert.match(retried!.text, /This fork is waiting for its summary\./);
  assert.doesNotMatch(skipped!.markup, /data-fork-summary/);
  assert.doesNotMatch(skipped!.text, /waiting for its summary/, "the composer is no longer held");
});

test("a summary action's late answer does not replace a newer summary the pane already read", async () => {
  const listed: ChatForkLineageV1 = { chatId: "chat-0", messageId: "m9", position: "after", at: 1 };
  let summary: ChatForkSummaryV1 = { state: "failed", afterMessageId: "m2", error: "The model was unavailable." };
  let reads = 0;
  const host = {
    hostId: "host-b",
    capabilities: () => new Set<HostChatCapability>(["messagesWindow"]),
    async forkLineage(): Promise<{ ok: true; value: HostChatLineage }> {
      reads += 1;
      return { ok: true, value: { revision: `content-${reads}`, forkedFrom: { ...listed, summary } } };
    },
  };
  const mounted = await mountForkLineage(host, listed);
  try {
    assert.equal((await mounted.show("rev_1"))?.summary?.state, "failed");

    // Retry starts; the host answers "pending", but the answer is delayed.
    const applyRetry = mounted.latest().beginUpdate();
    const retryAnswer: HostChatLineage = {
      revision: "content-retry",
      forkedFrom: { ...listed, summary: { state: "pending", afterMessageId: "m2" } },
    };
    // Meanwhile the summary finishes and the feed brings the pane up to date.
    summary = { state: "ready", afterMessageId: "m2", text: "Earlier, the user asked about the release." };
    assert.equal((await mounted.show("rev_3"))?.summary?.state, "ready");

    applyRetry(retryAnswer);
    const shown = await mounted.show("rev_3");
    assert.equal(shown?.summary?.state, "ready", "the late pending answer does not bring the summary back");
    assert.equal(forkSummaryHoldsSend(shown), false, "the composer stays released");

    // An answer whose row has not moved since the action started applies as-is.
    summary = { state: "failed", afterMessageId: "m2", error: "The model was unavailable." };
    const applySkip = mounted.latest().beginUpdate();
    applySkip({ revision: "content-skip", forkedFrom: listed });
    assert.equal((await mounted.show("rev_3"))?.summary, undefined);
  } finally {
    await mounted.dispose();
  }
});
