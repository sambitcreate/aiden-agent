import assert from "node:assert/strict";
import test from "node:test";
import type { PeerFeedRow, PeerHostFeedSnapshot, PeerHostStatus, PeerHostView } from "../../shared/peer-host";
import { newChatMachines, remoteBotGroups, remoteProjectChoices, unlistedProjects } from "./new-chat-targets";
import { parseRemoteNewChatSearch } from "./remote-new-chat-search";

const CHAT_GRANTS = ["chat:read", "chat:write", "workspace:read"];

function view(id: string, name: string, capabilities: string[] = CHAT_GRANTS, enabled = true): PeerHostView {
  return { id, name, enabled, state: "connected", features: [], capabilities };
}

function connected(hostId: string): PeerHostStatus {
  return { hostId, generation: 1, state: { kind: "connected", since: 1 }, feed: "live", stale: false };
}

function backoff(hostId: string): PeerHostStatus {
  return { hostId, generation: 1, state: { kind: "backoff", attempt: 2, retryAt: 10 }, feed: "off", stale: true };
}

function feed(hostId: string, patch: Partial<PeerHostFeedSnapshot>): PeerHostFeedSnapshot {
  return { hostId, epoch: "e1", sequence: 1, stale: false, summaries: [], workspaces: [], bots: [], runs: [], ...patch };
}

test("an online host that granted chat writes can start a new chat", () => {
  const [studio] = newChatMachines([view("host-b", "Studio")], [connected("host-b")]);
  assert.equal(studio?.label, "Studio");
  assert.equal(studio?.availability, "online");
  assert.equal(studio?.disabledReason, undefined);
});

test("a host that cannot take a new chat stays listed with a reason naming it", () => {
  const machines = newChatMachines(
    [view("host-b", "Studio"), view("host-c", "Laptop", ["chat:read"]), view("host-d", "Spare"), view("host-e", "Off", CHAT_GRANTS, false)],
    [backoff("host-b"), connected("host-c")],
  );
  assert.deepEqual(
    machines.map((machine) => machine.id),
    ["host-b", "host-c", "host-d"],
    "disabled hosts are not offered at all",
  );
  const [studio, laptop, spare] = machines;
  assert.match(studio?.disabledReason ?? "", /^Studio is offline/u);
  assert.equal(laptop?.disabledReason, "Laptop hasn't allowed this Mac to start chats.");
  assert.match(spare?.disabledReason ?? "", /^Still connecting to Spare/u, "a host with no status yet is still connecting");
});

test("a host's projects are offered most recently used first, with a name even when the host sent none", () => {
  const rows: PeerFeedRow[] = [
    { id: "w-old", name: "Archive", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "w-new", name: "  ", repositoryName: "aiden-agent", updatedAt: "2026-03-01T00:00:00.000Z" },
    { id: "w-undated", name: "Notes" },
    { id: "w-mid", name: "Site", updatedAt: "2026-02-01T00:00:00.000Z" },
  ];
  assert.deepEqual(remoteProjectChoices(feed("host-b", { workspaces: rows })), [
    { id: "w-new", name: "Untitled project", detail: "aiden-agent" },
    { id: "w-mid", name: "Site" },
    { id: "w-old", name: "Archive" },
    { id: "w-undated", name: "Notes" },
  ]);
  assert.deepEqual(remoteProjectChoices(null), [], "a host with no feed yet offers no projects");
});

test("a project just created on the host is offered at once, and only once after its feed catches up", () => {
  const listed: PeerFeedRow[] = [{ id: "w-site", name: "Site", updatedAt: "2026-02-01T00:00:00.000Z" }];
  const created = [{ id: "w-launch", name: "launch" }];
  assert.deepEqual(
    remoteProjectChoices(feed("host-b", { workspaces: listed }), created).map((project) => project.name),
    ["launch", "Site"],
    "the new project can be chosen before the host's feed reports it",
  );
  assert.deepEqual(remoteProjectChoices(null, created), [{ id: "w-launch", name: "launch" }]);

  const caughtUp: PeerFeedRow[] = [...listed, { id: "w-launch", name: "launch", repositoryName: "launch-repo", updatedAt: "2026-03-01T00:00:00.000Z" }];
  assert.deepEqual(remoteProjectChoices(feed("host-b", { workspaces: caughtUp }), created), [
    { id: "w-launch", name: "launch", detail: "launch-repo" },
    { id: "w-site", name: "Site" },
  ]);
});

