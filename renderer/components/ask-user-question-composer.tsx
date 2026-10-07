import * as React from "react";
import { Check, Pencil, X } from "lucide-react";
import { Button } from "./ui";
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
      firstOptionRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [prompt.promptId]);

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
      setCustomOpen(customDrafts.has(index));
      setActiveIndex(index);
    },
    [customDrafts, prompt.questions.length, submitting],
  );

  const commit = React.useCallback(
    (nextAnswer?: AskUserQuestionAnswerV1) => {
      const next = new Map(answers);
      if (nextAnswer) next.set(activeIndex, nextAnswer);
      else next.delete(activeIndex);
      setAnswers(next);
      if (activeIndex < prompt.questions.length - 1) {
        setCustomOpen(customDrafts.has(activeIndex + 1));
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
    const drafts = new Map(customDrafts);
    drafts.delete(activeIndex);
    setCustomDrafts(drafts);
    setCustomOpen(false);
  };

  const selectOption = (label: string) => {
    setAnswers(new Map(answers).set(activeIndex, { questionIndex: activeIndex, kind: "option", answer: label }));
    const drafts = new Map(customDrafts);
    drafts.delete(activeIndex);
    setCustomDrafts(drafts);
    setCustomOpen(false);
  };

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (submitting || customOpen || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^[1-4]$/u.test(event.key)) {
      const option = question.options[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      if (question.multiSelect) toggleMulti(option.label);
      else selectOption(option.label);
    }
  };

  return (
    <div data-browser-composer-inset="true" className="aiden-dock-inset chat-content-column min-w-0">
      <section
        className="composer-shell ask-user-question-shell relative z-10 -mt-1 flex max-h-[min(60dvh,36rem)] min-w-0 flex-col overflow-hidden bg-popover p-2.5 shadow-composer"
        aria-labelledby={`ask-user-question-title-${prompt.promptId}`}
        aria-busy={submitting}
        onKeyDown={handleCardKeyDown}
      >
        <div className="flex shrink-0 items-center gap-2 px-1.5">
          <div role="tablist" aria-label="Questions" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {prompt.questions.map((item, index) => (
              <Button variant="transparent"
                // Question indexes are stable wire identities within this immutable prompt.
                key={index}
                id={`question-tab-${prompt.promptId}-${index}`}
                role="tab"
                type="button"
                aria-selected={index === activeIndex}
                aria-controls={`question-panel-${prompt.promptId}`}
                tabIndex={index === activeIndex ? 0 : -1}
                disabled={submitting}
                className={cn("ask-user-question-pill shrink-0", index === activeIndex && "bg-control text-primary")}
                onClick={() => moveTo(index)}
                onKeyDown={(event) => {
                  const next = event.key === "ArrowRight" ? (index + 1) % prompt.questions.length
                    : event.key === "ArrowLeft" ? (index + prompt.questions.length - 1) % prompt.questions.length
                    : event.key === "Home" ? 0 : event.key === "End" ? prompt.questions.length - 1 : null;
                  if (next === null) return;
                  event.preventDefault();
                  event.stopPropagation();
                  moveTo(next);
                  document.getElementById(`question-tab-${prompt.promptId}-${next}`)?.focus({ preventScroll: true });
                }}
              >
                {index + 1}. {item.header}
                {answers.has(index) ? <Check className="ml-1 size-3" aria-label="Answered" /> : null}
              </Button>
            ))}
          </div>
          <Button variant="transparent" type="button" className="ask-user-question-icon" aria-label="Close questionnaire"
            disabled={submitting} onClick={() => void onRespond(response(true))}><X /></Button>
        </div>
        <div role="tabpanel" id={`question-panel-${prompt.promptId}`}
          aria-labelledby={`question-tab-${prompt.promptId}-${activeIndex}`} className="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-1.5">
          <h2 id={`ask-user-question-title-${prompt.promptId}`} className="mt-3 text-strong font-medium text-primary">
            {question.question}
          </h2>
          <p className="mt-1 text-small text-secondary">{activeIndex + 1} of {prompt.questions.length}{question.multiSelect ? " · Select all that apply" : " · Choose an option or write an answer"}</p>

        <div
          className="mt-4 grid gap-1.5"
          role="group"
          aria-label={question.header}
        >
          {question.options.map((option, optionIndex) => {
            const selected =
              (answer?.kind === "option" && answer.answer === option.label) ||
              (answer?.kind === "multi" && answer.selected.includes(option.label));
            return (
              <Button variant="transparent"
                key={option.label}
                ref={optionIndex === 0 ? firstOptionRef : undefined}
                type="button"
                aria-pressed={!question.multiSelect ? selected : undefined}
                role={question.multiSelect ? "checkbox" : undefined}
                aria-checked={question.multiSelect ? selected : undefined}
                disabled={submitting}
                className={cn(
                  "ask-user-question-option group flex h-auto min-h-16 w-full items-center gap-3 whitespace-normal px-3 py-2.5 text-left",
                  selected && "is-selected",
                )}
                onClick={() => {
                  if (question.multiSelect) toggleMulti(option.label);
                  else selectOption(option.label);
                }}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full border border-field bg-control/45 text-regular text-secondary">
                  {selected ? <Check className="size-4" /> : optionIndex + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-strong font-medium text-primary">{option.label}</span>
                  {selected && !question.multiSelect ? (
                    <span className="sr-only">, current answer</span>
                  ) : null}
                  <span className="mt-0.5 block text-regular leading-snug text-secondary">
                    {option.description}
                  </span>
                </span>
              </Button>
            );
          })}
        </div>

        </div>
        <div className="mt-3 flex min-h-12 shrink-0 flex-wrap items-end justify-end gap-2 px-1.5">
          <div className="min-w-0 basis-full">
            {customOpen ? (
              <div className="text-entry-shell flex items-end gap-2 rounded-2xl bg-control/55 p-2.5">
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
                    const resolved = new Map(answers);
                    if (event.target.value.trim()) resolved.set(activeIndex, { questionIndex: activeIndex, kind: "custom", answer: event.target.value.trim() });
                    else resolved.delete(activeIndex);
                    setAnswers(resolved);
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
                <Button variant="transparent"
                  type="button"
                  className="ask-user-question-pill"
                  disabled={submitting || !customDraft.trim()}
                  onClick={commitCustom}
                >
                  {activeIndex === prompt.questions.length - 1 ? "Submit" : "Next"}
                </Button>
              </div>
            ) : (
              <Button variant="transparent"
                type="button"
                className="ask-user-question-custom flex h-auto min-h-11 max-w-full items-center gap-3 px-3 text-left text-secondary"
                disabled={submitting}
                onClick={() => {
                  setCustomOpen(true);
                  requestAnimationFrame(() => customRef.current?.focus({ preventScroll: true }));
                }}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full border border-field bg-control/45">
                  <Pencil className="size-4" />
                </span>
                <span className="truncate text-regular">Type your own answer</span>
              </Button>
            )}
          </div>
          {!customOpen && answer ? (
            <Button variant="transparent"
              type="button"
              className="ask-user-question-pill"
              disabled={submitting}
              onClick={() => commit(answer)}
            >
              {activeIndex === prompt.questions.length - 1 ? "Submit" : "Next"}
            </Button>
          ) : null}
          <Button variant="transparent"
            type="button"
            className="ask-user-question-pill"
            disabled={submitting}
            onClick={() => commit()}
          >
            {submitting ? "Sending…" : "Skip"}
          </Button>
        </div>
      </section>
    </div>
  );
}
