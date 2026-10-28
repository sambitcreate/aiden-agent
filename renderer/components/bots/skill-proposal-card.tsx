// A skill the Bot proposed, or one found in its folder. Nothing loads until the
// person presses Add skill; once answered the card settles to one quiet line.

import * as React from "react";
import { Check, Sparkles } from "lucide-react";
import { Button } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
import type { BotSkillProposalEntryData, BotSkillProposalStatus } from "../../shared/bot-skill-proposals";

function DiffLines({ text }: { text: string }) {
  const lines = text.split("\n").slice(0, 80);
  return (
    <pre className="mt-2 max-h-56 overflow-auto rounded-control bg-control p-2 text-mini leading-relaxed text-secondary" aria-label="What would load">
      {lines.map((line, index) => (
        <span
          key={index}
          className={line.startsWith("+") && !line.startsWith("+++") ? "text-status-green" : line.startsWith("-") && !line.startsWith("---") ? "text-status-red" : undefined}
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export function SkillProposalCard({
  proposal,
  status,
  onRespond,
}: {
  proposal: BotSkillProposalEntryData;
  status: BotSkillProposalStatus;
  onRespond(decision: "add" | "dismiss"): Promise<"added" | "dismissed" | null>;
}) {
  const [answered, setAnswered] = React.useState<"added" | "dismissed" | null>(null);
  const [busy, setBusy] = React.useState<"add" | "dismiss" | null>(null);
  const settled = status !== "pending" ? status : answered;
  const label = `Skill: ${proposal.name}`;
  const respond = async (decision: "add" | "dismiss") => {
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
      <BotNoticeCard label={label} icon={settled === "added" ? <Check /> : <Sparkles />} iconTone={settled === "added" ? "green" : "neutral"} title={proposal.name}>
        <p>{settled === "added" ? "Added ✓" : "Not added"}</p>
      </BotNoticeCard>
    );
  }
  return (
    <BotNoticeCard
      label={label}
      icon={<Sparkles />}
      title={proposal.origin === "folder" ? "Use this skill?" : proposal.update ? "Update a skill?" : "Add a skill?"}
      actions={
        <>
          <Button variant="transparent" size="small" disabled={busy !== null} onClick={() => void respond("dismiss")}>
            Not now
          </Button>
          <Button variant="accent" size="small" disabled={busy !== null} onClick={() => void respond("add")}>
            {busy === "add" ? "Adding…" : proposal.origin === "folder" ? "Use skill" : "Add skill"}
          </Button>
        </>
      }
    >
      <p className="text-primary">{`${proposal.name} · ${proposal.description}`}</p>
      {proposal.reason ? <p className="mt-0.5">{proposal.reason}</p> : null}
      {proposal.origin === "folder" ? <p className="mt-0.5">Found in this Bot’s folder. It won’t be used until you say so.</p> : null}
      <DiffLines text={proposal.preview} />
    </BotNoticeCard>
  );
}
