// Advanced → Chat activity (spec §7): how much a Bot chat shows while the Bot
// works, and what its status line says, each choice with a looping preview
// built from the real status line and recap. Choices save as they are picked.
// Previews pause off-screen; under Reduce Motion they hold a still frame with
// Play. Radio rows show selection with the radio and background, no borders.

import * as React from "react";
import { Pause, Play } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Field, FieldSet, Label, RadioGroup, RadioGroupItem, toast } from "../../components/ui";
import { prefersReducedMotion } from "../../lib/appearance-runtime";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { BotToolPhase } from "../../shared/bot-activity";
import {
  resolveBotChatActivity,
  type BotChatActivity,
  type BotChatActivityLevel,
  type BotChatActivityWording,
  type BotDefinition,
} from "../../shared/bots";
import type { BotLiveActivity } from "../../shared/bot-live";
import { BotActivityRecap } from "./bot-activity-recap";
import type { BotRecapStep } from "./bot-activity-steps";
import { updateBotIdentity } from "./bot-identity";
import { BotPageShell } from "./bot-page-shell";
import { BotStatusLine } from "./bot-status-line";

export const BOT_CHAT_ACTIVITY_LEVEL_LABELS: Record<BotChatActivityLevel, string> = {
  quiet: "Quiet",
  summary: "Summary",
  detailed: "Detailed",
};

export const BOT_CHAT_ACTIVITY_WORDING_LABELS: Record<BotChatActivityWording, string> = {
  follows: "Follows the work",
  thinking: "Always “Thinking”",
};

/** Advanced's trailing value: "Quiet · Follows the work". */
export function botChatActivitySummary(value?: BotChatActivity): string {
  const resolved = resolveBotChatActivity(value);
  return `${BOT_CHAT_ACTIVITY_LEVEL_LABELS[resolved.level]} · ${BOT_CHAT_ACTIVITY_WORDING_LABELS[resolved.wording]}`;
}

const LEVEL_CHOICES: ReadonlyArray<{ value: BotChatActivityLevel; description: string; recommended?: true }> = [
  { value: "quiet", description: "One line that says what it’s doing.", recommended: true },
  { value: "summary", description: "Adds a short recap above each reply." },
  { value: "detailed", description: "Also shows its last few steps while it works." },
];

const WORDING_CHOICES: ReadonlyArray<{ value: BotChatActivityWording; description: string }> = [
  { value: "follows", description: "Says what it’s doing, like Reading or Searching the web." },
  { value: "thinking", description: "One calm word, whatever it’s doing." },
];

const PREVIEW_STEPS: readonly BotRecapStep[] = [
  { id: "p1", kind: "reading", label: "Read 1 file", detail: "recipes.md", status: "ok" },
  { id: "p2", kind: "searching", label: "Searched the web", detail: "quick weeknight dinners", status: "ok" },
  { id: "p3", kind: "editing", label: "Edited 1 file", detail: "meal-plan.md", status: "ok" },
];

/** One scripted turn: think, read, search, edit, reply. `step` indexes `PREVIEW_STEPS`. */
const PREVIEW_FRAMES: ReadonlyArray<{ ms: number; phase?: "thinking" | BotToolPhase; step?: number }> = [
  { ms: 1_400, phase: "thinking" },
  { ms: 1_600, phase: "reading", step: 0 },
  { ms: 1_600, phase: "searching", step: 1 },
  { ms: 1_400, phase: "editing", step: 2 },
  { ms: 2_800 },
];
/** Reduce Motion's still frame: mid-turn, with a step and the line showing. */
const STILL_FRAME = 2;
const PREVIEW_STARTED_AT = 0;

export function BotChatActivityPreview({
  level,
  wording,
  label,
  name,
}: {
  level: BotChatActivityLevel;
  wording: BotChatActivityWording;
  /** For the Play control's name: "Play preview: Detailed". */
  label: string;
  /** A stable hook for this preview, such as `level-quiet`. */
  name: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [reduced] = React.useState(() => prefersReducedMotion());
  const [playing, setPlaying] = React.useState(!reduced);
  const [visible, setVisible] = React.useState(true);
  const [tick, setTick] = React.useState(reduced ? STILL_FRAME : 0);

  React.useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (latest) setVisible(latest.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!playing || !visible) return;
    const frame = PREVIEW_FRAMES[tick % PREVIEW_FRAMES.length]!;
    const timer = window.setTimeout(() => setTick((value) => value + 1), frame.ms);
    return () => window.clearTimeout(timer);
  }, [playing, visible, tick]);

  const frame = PREVIEW_FRAMES[tick % PREVIEW_FRAMES.length]!;
  const loop = Math.floor(tick / PREVIEW_FRAMES.length);
  const replied = frame.phase === undefined;
  const done = replied ? PREVIEW_STEPS.length : (frame.step ?? 0);
  const current = frame.step !== undefined ? PREVIEW_STEPS[frame.step] : undefined;
  const steps: BotRecapStep[] = [
    ...PREVIEW_STEPS.slice(0, done),
    ...(current ? [{ ...current, status: "running" as const }] : []),
  ];
  const showRecap = level === "detailed" ? steps.length > 0 : level === "summary" && replied;
  const activity: BotLiveActivity | null = replied
    ? null
    : {
        phase: frame.phase!,
        startedAt: PREVIEW_STARTED_AT,
        ...(current
          ? { step: { kind: current.kind, label: current.label, ...(current.detail ? { detail: current.detail } : {}) } }
          : {}),
      };

  return (
    <div ref={ref} className="flex flex-col gap-2" data-bot-chat-activity-preview={name}>
      <div
        aria-hidden="true"
        inert
        className="pointer-events-none flex flex-col gap-2 rounded-control bg-background p-3 text-small"
      >
        <div className="ml-auto max-w-[80%] rounded-card bg-control px-3 py-1.5 text-primary">
          Plan dinners for this week
        </div>
        {showRecap ? (
          <BotActivityRecap key={loop} steps={steps} durationMs={18_000} live={!replied} level={level} />
        ) : null}
        {activity ? (
          <BotStatusLine activity={activity} wording={wording} now={PREVIEW_STARTED_AT} />
        ) : (
          <div className="max-w-[85%] px-1 text-primary">Here are five quick dinners for the week.</div>
        )}
      </div>
      {reduced ? (
        <Button
          variant="transparent"
          size="small"
          className="self-start"
          aria-label={`${playing ? "Pause" : "Play"} preview: ${label}`}
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {playing ? "Pause" : "Play"}
        </Button>
      ) : null}
    </div>
  );
}

