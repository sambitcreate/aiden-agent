import { Badge, Text } from "../components/ui";
import type { AttemptSnapshot } from "../shared/images/run-types";
import { attemptDetail, attemptStatus } from "./run-view-core";

export function AttemptBadge({ attempt }: { attempt: AttemptSnapshot }) {
  const status = attemptStatus(attempt);
  const detail = attemptDetail(attempt);
  return (
    <div className="flex min-w-0 flex-col gap-1" role="status">
      <Badge color={status.tone}>{status.label}</Badge>
      {detail ? <Text variant="small" color="secondary">{detail}</Text> : null}
    </div>
  );
}
