// Chips in the composer's context bar for what a chat has going on after an
// answer: background jobs ("2 in background"), followed pull requests
// ("Following #12") and the done-when check ("Until npm test passes"). Each
// opens a small popover with its state and a Stop action.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, GitPullRequest, ListChecks, TerminalSquare } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger, Text, toast } from "./ui";
import { chatsApi } from "../lib/ipc";
import { queryKeys, useChatFollowThrough } from "../lib/queries";
import { useLinkOpener } from "../lib/link-opener";
import { cn } from "../lib/ui-utils";
import { backgroundJobLabel, backgroundJobPortUrl, type BackgroundJobView } from "../shared/background-jobs";
import {
  MAX_DONE_WHEN_CHECKS,
  MAX_PULL_REQUEST_FOLLOW_NOTICES,
  type ChatFollowThroughV1,
  type DoneWhenCheckView,
  type PullRequestFollowView,
} from "../shared/follow-through";

function elapsed(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function backgroundJobStatus(job: BackgroundJobView, now: number): string {
  if (job.state === "running") return `Running for ${elapsed(job.startedAt, now)}`;
  if (job.state === "stopped") {
    return job.endReason === "output-limit" ? "Stopped: too much output" : "Stopped";
  }
  if (job.origin === "command") return "Ended";
  if (job.signal) return `Ended by ${job.signal}`;
  return job.exitCode === 0 ? "Finished" : `Failed with code ${job.exitCode ?? "unknown"}`;
}

export function doneWhenChipLabel(check: DoneWhenCheckView): string {
  switch (check.state) {
    case "running":
      return `Checking ${check.command}`;
    case "passed":
      return "Check passed";
    case "gave-up":
      return "Check still failing";
    default:
      return `Until ${check.command} passes`;
  }
}

export function doneWhenStatus(check: DoneWhenCheckView): string {
  const count = `${check.checksRun} of ${MAX_DONE_WHEN_CHECKS} checks used`;
  switch (check.state) {
    case "running":
      return `Running now · ${count}`;
    case "passed":
      return `Passed · ${count}`;
    case "gave-up":
      return `Still failing after ${MAX_DONE_WHEN_CHECKS} checks`;
    default:
      return check.checksRun === 0
        ? "Runs after the next answer"
        : `Last run failed${check.lastTimedOut ? " (took over 10 minutes)" : check.lastExitCode !== undefined && check.lastExitCode !== null ? ` with code ${check.lastExitCode}` : ""} · ${count}`;
  }
}

const FOLLOW_END_LABELS: Record<NonNullable<PullRequestFollowView["endedReason"]>, string> = {
  merged: "Merged",
  closed: "Closed",
  quiet: "Stopped: nothing new for two weeks",
  failing: "Stopped: checks kept failing for an hour",
  "notice-limit": `Stopped after ${MAX_PULL_REQUEST_FOLLOW_NOTICES} updates`,
  person: "Stopped",
  agent: "Stopped by the agent",
  "access-changed": "Stopped: folder access changed",
  unavailable: "Stopped: GitHub could not find it",
};

export function pullRequestFollowStatus(follow: PullRequestFollowView): string {
  if (follow.state === "ended") return follow.endedReason ? FOLLOW_END_LABELS[follow.endedReason] : "Stopped";
  const parts = [follow.status ?? "Waiting for the first read", `${follow.noticesSent} of ${MAX_PULL_REQUEST_FOLLOW_NOTICES} updates sent`];
  return parts.join(" · ");
}

function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function ChipTrigger({
  icon: Icon,
  label,
  ariaLabel,
  tone,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  label: string;
  ariaLabel: string;
  tone?: "success" | "failure";
}) {
  return (
    <PopoverTrigger asChild>
      <Button variant="transparent" size="small" className="h-7 shrink-0 gap-1.5 px-2 text-secondary" aria-label={ariaLabel}>
        <Icon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            tone === "success" ? "text-status-green" : tone === "failure" ? "text-status-red" : undefined,
          )}
        />
        <span className="max-w-[12rem] truncate">{label}</span>
      </Button>
    </PopoverTrigger>
  );
}

