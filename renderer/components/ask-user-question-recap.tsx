// The settled questionnaire in the transcript: each question with the
// owner's choice beneath it, right-aligned like the owner's own messages.

import type {
  AskUserQuestionRecapItemV1,
  AskUserQuestionRecapV1,
} from "../shared/ask-user-question";

function unansweredLabel(outcome: AskUserQuestionRecapV1["outcome"]): string {
  if (outcome === "expired") return "No answer";
  if (outcome === "dismissed") return "Dismissed";
  return "Skipped";
}

function RecapAnswer({
  item,
  outcome,
}: {
  item: AskUserQuestionRecapItemV1;
  outcome: AskUserQuestionRecapV1["outcome"];
}) {
  if (item.kind === "skipped") {
    return <p className="mt-1 text-tertiary">{unansweredLabel(outcome)}</p>;
  }
  if (item.kind === "custom") {
    return (
      <p className="mt-1 whitespace-pre-wrap break-words text-primary">
        “{item.answers[0]}”
      </p>
    );
  }
  return (
    <p className="mt-1 break-words font-medium text-primary">{item.answers.join(", ")}</p>
  );
}

export function AskUserQuestionRecap({ recap }: { recap: AskUserQuestionRecapV1 }) {
  return (
    <div className="flex justify-end">
      <ul
        aria-label="Your answers"
        className="flex w-full max-w-[min(80%,35rem)] flex-col items-end gap-2"
      >
        {recap.items.map((item, index) => (
          <li
            key={index}
            className="ask-user-question-recap-card max-w-full select-text px-3.5 py-2.5"
          >
            <p className="break-words text-small text-secondary">{item.question}</p>
            <RecapAnswer item={item} outcome={recap.outcome} />
          </li>
        ))}
      </ul>
    </div>
  );
}
