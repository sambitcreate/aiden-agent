// Installs happy-dom for the Testing Library cases; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FollowThroughChipList } from "./follow-through-chips";
import { AgentNoticeCard } from "./agent-notice-card";
import { TooltipProvider } from "./ui";
import { ExternalLinkOpenerProvider } from "../lib/link-opener";
import type { BackgroundJobView } from "../shared/background-jobs";
import { emptyChatFollowThrough, type ChatFollowThroughV1, type PullRequestFollowView } from "../shared/follow-through";
import { agentNotice, fenceAsData } from "../shared/agent-notices";

const clients: QueryClient[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

const NOW = Date.now();

function job(overrides: Partial<BackgroundJobView> = {}): BackgroundJobView {
  return {
    id: "job_1a2b3c4d",
    chatId: "chat-1",
    workspaceId: "ws-1",
    command: "npm run dev",
    description: "Run the dev server",
    state: "running",
    startedAt: NOW - 125_000,
    outputBytes: 120,
    ...overrides,
  };
}

function follow(overrides: Partial<PullRequestFollowView> = {}): PullRequestFollowView {
  return {
    host: "github.com",
    repository: "acme/app",
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "Add export",
    startedAt: NOW - 60_000,
    startedBy: "agent",
    state: "following",
    status: "1 check failing",
    noticesSent: 1,
    ...overrides,
  };
}

function mount(state: ChatFollowThroughV1 | undefined, handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls = installBotTestIpc({
    "chats:followThroughStopJob": () => undefined,
    "chats:followThroughStopFollow": () => undefined,
    "chats:followThroughClearCheck": () => undefined,
    "chats:followThroughJobOutput": () => ({ job: job(), output: "VITE ready on http://localhost:5173\n", truncated: false }),
    ...handlers,
  });
  const opened: string[] = [];
  let changed = 0;
  // No garbage-collection timers: they would keep the test process alive.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(queryClient);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ExternalLinkOpenerProvider openExternal={(url) => (opened.push(url), true)}>
          <div data-testid="bar">
            <FollowThroughChipList chatId="chat-1" state={state} onChanged={() => (changed += 1)} />
          </div>
        </ExternalLinkOpenerProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, calls, opened, changed: () => changed };
}

test("nothing shows while nothing is running, followed or checked", () => {
  const base = emptyChatFollowThrough("chat-1");
  mount({ ...base, jobs: [job({ state: "exited", exitCode: 0 })], pullRequests: [follow({ state: "ended", endedReason: "merged" })] });
  assert.equal(screen.getByTestId("bar").childElementCount, 0);
  cleanup();
  mount(undefined);
  assert.equal(screen.getByTestId("bar").childElementCount, 0);
});

test("the jobs chip counts running jobs and its list shows output and stops a job", async () => {
  const state = {
    ...emptyChatFollowThrough("chat-1"),
    jobs: [job(), job({ id: "job_5e6f7a8b", description: undefined, command: "npm test -- --watch", startedAt: NOW - 5_000 }), job({ id: "job_00000001", description: "Build the app", state: "failed", exitCode: 1, endedAt: NOW })],
  };
  const { calls, changed } = mount(state);
  fireEvent.click(screen.getByRole("button", { name: "2 background jobs running" }));
  const dialog = await screen.findByRole("dialog", { name: "Background jobs" });
  assert.ok(within(dialog).getByText("Run the dev server"));
  assert.ok(within(dialog).getByText("npm test -- --watch"), "a job without a label shows its command");
  assert.ok(within(dialog).getByText(/^Running for 2m$/u));
  assert.ok(within(dialog).getByText("Failed with code 1"));
  assert.equal(within(dialog).getAllByRole("button", { name: "Stop" }).length, 2, "only running jobs can be stopped");

  const [firstOutput] = within(dialog).getAllByRole("button", { name: "Output" });
  fireEvent.click(firstOutput!);
  assert.ok(await within(dialog).findByText(/VITE ready on http:\/\/localhost:5173/u));

  fireEvent.click(within(dialog).getAllByRole("button", { name: "Stop" })[0]!);
  await waitFor(() => assert.equal(changed(), 1));
  assert.deepEqual(
    calls.find((call) => call.channel === "chats:followThroughStopJob")?.args,
    [{ chatId: "chat-1", jobId: "job_1a2b3c4d" }],
  );
});

