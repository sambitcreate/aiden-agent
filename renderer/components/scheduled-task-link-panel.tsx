import * as React from "react";
import { Copy, Link2 } from "lucide-react";
import { scheduleApi } from "../lib/ipc";
import { Button, Callout, Text } from "./ui";

type LinkState = Awaited<ReturnType<typeof scheduleApi.triggerLinkState>>;

const OUTCOME_LABELS: Record<string, string> = {
  ran: "Ran the task",
  batched: "Waiting to run",
  duplicate: "Repeat, ignored",
  daily_limit: "Over today's 48 runs",
  dropped: "Chat stayed busy, dropped",
  filtered: "Didn't match, ignored",
  bad_signature: "Bad signature, refused",
  invalid: "Not valid JSON, refused",
  off: "Task was off",
};

/**
 * A link task's link and recent calls. The link (and a signed link's secret)
 * appears only right after Create or Rotate, once; main never hands it out again.
 */
export function ScheduledTaskLinkPanel({
  taskId,
  busy,
  recentCalls,
}: {
  taskId: string;
  busy?: boolean;
  /** For previews and tests; otherwise read from main. */
  recentCalls?: LinkState;
}) {
  const [state, setState] = React.useState<LinkState | undefined>(recentCalls);
  const [revealed, setRevealed] = React.useState<{ url: string; secret?: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    if (recentCalls) return;
    let active = true;
    const load = () =>
      void scheduleApi
        .triggerLinkState(taskId)
        .then((next) => {
          if (active) setState(next);
        })
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [recentCalls, taskId]);

  const rotate = async () => {
    setWorking(true);
    setError(null);
    try {
      setRevealed(await scheduleApi.rotateTriggerLink(taskId));
      setState(await scheduleApi.triggerLinkState(taskId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't make a link.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="mt-4 rounded-control bg-background px-3 py-2.5" aria-label="Task link">
      <div className="flex items-center gap-2">
        <Link2 className="size-4 shrink-0 text-secondary" aria-hidden="true" />
        <Text variant="small-strong" className="min-w-0 flex-1">
          Link
        </Text>
        <Button
          size="small"
          variant="transparent"
          disabled={busy || working}
          onClick={() => void rotate()}
        >
          {state?.hasLink ? "Rotate link" : "Create link"}
        </Button>
      </div>
      {revealed ? (
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-2" role="status">
          <Text variant="small" color="secondary">
            Copy it now: Aiden won't show it again. Rotate to get a new one.
          </Text>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-control bg-well px-2 py-1 text-small">
              {revealed.url}
            </code>
            <Button
              size="small"
              variant="transparent"
              iconOnly
              aria-label="Copy link"
              onClick={() => void navigator.clipboard?.writeText(revealed.url)}
            >
              <Copy className="size-4" />
            </Button>
          </div>
          {revealed.secret ? (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-control bg-well px-2 py-1 text-small">
                {revealed.secret}
              </code>
              <Button
                size="small"
                variant="transparent"
                iconOnly
                aria-label="Copy signing secret"
                onClick={() => void navigator.clipboard?.writeText(revealed.secret!)}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <Text as="p" variant="small" color="secondary" className="mt-1">
          {state?.hasLink
            ? state.needsNewLink
              ? "The signature header changed. Rotate the link to get its new signing secret; until then signed calls are refused."
              : state.listenerOn
                ? "Calls run this task. The link stays private to you."
                : "Turn on Aiden On The Go so calls can reach this computer."
            : "Make a private link that runs this task when something calls it."}
        </Text>
      )}
      {error ? (
        <Callout className="mt-2" color="red">
          <Text variant="small">{error}</Text>
        </Callout>
      ) : null}
      {state?.log.length ? (
        <div className="mt-3">
          <Text variant="small" color="tertiary">
            Recent calls
          </Text>
          <ol className="mt-1 grid gap-1">
            {state.log.slice(0, 10).map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="text-small">
                <span className="text-primary">
                  {OUTCOME_LABELS[entry.outcome] ?? entry.outcome}
                </span>
                {entry.repeats ? (
                  <span className="text-tertiary"> · {entry.repeats + 1} calls</span>
                ) : null}
                <span className="text-tertiary"> · {new Date(entry.at).toLocaleString()}</span>
                {entry.preview ? (
                  <span className="block truncate text-tertiary">{entry.preview}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
