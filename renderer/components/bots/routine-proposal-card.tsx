// A routine the Bot suggested. The Bot never starts recurring work on its own:
// the person adds it here (Add routine) or turns it down (Not now). Once
// answered, on this Mac or a phone, the card settles to one quiet line. A card
// the Bot revised settles as replaced, and the new card follows it.
//
// A link routine's link is shown here once, right after Add routine, the same
// way the Bot's profile shows it; the Bot never sees it.

import * as React from "react";
import { CalendarClock, Check, Copy, Eye, FolderOpen, Link2 } from "lucide-react";
import { Button, toast } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
import {
  BOT_ROUTINE_PROPOSAL_DECLINE_LABELS,
  BOT_ROUTINE_PROPOSAL_DECLINE_REASONS,
  botRoutineProposalWhen,
  type BotRoutineProposalDecision,
  type BotRoutineProposalDeclineReason,
  type BotRoutineProposalEntryData,
  type BotRoutineProposalRespondResult,
  type BotRoutineProposalStatus,
} from "../../shared/bot-routine-proposals";

export const ROUTINE_LINK_DESCRIPTION =
  "Works on your network or Tailscale while this Mac is awake. It is shown only now; New link makes another and stops this one. The Mac's certificate is self-signed, so callers may need to allow that (curl -k).";
export const ROUTINE_LINK_OFF_DESCRIPTION = "Turn on Aiden On The Go in Settings to use this routine's link.";

function ProposalIcon({ proposal }: { proposal: Pick<BotRoutineProposalEntryData, "trigger"> }) {
  if (proposal.trigger?.kind === "webhook") return <Link2 />;
  if (proposal.trigger?.kind === "file_change") return <FolderOpen />;
  if (proposal.trigger?.kind === "watch") return <Eye />;
  return <CalendarClock />;
}

export function RoutineProposalCard({
  proposal,
  status,
  routineId,
  supersededBy,
  onRespond,
  onNewLink,
}: {
  proposal: Pick<BotRoutineProposalEntryData, "name" | "label" | "prompt" | "timezone" | "trigger">;
  status: BotRoutineProposalStatus;
  /** The routine an accepted card added. */
  routineId?: string;
  /** Set when the Bot replaced this card with a revised one. */
  supersededBy?: string;
  /** Resolves with the settled answer, or rejects so the actions come back. */
  onRespond(
    decision: BotRoutineProposalDecision,
    reason?: BotRoutineProposalDeclineReason,
  ): Promise<BotRoutineProposalRespondResult | null>;
  /** A new link for an added link routine; the old one stops working. */
  onNewLink?(routineId: string): Promise<string | null>;
}) {
  // Not now first asks why, in one optional step; Skip answers without a reason.
  const [askingWhy, setAskingWhy] = React.useState(false);
  // The answer shows at once; the live transcript confirms it moments later.
  const [answered, setAnswered] = React.useState<BotRoutineProposalRespondResult | null>(null);
  const [busy, setBusy] = React.useState<BotRoutineProposalDecision | "link" | null>(null);
  // A link routine's link, shown only on this card, only now.
  const [link, setLink] = React.useState<{ value: string | null } | null>(null);
  const settled = status !== "pending" ? status : answered?.status ?? null;
  const when = botRoutineProposalWhen(proposal);
  const addedRoutine = routineId ?? answered?.routineId;

  const respond = async (decision: BotRoutineProposalDecision, reason?: BotRoutineProposalDeclineReason) => {
    if (busy) return;
    setBusy(decision);
    try {
      const result = await onRespond(decision, reason);
      if (result) {
        setAnswered(result);
        if (result.link !== undefined) setLink({ value: result.link });
      }
    } catch {
      // The caller reports the failure; the card stays answerable.
    } finally {
      setBusy(null);
    }
  };

  const newLink = async () => {
    if (busy || !onNewLink || !addedRoutine) return;
    setBusy("link");
    try {
      setLink({ value: await onNewLink(addedRoutine) });
    } catch {
      // The caller reports the failure.
    } finally {
      setBusy(null);
    }
  };

  if (settled === "dismissed" && supersededBy) {
    return (
      <BotNoticeCard label={`Routine suggestion: ${proposal.name}`} icon={<ProposalIcon proposal={proposal} />} title={proposal.name}>
        <p>Replaced by a newer suggestion</p>
      </BotNoticeCard>
    );
  }
  if (settled) {
    const linkRoutine = settled === "accepted" && proposal.trigger?.kind === "webhook";
    const copy = link?.value;
    let actions: React.ReactNode;
    if (linkRoutine && copy) {
      actions = (
        <Button
          size="small"
          variant="filled"
          onClick={() => void navigator.clipboard?.writeText(copy).then(() => toast.success("Link copied."))}
        >
          <Copy /> Copy link
        </Button>
      );
    } else if (linkRoutine && !link && onNewLink && addedRoutine) {
      actions = (
        <Button size="small" variant="filled" disabled={busy !== null} onClick={() => void newLink()}>
          {busy === "link" ? "Making…" : "New link"}
        </Button>
      );
    }
    return (
      <BotNoticeCard
        label={`Routine suggestion: ${proposal.name}`}
        icon={settled === "accepted" ? <Check /> : <ProposalIcon proposal={proposal} />}
        iconTone={settled === "accepted" ? "green" : "neutral"}
        title={proposal.name}
        actions={actions}
      >
        <p>{settled === "accepted" ? `Added ✓ · ${when}` : "Not added"}</p>
        {linkRoutine && link ? (
          <p className="mt-0.5">{link.value ? ROUTINE_LINK_DESCRIPTION : ROUTINE_LINK_OFF_DESCRIPTION}</p>
        ) : linkRoutine && actions ? (
          <p className="mt-0.5">Its link is shown once. New link makes one here and stops any earlier one.</p>
        ) : null}
      </BotNoticeCard>
    );
  }
  if (askingWhy) {
    return (
      <BotNoticeCard
        label={`Routine suggestion: ${proposal.name}`}
        icon={<ProposalIcon proposal={proposal} />}
        title="Why not?"
        actions={
          <>
            {BOT_ROUTINE_PROPOSAL_DECLINE_REASONS.map((reason) => (
              <Button
                key={reason}
                variant="filled"
                size="small"
                disabled={busy !== null}
                onClick={() => void respond("dismiss", reason)}
              >
                {BOT_ROUTINE_PROPOSAL_DECLINE_LABELS[reason]}
              </Button>
            ))}
            <Button variant="transparent" size="small" disabled={busy !== null} onClick={() => void respond("dismiss")}>
              Skip
            </Button>
          </>
        }
      >
        <p>Optional. It helps the Bot suggest better routines.</p>
      </BotNoticeCard>
    );
  }
  return (
    <BotNoticeCard
      label={`Routine suggestion: ${proposal.name}`}
      icon={<ProposalIcon proposal={proposal} />}
      title="Add a routine?"
      actions={
        <>
          <Button variant="transparent" size="small" disabled={busy !== null} onClick={() => setAskingWhy(true)}>
            Not now
          </Button>
          <Button variant="accent" size="small" disabled={busy !== null} onClick={() => void respond("accept")}>
            {busy === "accept" ? "Adding…" : "Add routine"}
          </Button>
        </>
      }
    >
      <p className="text-primary">{`${proposal.name} · ${when}`}</p>
      <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap">{proposal.prompt}</p>
    </BotNoticeCard>
  );
}
