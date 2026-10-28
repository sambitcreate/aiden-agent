// A "Needs you" issue the host raised for this Bot (plan F2): what happened,
// why it matters in one line, and up to two actions. Settled issues keep one
// quiet line, like a routine suggestion, so the transcript never grows a card
// the person can no longer answer.

import * as React from "react";
import { CircleAlert, Clock, Pause } from "lucide-react";
import { Button } from "../ui";
import { BotNoticeCard, type BotNoticeTone } from "./bot-notice-card";
import type { BotIssue, BotIssueAction, BotIssueKind, BotIssueResolution } from "../../shared/bot-issues";

const KIND_LOOK: Record<BotIssueKind, { icon: React.ReactNode; tone: BotNoticeTone }> = {
  preflight_failed: { icon: <CircleAlert />, tone: "warning" },
  routine_failed: { icon: <CircleAlert />, tone: "red" },
  routine_paused: { icon: <Pause />, tone: "neutral" },
  run_stalled: { icon: <Clock />, tone: "warning" },
};

const RESOLVED_LINE: Record<BotIssueResolution, string> = {
  fixed: "Fixed",
  dismissed: "Dismissed",
  superseded: "Superseded",
};

type SettingsSection = Extract<BotIssueAction, { kind: "open_settings" }>["section"];

const SETTINGS_LABEL: Record<SettingsSection, string> = {
  model: "Choose a model",
  access: "Review access",
  connections: "Open connections",
  providers: "Open Providers",
};

/** The button's words; the shared Button primitive keeps its focus ring. */
export function botIssueActionLabel(action: BotIssueAction): string {
  switch (action.kind) {
    case "open_settings":
      return SETTINGS_LABEL[action.section];
    case "resume_routine":
      return "Resume routine";
    case "stop_run":
      return "Stop run";
    case "keep_waiting":
      return "Keep waiting";
    case "open_chat":
      return "Open chat";
  }
}

function actionKey(action: BotIssueAction): string {
  switch (action.kind) {
    case "resume_routine":
      return `resume:${action.routineId}`;
    case "open_settings":
      return `settings:${action.section}`;
    default:
      return action.kind;
  }
}

export function BotIssueCard({
  issue,
  status,
  onAct,
}: {
  issue: Pick<BotIssue, "kind" | "title" | "body" | "actions">;
  status: "open" | BotIssueResolution;
  /** Carries out one offered action; rejects so the buttons come back. */
  onAct(action: BotIssueAction): Promise<void> | void;
}) {
  // The answer shows at once; the live transcript confirms it moments later.
  const [busy, setBusy] = React.useState<string | null>(null);
  const look = KIND_LOOK[issue.kind];

  if (status !== "open") {
    return (
      <BotNoticeCard
        label={`${issue.title} · ${RESOLVED_LINE[status]}`}
        icon={look.icon}
        iconTone="neutral"
        title={issue.title}
      >
        <p>{RESOLVED_LINE[status]}</p>
      </BotNoticeCard>
    );
  }

  const act = async (action: BotIssueAction) => {
    if (busy !== null) return;
    setBusy(actionKey(action));
    try {
      await onAct(action);
    } catch {
      // The caller reports the failure; the card stays answerable.
    } finally {
      setBusy(null);
    }
  };

  return (
    <BotNoticeCard
      label={issue.title}
      icon={look.icon}
      iconTone={look.tone}
      title={issue.title}
      actions={
        issue.actions.length > 0 ? (
          <>
            {issue.actions.map((action, index) => (
              <Button
                key={actionKey(action)}
                variant={index === issue.actions.length - 1 ? "accent" : "transparent"}
                size="small"
                disabled={busy !== null}
                onClick={() => void act(action)}
              >
                {busy === actionKey(action) ? "Working…" : botIssueActionLabel(action)}
              </Button>
            ))}
          </>
        ) : undefined
      }
    >
      {issue.body ? <p className="whitespace-pre-wrap">{issue.body}</p> : null}
    </BotNoticeCard>
  );
}
