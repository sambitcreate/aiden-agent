// Chips in the composer's context bar for what a chat has going on after an
// answer: background jobs ("2 in background"), followed pull requests
// ("Following #12") and the agent's check-backs ("Checking back at 3:10 PM").
// Each opens a small popover with its state and a Stop or Cancel action. A
// `/until` check is a keep-going goal and shows in the goal bar instead.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, ChevronDown, ExternalLink, GitPullRequest, TerminalSquare } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger, Text, toast } from "./ui";
import { chatsApi } from "../lib/ipc";
import { queryKeys, useChatFollowThrough } from "../lib/queries";
import { useLinkOpener } from "../lib/link-opener";
import { useNow } from "../lib/use-now";
import { cn } from "../lib/ui-utils";
import { backgroundJobLabel, backgroundJobPortUrl, type BackgroundJobView } from "../shared/background-jobs";
import { checkBackWhen, type CheckBackView } from "../shared/check-backs";
import {
  MAX_COMMENT_ONLY_FOLLOW_UPDATES,
  type ChatFollowThroughV1,
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
    if (job.endReason === "output-limit") return "Stopped: too much output";
    if (job.endReason === "chat-settled") return "Stopped after the chat went quiet";
    return "Stopped";
  }
  if (job.origin === "command") return "Ended";
  if (job.signal) return `Ended by ${job.signal}`;
  return job.exitCode === 0 ? "Finished" : `Failed with code ${job.exitCode ?? "unknown"}`;
}

const FOLLOW_END_LABELS: Record<NonNullable<PullRequestFollowView["endedReason"]>, string> = {
  merged: "Merged",
  closed: "Closed",
  quiet: "Stopped: nothing new for two weeks",
  failing: "Stopped: checks kept failing for an hour",
  "notice-limit": "Stopped after 10 updates",
  "comment-limit": `Stopped after ${MAX_COMMENT_ONLY_FOLLOW_UPDATES} comment-only updates in a row`,
  person: "Stopped",
  agent: "Stopped by the agent",
  "access-changed": "Stopped: folder access changed",
  unavailable: "Stopped: GitHub could not find it",
};

export function pullRequestFollowStatus(follow: PullRequestFollowView): string {
  if (follow.state === "ended") return follow.endedReason ? FOLLOW_END_LABELS[follow.endedReason] : "Stopped";
  const parts = [
    follow.status ?? "Waiting for the first read",
    `${follow.noticesSent} ${follow.noticesSent === 1 ? "update" : "updates"} sent`,
  ];
  return parts.join(" · ");
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
  const now = useNow(open, 15_000);
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
  // Opening the list is a good moment to look again: the person wants news.
  const toggle = (next: boolean) => {
    setOpen(next);
    if (next) void chatsApi.nudgeFollowedPullRequests(chatId).catch(() => undefined);
  };
  // Back online after a drop: followed pull requests may have moved meanwhile.
  React.useEffect(() => {
    const online = () => void chatsApi.nudgeFollowedPullRequests().catch(() => undefined);
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);
  if (!first) return null;
  return (
    <Popover open={open} onOpenChange={toggle}>
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
          Only comments from people who can write to the repository and from review bots reach the agent.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** "Checking back at 3:10 PM", and how many more wait after it. */
export function checkBackChipLabel(checkBacks: readonly CheckBackView[], now: number): string {
  const [first] = checkBacks;
  if (!first) return "";
  const more = checkBacks.length - 1;
  return `Checking back ${checkBackWhen(first.fireAt, now)}${more > 0 ? ` +${more}` : ""}`;
}

function CheckBackChip({ chatId, checkBacks, onChanged }: { chatId: string; checkBacks: CheckBackView[]; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [cancelling, setCancelling] = React.useState<ReadonlySet<string>>(() => new Set());
  const now = useNow(open, 15_000);
  // Hide a cancelled row at once; it comes back if the cancel fails.
  const visible = checkBacks.filter((checkBack) => !cancelling.has(checkBack.id));
  const cancel = (checkBack: CheckBackView) => {
    setCancelling((current) => new Set(current).add(checkBack.id));
    void chatsApi
      .cancelCheckBack(chatId, checkBack.id)
      .then(onChanged)
      .catch((error: unknown) => {
        setCancelling((current) => {
          const next = new Set(current);
          next.delete(checkBack.id);
          return next;
        });
        toast.error(error instanceof Error ? error.message : "The check-back could not be cancelled.");
      });
  };
  if (!visible.length) return null;
  const label = checkBackChipLabel(visible, now);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ChipTrigger
        icon={AlarmClock}
        label={label}
        ariaLabel={visible.length === 1 ? label : `${visible.length} check-backs pending, next ${checkBackWhen(visible[0]!.fireAt, now)}`}
      />
      <PopoverContent align="start" className="w-[22rem] p-0" aria-label="Check-backs">
        <div className="px-3 pb-1 pt-2.5">
          <Text as="h3" variant="small-strong" color="secondary">
            Checking back
          </Text>
        </div>
        <ul className="flex max-h-80 flex-col overflow-y-auto px-1.5 pb-2">
          {visible.map((checkBack) => (
            <li key={checkBack.id} className="flex min-w-0 items-start gap-2 rounded-lg px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <Text as="p" variant="small-strong" className="truncate">
                  {checkBackWhen(checkBack.fireAt, now).replace(/^./u, (first) => first.toUpperCase())}
                </Text>
                <Text as="p" variant="small" color="tertiary" className="line-clamp-2 break-words">
                  {checkBack.note}
                </Text>
              </div>
              <Button
                variant="transparent"
                size="small"
                className="shrink-0 px-2"
                aria-label={`Cancel check-back ${checkBackWhen(checkBack.fireAt, now)}`}
                onClick={() => cancel(checkBack)}
              >
                Cancel
              </Button>
            </li>
          ))}
        </ul>
        <p className="border-t border-separator px-3 py-2 text-small text-tertiary">
          At each time Aiden posts the note here and answers it. Stopping a reply keeps these.
        </p>
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
  const checkingBack = state.checkBacks.length > 0;
  if (!running && !following && !checkingBack) return null;
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
      {checkingBack ? (
        <span className="composer-context-chip-enter flex shrink-0">
          <CheckBackChip chatId={chatId} checkBacks={state.checkBacks} onChanged={onChanged} />
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
