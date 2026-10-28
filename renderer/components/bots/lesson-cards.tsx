// What a Bot learned, in its chat (spec 2026-10-27 §7): a lesson from a
// routine's runs waits for Keep this; a correction or a memory tidy shows as
// one quiet line with Undo.

import * as React from "react";
import { Check, Lightbulb } from "lucide-react";
import { Button, Text } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
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
    return (
      <BotNoticeCard label={`Lesson: ${lesson.lesson}`} icon={settled === "active" ? <Check /> : <Lightbulb />} iconTone={settled === "active" ? "green" : "neutral"} title={lesson.routineName ?? "Lesson"}>
        <p>{settled === "active" ? "Kept ✓" : "Not kept"}</p>
      </BotNoticeCard>
    );
  }
  return (
    <BotNoticeCard
      label={`Lesson: ${lesson.lesson}`}
      icon={<Lightbulb />}
      title={title}
      actions={
        <>
          <Button variant="transparent" size="small" disabled={busy} onClick={() => void respond("dismiss")}>Not now</Button>
          <Button variant="accent" size="small" disabled={busy} onClick={() => void respond("keep")}>Keep this</Button>
        </>
      }
    >
      <p className="text-primary">{lesson.lesson}</p>
      {lesson.runs ? <p className="mt-0.5">{`Based on ${lesson.runs} recent run${lesson.runs === 1 ? "" : "s"}`}</p> : null}
    </BotNoticeCard>
  );
}

/** "Learned: … · Undo" or "Tidied memory · Undo": one quiet line. */
export function LearnedLine({ text, undone, onUndo }: { text: string; undone: boolean; onUndo(): Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex items-center justify-center gap-1.5 py-1">
      <Text as="span" variant="small" color="tertiary">{undone || done ? `${text} (undone)` : text}</Text>
      {undone || done ? null : (
        <Button
          variant="transparent"
          size="small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onUndo().then(() => setDone(true), () => undefined).finally(() => setBusy(false));
          }}
        >
          Undo
        </Button>
      )}
    </div>
  );
}
