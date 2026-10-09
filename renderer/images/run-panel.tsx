import { Button, Text } from "../components/ui";
import type { RunSnapshot } from "../shared/images/run-types";
import { AttemptBadge } from "./attempt-badge";
import { RETRY_OPTIONS, costLabel, runHeadline, type RetryScopeKind } from "./run-view-core";

const RETRYABLE = new Set(["failed", "cancelled", "interrupted"]);

export function RunPanel({
  snapshot,
  nodeTitles,
  onStop,
  onRetry,
}: {
  snapshot: RunSnapshot | null;
  nodeTitles: ReadonlyMap<string, string>;
  onStop(): void;
  onRetry(nodeId: string, kind: RetryScopeKind): void;
}) {
  if (!snapshot) return null;
  const running = snapshot.run.state === "running";
  const requests = snapshot.attempts.filter((attempt) => attempt.provider !== undefined);
  return (
    <section aria-label="Run" className="image-run-panel flex flex-col gap-3 p-3">
      <header className="flex items-center gap-2">
        <Text variant="strong" className="min-w-0 flex-1" role="status">
          {runHeadline(snapshot.run)}
        </Text>
        {running ? (
          <Button size="small" variant="muted" onClick={onStop}>
            Stop
          </Button>
        ) : null}
      </header>
      <ul className="flex flex-col gap-3" aria-label="Image requests in this run">
        {requests.map((attempt) => {
          const cost = costLabel(attempt);
          return (
            <li key={`${attempt.nodeId}:${attempt.variant}`} className="flex flex-col gap-1">
              <Text truncate>{nodeTitles.get(attempt.nodeId) ?? "Generate Image"}</Text>
              <AttemptBadge attempt={attempt} />
              {cost ? <Text variant="small" color="secondary">{cost}</Text> : null}
              {!running && RETRYABLE.has(attempt.state) ? (
                <div className="flex flex-wrap gap-1">
                  {RETRY_OPTIONS.map((option) => (
                    <Button key={option.kind} size="small" variant="transparent" title={option.hint} onClick={() => onRetry(attempt.nodeId, option.kind)}>
                      {option.label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