test("a created project the feed has listed is retired, so the host deleting it later removes it", () => {
  const site: PeerFeedRow = { id: "w-site", name: "Site", updatedAt: "2026-02-01T00:00:00.000Z" };
  const launch: PeerFeedRow = { id: "w-launch", name: "launch", updatedAt: "2026-03-01T00:00:00.000Z" };
  let created = [{ id: "w-launch", name: "launch" }];
  // The window keeps only what the feed has yet to list, as each feed snapshot arrives.
  const arrive = (rows: PeerFeedRow[]) => {
    const snapshot = feed("host-b", { workspaces: rows });
    created = unlistedProjects(created, snapshot);
    return remoteProjectChoices(snapshot, created).map((project) => project.id);
  };

  assert.deepEqual(arrive([site]), ["w-launch", "w-site"], "offered before the feed reports it");
  assert.deepEqual(arrive([site, launch]), ["w-launch", "w-site"], "listed once when the feed catches up");
  assert.deepEqual(created, [], "the feed now speaks for it");
  assert.deepEqual(arrive([site]), ["w-site"], "deleted on the host, it is no longer offered");
});

test("Bots are grouped by host, without archived Bots or hosts that have none", () => {
  const botGrants = [...CHAT_GRANTS, "bot:read", "bot:write"];
  const groups = remoteBotGroups(
    [view("host-b", "Studio", botGrants), view("host-c", "Laptop", botGrants), view("host-d", "Spare", CHAT_GRANTS)],
    [connected("host-b"), connected("host-c"), connected("host-d")],
    new Map([
      [
        "host-b",
        feed("host-b", {
          bots: [
            { id: "bot-1", name: "Reviewer", purpose: "Reviews pull requests" },
            { id: "bot-2", name: "Retired", health: "archived" },
            { id: "bot-3", name: "Old", archivedAt: "2026-01-01T00:00:00.000Z" },
            { id: "bot-4" },
          ],
        }),
      ],
      ["host-c", feed("host-c", { bots: [{ id: "bot-9", name: "Gone", health: "archived" }] })],
      ["host-d", feed("host-d", { bots: [{ id: "bot-5", name: "Scribe" }] })],
    ]),
  );
  assert.deepEqual(
    groups.map((group) => [group.host.id, group.bots]),
    [
      [
        "host-b",
        [
          { id: "bot-1", name: "Reviewer", purpose: "Reviews pull requests" },
          { id: "bot-4", name: "Untitled Bot" },
        ],
      ],
      ["host-d", [{ id: "bot-5", name: "Scribe" }]],
    ],
  );
  assert.equal(groups[0]?.host.disabledReason, undefined);
  assert.equal(groups[1]?.host.disabledReason, "Spare hasn't allowed this Mac to start Bot chats.");
});

test("the new remote chat route keeps only a well-formed project identifier", () => {
  assert.deepEqual(parseRemoteNewChatSearch({ workspaceId: "ws_01:abc.def-1" }), { workspaceId: "ws_01:abc.def-1" });
  assert.deepEqual(parseRemoteNewChatSearch({ workspaceId: "../etc/passwd" }), {});
  assert.deepEqual(parseRemoteNewChatSearch({ workspaceId: "a".repeat(161) }), {});
  assert.deepEqual(parseRemoteNewChatSearch({ workspaceId: 7 }), {});
  assert.deepEqual(parseRemoteNewChatSearch({}), {});
});
