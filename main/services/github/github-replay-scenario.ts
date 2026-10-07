// Test support: a scripted 30-minute desktop session that drives the real
// pull request services the way the renderer does (sidebar polling, change
// events, window activation, chat switches, rail opens, the link chooser and
// post-push detection), so implementations can be compared by how many calls
// reach GitHub.

import type { ChatPullRequestService } from "../chat-pull-request-service.js";

const MINUTE = 60_000;
const SIDEBAR_POLL_MS = 5 * MINUTE;
const SIDEBAR_STALE_MS = MINUTE;
const CHAT_CURRENT_STALE_MS = 30_000;

export interface ReplayWorkspace {
  id: string;
  folder: string;
  repository: string;
  branch: string;
  pullRequest: number;
}

export interface ReplayPullRequest {
  repository: string;
  number: number;
  headBranch: string;
  checks: "passing" | "failing" | "pending";
  headSha: string;
  title: string;
}

export interface ReplayChat {
  id: string;
  workspaceId: string;
  links: number[];
}

export const REPLAY_WORKSPACES: readonly ReplayWorkspace[] = [
  { id: "ws1", folder: "/work/ws1", repository: "acme/app1", branch: "feature/one", pullRequest: 101 },
  { id: "ws2", folder: "/work/ws2", repository: "acme/app2", branch: "feature/two", pullRequest: 102 },
  { id: "ws3", folder: "/work/ws3", repository: "acme/app3", branch: "feature/three", pullRequest: 103 },
  { id: "ws4", folder: "/work/ws4", repository: "acme/shared", branch: "feature/four", pullRequest: 104 },
  { id: "ws5", folder: "/work/ws5", repository: "acme/shared", branch: "feature/five", pullRequest: 105 },
];

export const REPLAY_CHATS: readonly ReplayChat[] = [
  { id: "chat-one", workspaceId: "ws1", links: [101, 201, 202, 203] },
  { id: "chat-two", workspaceId: "ws2", links: [102, 211, 212, 213] },
  { id: "chat-four", workspaceId: "ws4", links: [104, 221, 222, 223] },
];

/** Mutable GitHub-side state the fakes answer from. */
export class ReplayWorld {
  readonly pullRequests = new Map<string, ReplayPullRequest>();
  /** Remote-tracking head per workspace; a push moves it. */
  readonly pushed = new Map<string, string>();

  constructor() {
    for (const workspace of REPLAY_WORKSPACES) {
      this.add(workspace.repository, workspace.pullRequest, workspace.branch);
      this.pushed.set(workspace.id, `${workspace.pullRequest}`.padStart(40, "a"));
    }
    for (const chat of REPLAY_CHATS) {
      const workspace = this.workspace(chat.workspaceId);
      for (const number of chat.links) {
        if (!this.pullRequests.has(key(workspace.repository, number))) {
          this.add(workspace.repository, number, `topic/${number}`);
        }
      }
    }
  }

  workspace(id: string): ReplayWorkspace {
    const workspace = REPLAY_WORKSPACES.find((entry) => entry.id === id);
    if (!workspace) throw new Error(`unknown workspace ${id}`);
    return workspace;
  }

  workspaceForFolder(folder: string): ReplayWorkspace | undefined {
    return REPLAY_WORKSPACES.find((entry) => entry.folder === folder);
  }

  pullRequest(repository: string, number: number): ReplayPullRequest | undefined {
    return this.pullRequests.get(key(repository, number));
  }

  forBranch(repository: string, branch: string): ReplayPullRequest[] {
    return [...this.pullRequests.values()].filter(
      (pr) => pr.repository === repository && pr.headBranch === branch,
    );
  }

  open(repository: string): ReplayPullRequest[] {
    return [...this.pullRequests.values()].filter((pr) => pr.repository === repository);
  }