function JobOutput({ chatId, jobId }: { chatId: string; jobId: string }) {
  const output = useQuery({
    queryKey: ["background-job-output", chatId, jobId],
    queryFn: () => chatsApi.backgroundJobOutput(chatId, jobId),
    refetchInterval: 4_000,
  });
  if (output.isError) {
    return <p className="px-2 py-1 text-small text-tertiary">This job's output is no longer available.</p>;
  }
  if (!output.data) return null;
  const text = output.data.output.trimEnd();
  return (
    <pre className="mx-2 mb-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-well px-2 py-1.5 font-mono text-mini text-secondary">
      {output.data.truncated ? "…\n" : ""}
      {text || "No output yet."}
    </pre>
  );
}

function JobRow({ chatId, job, now, onStop }: { chatId: string; job: BackgroundJobView; now: number; onStop: (job: BackgroundJobView) => void }) {
  const [showOutput, setShowOutput] = React.useState(false);
  const outputId = React.useId();
  const { openLink } = useLinkOpener();
  const ports = job.state === "running" ? (job.ports ?? []) : [];
  return (
    <li className="flex flex-col">
      <div className={cn("flex min-w-0 gap-2 rounded-lg px-2 py-1.5", ports.length ? "items-start" : "items-center")}>
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            ports.length && "mt-[7px]",
            job.state === "running" ? "bg-accent" : job.state === "exited" ? "bg-status-green" : job.state === "failed" ? "bg-status-red" : "bg-quaternary",
          )}
        />
        <div className="min-w-0 flex-1">
          <Text as="p" variant="small-strong" className="truncate">
            {backgroundJobLabel(job)}
          </Text>
          <Text as="p" variant="small" color="tertiary" className="truncate">
            {backgroundJobStatus(job, now)}
          </Text>
          {ports.length ? (
            <div className="-ml-1.5 mt-0.5 flex flex-wrap gap-1">
              {ports.map((port) => (
                <Button
                  key={port}
                  variant="transparent"
                  size="small"
                  className="h-6 gap-1 px-1.5 font-mono text-mini text-accent-text"
                  aria-label={`Open localhost:${port}`}
                  onClick={() => openLink(backgroundJobPortUrl(port), { workspaceId: job.workspaceId })}
                >
                  localhost:{port}
                  <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        <Button
          variant="transparent"
          size="small"
          className="shrink-0 gap-1 px-2"
          aria-expanded={showOutput}
          aria-controls={outputId}
          onClick={() => setShowOutput((value) => !value)}
        >
          Output
          <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform duration-200 ease-standard motion-reduce:transition-none", showOutput && "rotate-180")} />
        </Button>
        {job.state === "running" ? (
          <Button variant="transparent" size="small" className="shrink-0 px-2" onClick={() => onStop(job)}>
            Stop
          </Button>
        ) : null}
      </div>
      <div id={outputId}>{showOutput ? <JobOutput chatId={chatId} jobId={job.id} /> : null}</div>
    </li>
  );
}

function JobsChip({ chatId, jobs, onChanged }: { chatId: string; jobs: BackgroundJobView[]; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false);
  const running = jobs.filter((job) => job.state === "running").length;
  const now = useNow(open);
  const stop = (job: BackgroundJobView) => {
    void chatsApi
      .stopBackgroundJob(chatId, job.id)
      .then(onChanged)
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "The job could not be stopped."));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ChipTrigger
        icon={TerminalSquare}
        label={`${running} in background`}
        ariaLabel={`${running} background ${running === 1 ? "job" : "jobs"} running`}
      />
      <PopoverContent align="start" className="w-[22rem] p-0" aria-label="Background jobs">
        <div className="px-3 pb-1 pt-2.5">
          <Text as="h3" variant="small-strong" color="secondary">
            Background jobs
          </Text>
        </div>
        <ul className="flex max-h-80 flex-col overflow-y-auto px-1.5 pb-2">
          {jobs.map((job) => (
            <JobRow key={job.id} chatId={chatId} job={job} now={now} onStop={stop} />
          ))}
        </ul>
        <p className="border-t border-separator px-3 py-2 text-small text-tertiary">
          Jobs stop when you quit Aiden or turn off folder access.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function FollowChip({ chatId, follows, onChanged }: { chatId: string; follows: PullRequestFollowView[]; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false);
  const { openLink } = useLinkOpener();
  const active = follows.filter((follow) => follow.state === "following");
  const first = active[0];
  const failing = active.some((follow) => /failing|conflict/u.test(follow.status ?? ""));
  const stop = (follow: PullRequestFollowView) => {
    void chatsApi
      .stopFollowingPullRequest(chatId, { host: follow.host, repository: follow.repository, number: follow.number })
      .then(onChanged)
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not stop following."));
  };
  if (!first) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ChipTrigger
        icon={GitPullRequest}
        label={active.length === 1 ? `Following #${first.number}` : `Following ${active.length} PRs`}
        ariaLabel={active.length === 1 ? `Following pull request ${first.number}` : `Following ${active.length} pull requests`}
        tone={failing ? "failure" : undefined}
      />
      <PopoverContent align="start" className="w-[22rem] p-0" aria-label="Followed pull requests">
        <div className="px-3 pb-1 pt-2.5">
          <Text as="h3" variant="small-strong" color="secondary">
            Following
          </Text>
        </div>
        <ul className="flex max-h-80 flex-col px-1.5 pb-2">
          {follows.map((follow) => (
            <li key={`${follow.host}/${follow.repository}#${follow.number}`} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <Text as="p" variant="small-strong" className="truncate">
                  #{follow.number} {follow.title ?? follow.repository}
                </Text>
                <Text as="p" variant="small" color="tertiary" className="truncate">
                  {pullRequestFollowStatus(follow)}
                </Text>
                {follow.problem && follow.state === "following" ? (
                  <Text as="p" variant="small" color="tertiary" className="truncate">
                    {follow.problem}
                  </Text>
                ) : null}
              </div>
              <Button variant="transparent" size="small" iconOnly aria-label={`Open pull request ${follow.number}`} onClick={() => openLink(follow.url)}>
                <ExternalLink aria-hidden="true" />
              </Button>
              {follow.state === "following" ? (
                <Button variant="transparent" size="small" className="shrink-0 px-2" onClick={() => stop(follow)}>
                  Stop
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="border-t border-separator px-3 py-2 text-small text-tertiary">
          Only comments from people who can write to the repository reach the agent.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function CheckChip({ chatId, check, onChanged }: { chatId: string; check: DoneWhenCheckView; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false);
  const settled = check.state === "passed" || check.state === "gave-up";
  const clear = () => {
    void chatsApi
      .clearDoneWhenCheck(chatId)
      .then(() => {
        setOpen(false);
        onChanged();
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "The check could not be cleared."));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ChipTrigger
        icon={ListChecks}
        label={doneWhenChipLabel(check)}
        ariaLabel={`Done when: ${check.command}. ${doneWhenStatus(check)}`}
        tone={check.state === "passed" ? "success" : check.state === "gave-up" ? "failure" : undefined}
      />
      <PopoverContent align="start" className="w-[20rem] p-0" aria-label="Done-when check">
        <div className="flex flex-col gap-1 px-3 pb-2 pt-2.5">
          <Text as="h3" variant="small-strong" color="secondary">
            Keep going until this passes
          </Text>
          <code className="block truncate rounded-lg bg-well px-2 py-1 font-mono text-small text-primary">{check.command}</code>
          <Text as="p" variant="small" color="tertiary">
            {doneWhenStatus(check)}
          </Text>
        </div>
        <div className="flex justify-end border-t border-separator px-2 py-1.5">
          <Button variant="transparent" size="small" className="px-2" onClick={clear}>
            {settled ? "Dismiss" : "Stop checking"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The chips themselves; renders nothing while nothing is going on. */
export function FollowThroughChipList({
  chatId,
  state,
  onChanged,
}: {
  chatId: string;
  state: ChatFollowThroughV1 | undefined;
  onChanged: () => void;
}) {
  if (!state) return null;
  const running = state.jobs.some((job) => job.state === "running");
  const following = state.pullRequests.some((follow) => follow.state === "following");
  if (!running && !following && !state.check) return null;
  return (
    <>
      {running ? (
        <span className="composer-context-chip-enter flex shrink-0">
          <JobsChip chatId={chatId} jobs={state.jobs} onChanged={onChanged} />
        </span>
      ) : null}
      {following ? (
        <span className="composer-context-chip-enter flex shrink-0">
          <FollowChip chatId={chatId} follows={state.pullRequests} onChanged={onChanged} />
        </span>
      ) : null}
      {state.check ? (
        <span className="composer-context-chip-enter flex shrink-0">
          <CheckChip chatId={chatId} check={state.check} onChanged={onChanged} />
        </span>
      ) : null}
    </>
  );
}

export function FollowThroughChips({ chatId }: { chatId: string }) {
  const queryClient = useQueryClient();
  const state = useChatFollowThrough(chatId);
  const onChanged = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.chatFollowThrough(chatId) });
  }, [queryClient, chatId]);
  return <FollowThroughChipList chatId={chatId} state={state.data} onChanged={onChanged} />;
}