function ChoiceRow({
  value,
  label,
  description,
  recommended,
  preview,
}: {
  value: string;
  label: string;
  description: string;
  recommended?: boolean;
  preview: React.ReactNode;
}) {
  return (
    <div className="rounded-control bg-well px-3 py-2.5 hover:bg-list-hover has-[[data-state=checked]]:bg-list-selection">
      <Label className="cursor-pointer items-start">
        <RadioGroupItem value={value} aria-label={label} className="mt-0.5 shrink-0" />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-regular text-primary">
            {label}
            {recommended ? (
              <span className="rounded-pill bg-control px-2 py-0.5 text-mini text-secondary">Recommended</span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-small text-secondary">{description}</span>
        </span>
      </Label>
      <div className="mt-2 pl-7">{preview}</div>
    </div>
  );
}

export function BotChatActivityPage({ bot, onClose }: { bot: BotDefinition; onClose(): void }) {
  const qc = useQueryClient();
  const [value, setValue] = React.useState<BotChatActivity>(() => resolveBotChatActivity(bot.chatActivity));
  // Saves run one at a time, each applied to the last saved choice, so quick
  // picks never conflict and a failed one never leaks into the next.
  const queue = React.useRef<Promise<void>>(Promise.resolve());
  const pending = React.useRef(0);
  // The last choice that reached the Bot; the page settles on it when saves end.
  const saved = React.useRef<BotChatActivity>(value);

  const pick = (patch: Partial<BotChatActivity>) => {
    const next = { ...value, ...patch };
    if (next.level === value.level && next.wording === value.wording) return;
    setValue(next);
    pending.current += 1;
    queue.current = queue.current.then(async () => {
      try {
        const choice = { ...saved.current, ...patch };
        await updateBotIdentity(qc, bot.id, { chatActivity: choice });
        saved.current = choice;
      } catch (error) {
        toast.error(userFacingErrorMessage(error, "Aiden couldn’t save that choice."));
      } finally {
        pending.current -= 1;
        if (pending.current === 0) setValue(saved.current);
      }
    });
  };

  return (
    <BotPageShell
      scrollId={`bot-chat-activity:${bot.id}`}
      title={bot.name}
      backLabel="Back"
      onBack={onClose}
      heading="Chat activity"
      description={`What you see in ${bot.name}’s chat while it works. Changes save as you pick them.`}
    >
      <FieldSet title="How much to show">
        <Field orientation="vertical">
          <RadioGroup
            orientation="vertical"
            aria-label="How much to show"
            value={value.level}
            onValueChange={(level) => pick({ level: level as BotChatActivityLevel })}
          >
            {LEVEL_CHOICES.map((choice) => (
              <ChoiceRow
                key={choice.value}
                value={choice.value}
                label={BOT_CHAT_ACTIVITY_LEVEL_LABELS[choice.value]}
                description={choice.description}
                recommended={choice.recommended}
                preview={
                  <BotChatActivityPreview
                    level={choice.value}
                    wording={value.wording}
                    label={BOT_CHAT_ACTIVITY_LEVEL_LABELS[choice.value]}
                    name={`level-${choice.value}`}
                  />
                }
              />
            ))}
          </RadioGroup>
        </Field>
      </FieldSet>
      <FieldSet title="What the status line says">
        <Field orientation="vertical">
          <RadioGroup
            orientation="vertical"
            aria-label="What the status line says"
            value={value.wording}
            onValueChange={(wording) => pick({ wording: wording as BotChatActivityWording })}
          >
            {WORDING_CHOICES.map((choice) => (
              <ChoiceRow
                key={choice.value}
                value={choice.value}
                label={BOT_CHAT_ACTIVITY_WORDING_LABELS[choice.value]}
                description={choice.description}
                preview={
                  <BotChatActivityPreview
                    level="quiet"
                    wording={choice.value}
                    label={BOT_CHAT_ACTIVITY_WORDING_LABELS[choice.value]}
                    name={`wording-${choice.value}`}
                  />
                }
              />
            ))}
          </RadioGroup>
        </Field>
      </FieldSet>
      <FieldSet title="On iPhone and Android">
        <Field orientation="vertical" description="Always just the line, with the same words.">
          <BotChatActivityPreview level="quiet" wording={value.wording} label="On iPhone and Android" name="phones" />
        </Field>
      </FieldSet>
    </BotPageShell>
  );
}
