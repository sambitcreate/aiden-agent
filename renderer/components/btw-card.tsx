import * as React from "react";
import { ArrowUp, CircleStop, Sparkles, Trash2, X } from "lucide-react";
import { BTW_LIMITS } from "../shared/btw";
import type { BtwEventV1 } from "../shared/btw";

export type BtwCardStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export interface BtwCardView {
  requestId: string;
  question: string;
  answer: string;
  status: BtwCardStatus;
  message?: string;
  hasHistory: boolean;
  contextTrimmed: boolean;
}

export type BtwLiveView = BtwCardView & { sequence: number };

export function reduceBtwView(current: BtwLiveView | null, event: BtwEventV1): BtwLiveView | null {
  if (event.type === "started") {
    return {
      requestId: event.requestId,
      question: event.question,
      answer: "",
      status: "running",
      hasHistory: event.hasHistory,
      contextTrimmed: event.contextTrimmed,
      sequence: event.sequence,
    };
  }
  if (!current || current.requestId !== event.requestId || event.sequence <= current.sequence) {
    return current;
  }
  if (event.type === "delta") {
    return { ...current, answer: current.answer + event.delta, sequence: event.sequence };
  }
  if (event.type === "reset") {
    return { ...current, answer: "", sequence: event.sequence };
  }
  if (event.type === "terminal") {
    return {
      ...current,
      answer: event.answer ?? current.answer,
      message: event.message,
      status: event.status,
      contextTrimmed: event.contextTrimmed,
      hasHistory: event.status === "completed" || current.hasHistory,
      sequence: event.sequence,
    };
  }
  return null;
}

export function BtwCard({
  view,
  onAsk,
  onCancel,
  onClear,
  onClose,
}: {
  view: BtwCardView;
  onAsk(question: string): void | Promise<void>;
  onCancel(): void | Promise<void>;
  onClear(): void | Promise<void>;
  onClose(): void | Promise<void>;
}) {
  const [draft, setDraft] = React.useState("");
  const running = view.status === "starting" || view.status === "running";
  const response = view.answer || view.message || (running ? "Thinking alongside this chat…" : "No answer was returned.");

  const submit = React.useCallback(() => {
    const question = draft.trim();
    if (!question || running) return;
    setDraft("");
    void onAsk(question);
  }, [draft, onAsk, running]);

  return (
    <div className="aiden-dock-inset chat-content-column pb-2">
      <section
        className="overflow-hidden rounded-[22px] border border-field/80 bg-popover shadow-composer"
        aria-labelledby="btw-card-title"
        aria-busy={running}
      >
        <header className="flex items-center gap-2 border-b border-field/60 px-4 py-3">
          <span className="grid size-7 place-items-center rounded-full bg-control text-secondary">
            <Sparkles className="size-3.5" aria-hidden="true" />
          </span>
          <h2 id="btw-card-title" className="text-strong font-medium text-primary">
            Side question
          </h2>
          <span className="rounded-full bg-control px-2 py-0.5 text-small text-secondary">
            Ephemeral
          </span>
          <div className="ml-auto flex items-center gap-1">
            {running ? (
              <button
                type="button"
                className="grid size-8 place-items-center rounded-full text-secondary hover:bg-control hover:text-primary"
                aria-label="Cancel side question"
                disabled={view.status === "starting"}
                onClick={() => void onCancel()}
              >
                <CircleStop className="size-4" />
              </button>
            ) : view.hasHistory ? (
              <button
                type="button"
                className="grid size-8 place-items-center rounded-full text-secondary hover:bg-control hover:text-primary"
                aria-label="Clear side-question history"
                onClick={() => void onClear()}
              >
                <Trash2 className="size-4" />
              </button>
            ) : null}
            <button
              type="button"
              className="grid size-8 place-items-center rounded-full text-secondary hover:bg-control hover:text-primary"
              aria-label="Close side question"
              disabled={view.status === "starting"}
              onClick={() => void onClose()}
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        <div className="max-h-72 overflow-y-auto px-4 py-3">
          <p className="rounded-2xl bg-control/55 px-3 py-2 text-regular text-secondary">
            {view.question}
          </p>
          <div className="mt-3 whitespace-pre-wrap text-regular leading-relaxed text-primary" aria-live="polite">
            {response}
          </div>
          {view.contextTrimmed ? (
            <p className="mt-2 text-small text-secondary">Older chat context was trimmed to fit this model.</p>
          ) : null}
        </div>

        <footer className="border-t border-field/60 px-3 py-2.5">
          <div className="flex items-end gap-2 rounded-2xl bg-control/55 px-3 py-2">
            <textarea
              value={draft}
              rows={1}
              maxLength={BTW_LIMITS.questionCodePoints}
              disabled={running}
              aria-label="Ask a follow-up side question"
              placeholder={running ? "Wait for this answer…" : "Ask a follow-up"}
              className="max-h-24 min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 text-regular text-primary placeholder:text-secondary"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  void onClose();
                }
              }}
            />
            <button
              type="button"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground disabled:opacity-40"
              aria-label="Ask follow-up side question"
              disabled={running || !draft.trim()}
              onClick={submit}
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
          <p className="mt-2 px-1 text-small text-secondary">
            Uses this chat as read-only context. Questions and answers are not added to the transcript.
          </p>
        </footer>
      </section>
    </div>
  );
}