  push(workspaceId: string): void {
    const workspace = this.workspace(workspaceId);
    const sha = `${Date.now()}${workspace.pullRequest}`.padStart(40, "b").slice(-40);
    this.pushed.set(workspaceId, sha);
    const pr = this.pullRequest(workspace.repository, workspace.pullRequest);
    if (pr) {
      pr.headSha = sha;
      pr.checks = "pending";
    }
  }

  private add(repository: string, number: number, headBranch: string): void {
    this.pullRequests.set(key(repository, number), {
      repository,
      number,
      headBranch,
      checks: "passing",
      headSha: `${number}`.padStart(40, "c"),
      title: `Change ${number}`,
    });
  }
}

function key(repository: string, number: number): string {
  return `${repository}#${number}`;
}

export interface ReplayBackend {
  service: ChatPullRequestService;
  /** What `git:pullRequestStatus` does for a workspace folder. */
  sidebarStatus(folder: string): Promise<unknown>;
  /** Requests that reached GitHub so far. */
  githubCalls(): number;
}

export interface ReplayClock {
  now(): number;
  set(ms: number): void;
}

/** A renderer query: cached, stale after `staleMs`, optionally polled. */
class ReplayQuery {
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  private nextPollAt = Number.POSITIVE_INFINITY;
  active = false;

  constructor(
    private readonly fetcher: () => Promise<unknown>,
    private readonly staleMs: number,
    private readonly pollMs?: number,
  ) {}

  fetch(now: number): Promise<unknown> {
    this.lastFetchAt = now;
    return this.fetcher();
  }

  mount(now: number): Promise<unknown> | undefined {
    this.active = true;
    if (this.pollMs !== undefined) this.nextPollAt = now + this.pollMs;
    return this.refetchIfStale(now);
  }

  unmount(): void {
    this.active = false;
  }

  refetchIfStale(now: number): Promise<unknown> | undefined {
    if (!this.active || now - this.lastFetchAt < this.staleMs) return undefined;
    return this.fetch(now);
  }

  invalidate(now: number): Promise<unknown> | undefined {
    return this.active ? this.fetch(now) : undefined;
  }

  restartInterval(now: number): void {
    if (this.pollMs !== undefined && this.active) this.nextPollAt = now + this.pollMs;
  }

  pollDue(now: number): Promise<unknown> | undefined {
    if (!this.active || now < this.nextPollAt || this.pollMs === undefined) return undefined;
    this.nextPollAt += this.pollMs;
    return this.fetch(now);
  }
}

type ReplayEvent =
  | { at: number; kind: "git-changed"; workspaceId: string; push?: boolean; detectChat?: string }
  | { at: number; kind: "show-chat"; chatId: string }
  | { at: number; kind: "open-rail" }
  | { at: number; kind: "open-chooser" }
  | { at: number; kind: "blur" }
  | { at: number; kind: "activate" }
  | { at: number; kind: "checks-fail"; repository: string; number: number };

const m = (minutes: number) => Math.round(minutes * MINUTE);

export const REPLAY_EVENTS: readonly ReplayEvent[] = [
  { at: 0, kind: "show-chat", chatId: "chat-one" },
  { at: m(1.5), kind: "git-changed", workspaceId: "ws1" },
  { at: m(3), kind: "git-changed", workspaceId: "ws2" },
  { at: m(4), kind: "git-changed", workspaceId: "ws1" },
  { at: m(7), kind: "git-changed", workspaceId: "ws3" },
  { at: m(8), kind: "show-chat", chatId: "chat-two" },
  { at: m(9), kind: "git-changed", workspaceId: "ws1", push: true, detectChat: "chat-one" },
  { at: m(10.25), kind: "open-rail" },
  { at: m(11), kind: "open-chooser" },
  { at: m(12), kind: "git-changed", workspaceId: "ws4" },
  { at: m(13), kind: "blur" },
  { at: m(14), kind: "activate" },
  { at: m(15), kind: "checks-fail", repository: "acme/shared", number: 222 },
  { at: m(16), kind: "git-changed", workspaceId: "ws1" },
  { at: m(17), kind: "show-chat", chatId: "chat-four" },
  { at: m(19.5), kind: "git-changed", workspaceId: "ws2", push: true, detectChat: "chat-two" },
  { at: m(21), kind: "open-rail" },
  { at: m(23), kind: "git-changed", workspaceId: "ws5" },
  { at: m(25), kind: "show-chat", chatId: "chat-one" },
  { at: m(27), kind: "git-changed", workspaceId: "ws1" },
];

