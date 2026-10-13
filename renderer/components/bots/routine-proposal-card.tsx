// A routine the Bot suggested. The Bot never starts recurring work on its own:
// the person adds it here (Add routine) or turns it down (Not now). Once
// answered, on this Mac or a phone, the card settles to one quiet line.

import * as React from "react";
import { CalendarClock, Check } from "lucide-react";
import { Button } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
import type {
  BotRoutineProposalDecision,
  BotRoutineProposalEntryData,
  BotRoutineProposalStatus,
} from "../../shared/bot-routine-proposals";

export function RoutineProposalCard({
  proposal,
  status,
  onRespond,
}: {
  proposal: Pick<BotRoutineProposalEntryData, "name" | "label" | "prompt">;
  status: BotRoutineProposalStatus;
  /** Resolves with the settled status, or rejects so the actions come back. */
  onRespond(decision: BotRoutineProposalDecision): Promise<Exclude<BotRoutineProposalStatus, "pending"> | null>;
}) {
  // The answer shows at once; the live transcript confirms it moments later.
  const [answered, setAnswered] = React.useState<Exclude<BotRoutineProposalStatus, "pending"> | null>(null);
  const [busy, setBusy] = React.useState<BotRoutineProposalDecision | null>(null);
  const settled = status !== "pending" ? status : answered;

  const respond = async (decision: BotRoutineProposalDecision) => {
    if (busy) return;
    setBusy(decision);
    try {
      const result = await onRespond(decision);
      if (result) setAnswered(result);
    } catch {
      // The caller reports the failure; the card stays answerable.
    } finally {
      setBusy(null);
    }
  };

  if (settled) {
    return (
      <BotNoticeCard
        label={`Routine suggestion: ${proposal.name}`}
        icon={settled === "accepted" ? <Check /> : <CalendarClock />}
        iconTone={settled === "accepted" ? "green" : "neutral"}
        title={proposal.name}
      >
        <p>{settled === "accepted" ? `Added ✓ · ${proposal.label}` : "Not added"}</p>
      </BotNoticeCard>
    );
  }
  return (
    <BotNoticeCard
      label={`Routine suggestion: ${proposal.name}`}
      icon={<CalendarClock />}
      title="Add a routine?"
      actions={
        <>
          <Button variant="transparent" size="small" disabled={busy !== null} onClick={() => void respond("dismiss")}>
            Not now
          </Button>
          <Button variant="accent" size="small" disabled={busy !== null} onClick={() => void respond("accept")}>
            {busy === "accept" ? "Adding…" : "Add routine"}
          </Button>
        </>
      }
    >
      <p className="text-primary">{`${proposal.name} · ${proposal.label}`}</p>
      <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap">{proposal.prompt}</p>
    </BotNoticeCard>
  );
}
