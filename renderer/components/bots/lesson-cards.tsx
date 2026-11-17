// What a Bot learned, in its chat (spec 2026-10-27 §7): a lesson from a
// routine's runs is a suggestion card (Not now / Add); a correction or a
// memory tidy is a receipt line with Undo.

import * as React from "react";
import { Check, Lightbulb } from "lucide-react";
import { ReceiptLine } from "./receipt-line";
import { SuggestionCard } from "./suggestion-card";
import type { BotLessonCardData } from "../../shared/bot-lessons";

export function LessonProposalCard({
  lesson,
  status,
  onRespond,
}: {
  lesson: BotLessonCardData;
  status: "pending" | "active" | "dismissed" | "retired";
  onRespond(decision: "keep" | "dismiss"): Promise<"active" | "dismissed" | null>;
}) {
  const [answered, setAnswered] = React.useState<"active" | "dismissed" | null>(null);
  const [busy, setBusy] = React.useState(false);
  const settled = status !== "pending" ? status : answered;
  const title = lesson.routineName ? `I learned something about ${lesson.routineName}` : "I learned something";
  const respond = async (decision: "keep" | "dismiss") => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await onRespond(decision);
      if (result) setAnswered(result);
    } catch {
      // The caller reports it; the card stays answerable.
    } finally {
      setBusy(false);
    }
  };
  if (settled) {
    return settled === "active" ? (
      <ReceiptLine icon={<Check className="text-status-green" />} text={`Added lesson: ${lesson.lesson}`} />
    ) : (
      <ReceiptLine icon={<Lightbulb />} text={`Not added: ${lesson.lesson}`} />
    );
  }
  return (
    <SuggestionCard
      label={`Lesson: ${lesson.lesson}`}
      icon={<Lightbulb />}
      title={title}
      busy={busy}
      adding={false}
      onAdd={() => void respond("keep")}
      onNotNow={() => void respond("dismiss")}
    >
      <p className="text-primary">{lesson.lesson}</p>
      {lesson.runs ? <p className="mt-0.5">{`Based on ${lesson.runs} recent run${lesson.runs === 1 ? "" : "s"}`}</p> : null}
    </SuggestionCard>
  );
}

/** "Learned: … · Undo" or "Tidied memory · Undo": a receipt line. */
export function LearnedLine({ text, undone, onUndo }: { text: string; undone: boolean; onUndo(): Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  return (
    <ReceiptLine
      text={undone || done ? `${text} (undone)` : text}
      actions={
        undone || done
          ? []
          : [
              {
                label: "Undo",
                disabled: busy,
                onClick: () => {
                  setBusy(true);
                  void onUndo().then(() => setDone(true), () => undefined).finally(() => setBusy(false));
                },
              },
            ]
      }
    />
  );
}
