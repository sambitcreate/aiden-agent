import * as React from "react";
import { ArrowRight, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  ASK_USER_QUESTION_VERSION,
  type AskUserQuestionAnswerV1,
  type AskUserQuestionPromptV1,
  type AskUserQuestionResponseV1,
} from "../shared/ask-user-question";
import { Button } from "./ui";

const OPTION_LETTERS = ["A", "B", "C", "D"] as const;

function optionLetter(index: number): string | undefined {
  return OPTION_LETTERS[index];
}

function optionIndexFromKey(key: string): number | undefined {
  if (/^[1-4]$/u.test(key)) return Number(key) - 1;
  if (/^[a-d]$/iu.test(key)) return key.toLowerCase().charCodeAt(0) - 97;
  return undefined;
}

export function AskUserQuestionComposer({
  prompt,
  submitting = false,
  onRespond,
}: {
  prompt: AskUserQuestionPromptV1;
  submitting?: boolean;
  onRespond(response: AskUserQuestionResponseV1): void | Promise<void>;
}) {
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [answers, setAnswers] = React.useState<ReadonlyMap<number, AskUserQuestionAnswerV1>>(
    () => new Map(),
  );
  const [customDrafts, setCustomDrafts] = React.useState<ReadonlyMap<number, string>>(
    () => new Map(),
  );
  const firstOptionRef = React.useRef<HTMLButtonElement | null>(null);
  const question = prompt.questions[activeIndex]!;
  const answer = answers.get(activeIndex);
  const customDraft =
    customDrafts.get(activeIndex) ?? (answer?.kind === "custom" ? answer.answer : "");

  React.useEffect(() => {
    setActiveIndex(0);
    setAnswers(new Map());
    setCustomDrafts(new Map());
  }, [prompt.promptId]);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      firstOptionRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeIndex]);

  const response = React.useCallback(
    (cancelled: boolean, resolvedAnswers = answers) =>
      ({
        version: ASK_USER_QUESTION_VERSION,
        promptId: prompt.promptId,
        cancelled,
        answers: cancelled
          ? []
          : [...resolvedAnswers.values()].sort(
              (left, right) => left.questionIndex - right.questionIndex,
            ),
      }) satisfies AskUserQuestionResponseV1,
    [answers, prompt.promptId],
  );

  const moveTo = React.useCallback(
    (index: number) => {
      if (submitting || index < 0 || index >= prompt.questions.length) return;
      setActiveIndex(index);
    },
    [prompt.questions.length, submitting],
  );

  const commit = React.useCallback(
    (nextAnswer?: AskUserQuestionAnswerV1) => {
      const next = new Map(answers);
      if (nextAnswer) next.set(activeIndex, nextAnswer);
      else next.delete(activeIndex);
      setAnswers(next);
      if (nextAnswer?.kind !== "custom") {
        const drafts = new Map(customDrafts);
        drafts.delete(activeIndex);
        setCustomDrafts(drafts);
      }
      if (activeIndex < prompt.questions.length - 1) {
        setActiveIndex(activeIndex + 1);
      } else {
        void onRespond(response(false, next));
      }
    },
    [activeIndex, answers, customDrafts, onRespond, prompt.questions.length, response],
  );

  const commitCustom = React.useCallback(() => {
    const normalized = customDraft.trim();
    if (!normalized || submitting) return;
    commit({ questionIndex: activeIndex, kind: "custom", answer: normalized });
  }, [activeIndex, commit, customDraft, submitting]);

  const toggleMulti = (label: string) => {
    if (submitting) return;
    const selected =
      answer?.kind === "multi"
        ? answer.selected.includes(label)
          ? answer.selected.filter((item) => item !== label)
          : [...answer.selected, label]
        : [label];
    const next = new Map(answers);
    if (selected.length > 0) {
      next.set(activeIndex, { questionIndex: activeIndex, kind: "multi", selected });
    } else {
      next.delete(activeIndex);
    }
    setAnswers(next);
  };

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (submitting || event.metaKey || event.ctrlKey || event.altKey) return;
    if (
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLInputElement
    ) {
      return;
    }
    const optionIndex = optionIndexFromKey(event.key);
    if (optionIndex === undefined) return;
    const option = question.options[optionIndex];
    if (!option) return;
    event.preventDefault();
    if (question.multiSelect) toggleMulti(option.label);
    else commit({ questionIndex: activeIndex, kind: "option", answer: option.label });
  };

  const continueLabel = activeIndex === prompt.questions.length - 1 ? "Submit" : "Next";

  return (
    <div data-browser-composer-inset="true" className="aiden-dock-inset chat-content-column">
      <section
        className="ask-user-question-shell min-h-76 rounded-sheet bg-popover px-5 py-4 shadow-composer outline outline-1 outline-field/80 sm:px-6 sm:py-5"
        aria-labelledby={`ask-user-question-title-${prompt.promptId}`}
        aria-busy={submitting}
        onKeyDown={handleCardKeyDown}
      >
        <div className="flex min-w-0 items-center gap-3">
          <h2
            id={`ask-user-question-title-${prompt.promptId}`}
            className="min-w-0 flex-1 text-heading1 font-semibold text-primary"
          >
            {question.question}
          </h2>
          <div
            className="flex shrink-0 items-center gap-1 text-secondary"
            aria-label="Question navigation"
          >
            <Button
              variant="transparent"
              size="small"
              iconOnly
              aria-label="Previous question"
              disabled={submitting || activeIndex === 0}
              onClick={() => moveTo(activeIndex - 1)}
            >
              <ChevronLeft />
            </Button>
            <span className="min-w-16 text-center text-regular tabular-nums" aria-live="polite">
              {activeIndex + 1} of {prompt.questions.length}
            </span>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              aria-label="Next question"
              disabled={submitting || activeIndex === prompt.questions.length - 1}
              onClick={() => moveTo(activeIndex + 1)}
            >
              <ChevronRight />
            </Button>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              className="ml-1"
              aria-label="Close questionnaire"
              disabled={submitting}
              onClick={() => void onRespond(response(true))}
            >
              <X />
            </Button>
          </div>
        </div>

        <div
          className="mt-4 grid gap-1.5"
          role={question.multiSelect ? "group" : "radiogroup"}
          aria-label={question.header}
        >
          {question.options.map((option, optionIndex) => {
            const selected =
              (answer?.kind === "option" && answer.answer === option.label) ||
              (answer?.kind === "multi" && answer.selected.includes(option.label));
            const letter = optionLetter(optionIndex) ?? String(optionIndex + 1);
            return (
              <button
                key={option.label}
                ref={optionIndex === 0 ? firstOptionRef : undefined}
                type="button"
                role={question.multiSelect ? "checkbox" : "radio"}
                aria-checked={selected}
                disabled={submitting}
                className={cn(
                  "ask-user-question-option group flex min-h-16 w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left",
                  selected && "is-selected bg-list-selection",
                )}
                onClick={() => {
                  if (question.multiSelect) toggleMulti(option.label);
                  else commit({ questionIndex: activeIndex, kind: "option", answer: option.label });
                }}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-control/45 text-regular font-medium text-secondary">
                  {letter}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-strong font-medium text-primary">{option.label}</span>
                  <span className="mt-0.5 block text-regular leading-snug text-secondary">
                    {option.description}
                  </span>
                </span>
                {!question.multiSelect ? (
                  <ArrowRight className="ask-user-question-option-arrow size-5 shrink-0 text-secondary" />
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex min-h-12 items-end gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-entry-shell flex items-end gap-2 rounded-2xl bg-control/55 p-2.5">
              <textarea
                value={customDraft}
                rows={1}
                maxLength={4_000}
                aria-label="Other answer"
                className="max-h-28 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-regular text-primary placeholder:text-secondary"
                placeholder="Other answer"
                disabled={submitting}
                onChange={(event) => {
                  const next = new Map(customDrafts);
                  next.set(activeIndex, event.target.value);
                  setCustomDrafts(next);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    commitCustom();
                  }
                }}
              />
              {customDraft.trim() ? (
                <Button
                  variant="filled"
                  size="small"
                  disabled={submitting}
                  onClick={commitCustom}
                >
                  {continueLabel}
                </Button>
              ) : null}
            </div>
          </div>
          {question.multiSelect &&
          !customDraft.trim() &&
          answer?.kind === "multi" &&
          answer.selected.length > 0 ? (
            <Button
              variant="filled"
              size="small"
              disabled={submitting}
              onClick={() => commit(answer)}
            >
              {continueLabel}
            </Button>
          ) : null}
          <Button variant="muted" size="small" disabled={submitting} onClick={() => commit()}>
            {submitting ? "Sending…" : "Skip"}
          </Button>
        </div>
      </section>
    </div>
  );
}
