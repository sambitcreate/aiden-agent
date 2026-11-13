// A skill the Bot proposed, or one found in its folder, as a suggestion card.
// Nothing loads until the person presses Add; once answered the card settles
// to a receipt line.

import * as React from "react";
import { Check, Sparkles } from "lucide-react";
import { ReceiptLine } from "./receipt-line";
import { SuggestionCard } from "./suggestion-card";
import type { BotSkillProposalEntryData, BotSkillProposalStatus } from "../../shared/bot-skill-proposals";

function DiffLines({ text }: { text: string }) {
  // Every line: Add approves exactly this text, so none of it may be hidden.
  const lines = text.split("\n");
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
    return settled === "added" ? (
      <ReceiptLine icon={<Check className="text-status-green" />} text={`Added skill: ${proposal.name}`} />
    ) : (
      <ReceiptLine icon={<Sparkles />} text={`Not added: ${proposal.name}`} />
    );
  }
  return (
    <SuggestionCard
      label={label}
      icon={<Sparkles />}
      title={proposal.origin === "folder" ? "Use this skill?" : proposal.update ? "Update a skill?" : "Add a skill?"}
      busy={busy !== null}
      adding={busy === "add"}
      onAdd={() => void respond("add")}
      onNotNow={() => void respond("dismiss")}
    >
      <p className="text-primary">{`${proposal.name} · ${proposal.description}`}</p>
      {proposal.reason ? <p className="mt-0.5">{proposal.reason}</p> : null}
      {proposal.origin === "folder" ? <p className="mt-0.5">Found in this Bot’s folder. It won’t be used until you say so.</p> : null}
      <DiffLines text={proposal.preview} />
    </SuggestionCard>
  );
}