test("a job's running time is current when its list opens, not when the chip appeared", async (t) => {
  let clock = NOW;
  t.mock.method(Date, "now", () => clock);
  mount({ ...emptyChatFollowThrough("chat-1"), jobs: [job({ startedAt: NOW })] });
  clock = NOW + 125_000;
  fireEvent.click(screen.getByRole("button", { name: "1 background job running" }));
  const dialog = await screen.findByRole("dialog", { name: "Background jobs" });
  await waitFor(() => assert.ok(within(dialog).getByText(/^Running for 2m$/u)));
});

test("the follow chip names the pull request, opens it, and stops following", async () => {
  const state = { ...emptyChatFollowThrough("chat-1"), pullRequests: [follow(), follow({ number: 7, state: "ended", endedReason: "merged", title: "Old" })] };
  const { calls, opened, changed } = mount(state);
  fireEvent.click(screen.getByRole("button", { name: "Following pull request 42" }));
  const dialog = await screen.findByRole("dialog", { name: "Followed pull requests" });
  assert.ok(within(dialog).getByText("1 check failing · 1 of 10 updates sent"));
  assert.ok(within(dialog).getByText("Merged"));
  assert.ok(within(dialog).getByText(/Only comments from people who can write to the repository reach the agent/u));
  fireEvent.click(within(dialog).getByRole("button", { name: "Open pull request 42" }));
  assert.deepEqual(opened, ["https://github.com/acme/app/pull/42"]);
  assert.equal(within(dialog).getAllByRole("button", { name: "Stop" }).length, 1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
  await waitFor(() => assert.equal(changed(), 1));
  assert.deepEqual(calls.find((call) => call.channel === "chats:followThroughStopFollow")?.args, [
    { chatId: "chat-1", host: "github.com", repository: "acme/app", number: 42 },
  ]);
});

test("the check chip reads as the loop's state and can be stopped or dismissed", async () => {
  const waiting = {
    ...emptyChatFollowThrough("chat-1"),
    check: { command: "npm test", state: "waiting" as const, checksRun: 2, setAt: NOW, lastExitCode: 1 },
  };
  const first = mount(waiting);
  const chip = screen.getByRole("button", { name: /^Done when: npm test\./u });
  assert.equal(chip.textContent, "Until npm test passes");
  fireEvent.click(chip);
  const dialog = await screen.findByRole("dialog", { name: "Done-when check" });
  assert.ok(within(dialog).getByText("Last run failed with code 1 · 2 of 5 checks used"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop checking" }));
  await waitFor(() => assert.equal(first.changed(), 1));
  assert.deepEqual(first.calls.find((call) => call.channel === "chats:followThroughClearCheck")?.args, [{ chatId: "chat-1" }]);
  cleanup();

  mount({ ...waiting, check: { ...waiting.check, state: "passed", checksRun: 3, lastExitCode: 0 } });
  const passed = screen.getByRole("button", { name: /^Done when: npm test\./u });
  assert.equal(passed.textContent, "Check passed");
  fireEvent.click(passed);
  assert.ok(await screen.findByRole("button", { name: "Dismiss" }));
});

test("a notice card shows its heading and opens to exactly what the agent was told", () => {
  const output = "FAIL src/export.test.ts\n  expected 2, got 3";
  const content = `[Aiden follow-up: done-when check]\n\n${fenceAsData("The check's output", output)}`;
  render(
    <AgentNoticeCard
      notice={agentNotice({ source: "check", tone: "failure", title: "Check failed", summary: "npm test · exit code 1 · check 1 of 5" })}
      content={content}
    />,
  );
  const card = screen.getByRole("note", { name: "Done-when check: Check failed" });
  assert.ok(within(card).getByText("npm test · exit code 1 · check 1 of 5"));
  assert.equal(within(card).queryByText(/expected 2, got 3/u), null, "the output stays folded away");
  const details = within(card).getByRole("button", { name: "Details" });
  assert.equal(details.getAttribute("aria-expanded"), "false");
  fireEvent.click(details);
  assert.equal(details.getAttribute("aria-expanded"), "true");
  assert.ok(within(card).getByText("What Aiden told the agent"));
  assert.ok(within(card).getByText(/expected 2, got 3/u));
});
