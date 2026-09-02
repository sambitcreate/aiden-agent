import * as React from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  ASK_USER_QUESTION_VERSION,
  type AskUserQuestionAnswerV1,
  type AskUserQuestionPromptV1,
  type AskUserQuestionResponseV1,
} from "../shared/ask-user-question";

export function AskUserQuestionComposer({
  prompt,
  submitting = false,
  placement = "chat",
  onRespond,
}: {
  prompt: AskUserQuestionPromptV1;
  submitting?: boolean;
  placement?: "chat" | "design-conversation";
  onRespond(response: AskUserQuestionResponseV1): void | Promise<void>;
}) {
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [answers, setAnswers] = React.useState<ReadonlyMap<number, AskUserQuestionAnswerV1>>(
    () => new Map(),
  );
  const [customOpen, setCustomOpen] = React.useState(false);
  const [customDrafts, setCustomDrafts] = React.useState<ReadonlyMap<number, string>>(
    () => new Map(),
  );
  const firstOptionRef = React.useRef<HTMLButtonElement | null>(null);
  const customRef = React.useRef<HTMLTextAreaElement | null>(null);
  const question = prompt.questions[activeIndex]!;
  const answer = answers.get(activeIndex);
  const customDraft = customDrafts.get(activeIndex) ?? "";

  React.useEffect(() => {
    setActiveIndex(0);
    setAnswers(new Map());
    setCustomDrafts(new Map());
    setCustomOpen(false);
  }, [prompt.promptId]);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      (customOpen ? customRef.current : firstOptionRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, customOpen]);

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
      setCustomOpen(false);
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
      setCustomOpen(false);
      if (activeIndex < prompt.questions.length - 1) {
        setActiveIndex(activeIndex + 1);
      } else {
        void onRespond(response(false, next));
      }
    },
    [activeIndex, answers, onRespond, prompt.questions.length, response],
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
    if (submitting || customOpen || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^[1-4]$/u.test(event.key)) {
      const option = question.options[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      if (question.multiSelect) toggleMulti(option.label);
      else commit({ questionIndex: activeIndex, kind: "option", answer: option.label });
    }
  };

  return (
    <div
      className={cn(
        placement === "design-conversation"
          ? "w-full px-3 pb-3 pt-2"
          : "aiden-dock-inset chat-content-column",
      )}
    >
      <section
        className={cn(
          "ask-user-question-shell overflow-hidden rounded-[24px] bg-popover shadow-composer outline outline-1 outline-field/80",
          placement === "design-conversation"
            ? "max-h-[min(70vh,36rem)] overflow-y-auto px-3 py-3"
            : "min-h-76 px-5 py-4 sm:px-6 sm:py-5",
        )}
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
            <button
              type="button"
              className="ask-user-question-icon"
              aria-label="Previous question"
              disabled={submitting || activeIndex === 0}
              onClick={() => moveTo(activeIndex - 1)}
            >
              <ChevronLeft />
            </button>
            <span className="min-w-16 text-center text-regular tabular-nums" aria-live="polite">
              {activeIndex + 1} of {prompt.questions.length}
            </span>
            <button
              type="button"
              className="ask-user-question-icon"
              aria-label="Next question"
              disabled={submitting || activeIndex === prompt.questions.length - 1}
              onClick={() => moveTo(activeIndex + 1)}
            >
              <ChevronRight />
            </button>
            <button
              type="button"
              className="ask-user-question-icon ml-1"
              aria-label="Close questionnaire"
              disabled={submitting}
              onClick={() => void onRespond(response(true))}
            >
              <X />
            </button>
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
                  selected && "is-selected",
                )}
                onClick={() => {
                  if (question.multiSelect) toggleMulti(option.label);
                  else commit({ questionIndex: activeIndex, kind: "option", answer: option.label });
                }}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full border border-field bg-control/45 text-regular text-secondary">
                  {selected ? <Check className="size-4" /> : optionIndex + 1}
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
            {customOpen ? (
              <div className="flex items-end gap-2 rounded-2xl bg-control/55 p-2.5">
                <Pencil className="mb-2 size-4 shrink-0 text-secondary" />
                <textarea
                  ref={customRef}
                  value={customDraft}
                  rows={1}
                  maxLength={4_000}
                  aria-label={`Custom answer for ${question.question}`}
                  className="max-h-28 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-regular text-primary placeholder:text-secondary"
                  placeholder="Tell Aiden what to do instead"
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
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setCustomOpen(false);
                    }
                  }}
                />
                <button
                  type="button"
                  className="ask-user-question-pill"
                  disabled={submitting || !customDraft.trim()}
                  onClick={commitCustom}
                >
                  {activeIndex === prompt.questions.length - 1 ? "Submit" : "Next"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="ask-user-question-custom flex min-h-11 max-w-full items-center gap-3 rounded-2xl px-3 text-left text-secondary"
                disabled={submitting}
                onClick={() => setCustomOpen(true)}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full border border-field bg-control/45">
                  <Pencil className="size-4" />
                </span>
                <span className="truncate text-regular">Type your own answer</span>
              </button>
            )}
          </div>
          {question.multiSelect && answer?.kind === "multi" && answer.selected.length > 0 ? (
            <button
              type="button"
              className="ask-user-question-pill"
              disabled={submitting}
              onClick={() => commit(answer)}
            >
              {activeIndex === prompt.questions.length - 1 ? "Submit" : "Next"}
            </button>
          ) : null}
          <button
            type="button"
            className="ask-user-question-pill"
            disabled={submitting}
            onClick={() => commit()}
          >
            {submitting ? "Sending…" : "Skip"}
          </button>
        </div>
      </section>
    </div>
  );
}