export const REPLAY_DURATION_MS = m(30);

export interface ReplayResult {
  githubCalls: number;
  /** Chat change notifications the main process broadcast. */
  notifications: number;
}

/**
 * Run the session. `backend` is built by the caller around the world and the
 * clock; `notifications` is the counter its `onChanged` increments.
 */
export async function runReplaySession(input: {
  world: ReplayWorld;
  clock: ReplayClock;
  backend: ReplayBackend;
  notifications: () => number;
  onNotify: (listener: (chatId: string) => void) => void;
}): Promise<ReplayResult> {
  const { world, clock, backend } = input;
  const sidebar = new Map(
    REPLAY_WORKSPACES.map((workspace) => [
      workspace.id,
      new ReplayQuery(() => backend.sidebarStatus(workspace.folder), SIDEBAR_STALE_MS, SIDEBAR_POLL_MS),
    ]),
  );
  const current = new Map(
    REPLAY_CHATS.map((chat) => [
      chat.id,
      new ReplayQuery(() => backend.service.current(chat.id), CHAT_CURRENT_STALE_MS),
    ]),
  );
  let visibleChat: string | undefined;
  let windowActive = true;
  const inFlight: Array<Promise<unknown> | undefined> = [];
  input.onNotify((chatId) => {
    inFlight.push(current.get(chatId)?.invalidate(clock.now()));
  });

  const settle = async () => {
    while (inFlight.length > 0) await Promise.all(inFlight.splice(0));
  };

  clock.set(0);
  for (const query of sidebar.values()) inFlight.push(query.mount(0));

  const events = [...REPLAY_EVENTS];
  for (let now = 0; now <= REPLAY_DURATION_MS; now += 15_000) {
    clock.set(now);
    if (windowActive) {
      for (const query of sidebar.values()) inFlight.push(query.pollDue(now));
    }
    while (events[0] && events[0].at <= now) {
      const event = events.shift();
      if (!event) break;
      switch (event.kind) {
        case "show-chat": {
          if (visibleChat) current.get(visibleChat)?.unmount();
          visibleChat = event.chatId;
          inFlight.push(current.get(event.chatId)?.mount(now));
          break;
        }
        case "git-changed": {
          if (event.push) world.push(event.workspaceId);
          inFlight.push(sidebar.get(event.workspaceId)?.refetchIfStale(now));
          if (event.detectChat) {
            const workspace = world.workspace(event.workspaceId);
            inFlight.push(
              backend.service.detectAfterPush(event.detectChat, {
                workspaceId: workspace.id,
                headBranch: workspace.branch,
              }),
            );
          }
          break;
        }
        case "open-rail": {
          const chatId = visibleChat;
          if (!chatId) break;
          await settle();
          await backend.service.refresh(chatId);
          await settle();
          inFlight.push(current.get(chatId)?.invalidate(clock.now()));
          break;
        }
        case "open-chooser": {
          if (visibleChat) inFlight.push(backend.service.candidates(visibleChat));
          break;
        }
        case "blur":
          windowActive = false;
          break;
        case "activate":
          windowActive = true;
          for (const query of sidebar.values()) {
            query.restartInterval(now);
            inFlight.push(query.refetchIfStale(now));
          }
          break;
        case "checks-fail": {
          const pr = world.pullRequest(event.repository, event.number);
          if (pr) pr.checks = "failing";
          break;
        }
      }
    }
    await settle();
  }
  await settle();
  return { githubCalls: backend.githubCalls(), notifications: input.notifications() };
}
