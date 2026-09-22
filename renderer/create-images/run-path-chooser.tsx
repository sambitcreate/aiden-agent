import * as React from "react";
import {
  CREATE_IMAGES_SELECTED_NODE_ONLY_CHOICE,
  type CreateImagesDownstreamPathChoiceView,
} from "./run-path-core";

export function CreateImagesDownstreamPathChooser({
  startNodeLabel,
  choices,
  selectedChoiceId,
  truncated,
  overflowReason,
  unavailablePathCount,
  firstChoiceRef,
  onSelectionChange,
}: {
  startNodeLabel: string;
  choices: readonly CreateImagesDownstreamPathChoiceView[];
  selectedChoiceId?: string;
  truncated: boolean;
  overflowReason?: "choice-limit" | "search-budget";
  unavailablePathCount: number;
  firstChoiceRef?: React.RefObject<HTMLInputElement | null>;
  onSelectionChange(choiceId: string): void;
}) {
  const legendId = React.useId();
  const hintId = React.useId();
  const overflowId = React.useId();
  const unavailableId = React.useId();
  const describedBy = [
    hintId,
    ...(truncated ? [overflowId] : []),
    ...(unavailablePathCount > 0 ? [unavailableId] : []),
  ].join(" ");
  const options = [
    {
      id: CREATE_IMAGES_SELECTED_NODE_ONLY_CHOICE,
      title: "Selected node only",
      detail: `Run required inputs and ${startNodeLabel}; do no downstream work.`,
    },
    ...choices,
  ];

  return (
    <fieldset
      className="create-images-run-path-chooser"
      aria-labelledby={legendId}
      aria-describedby={describedBy}
    >
      <legend id={legendId}>Choose downstream work</legend>
      <p id={hintId}>
        Select no downstream work or one connected path. Aiden will not run sibling branches.
      </p>
      <div className="create-images-run-path-options">
        {options.map((option, index) => {
          const inputId = `${legendId}-choice-${index}`;
          const checked = selectedChoiceId === option.id;
          return (
            <label
              key={option.id}
              htmlFor={inputId}
              className="create-images-run-path-option"
              data-selected={checked || undefined}
            >
              <input
                ref={index === 0 ? firstChoiceRef : undefined}
                id={inputId}
                type="radio"
                name={`${legendId}-choice`}
                value={option.id}
                checked={checked}
                onChange={(event) => onSelectionChange(event.target.value)}
              />
              <span>
                <strong>{option.title}</strong>
                <span>{option.detail}</span>
              </span>
            </label>
          );
        })}
      </div>
      {truncated ? (
        <p id={overflowId} className="create-images-run-path-overflow" role="status">
          {overflowReason === "search-budget"
            ? "This workflow has more branching than Aiden can safely inspect here. Only the first bounded set of connected paths is shown; unshown work will not run."
            : `Only the first ${choices.length} connected paths are shown. Unshown paths will not run; narrow the workflow branching to choose another path.`}
        </p>
      ) : null}
      {unavailablePathCount > 0 ? (
        <p id={unavailableId} className="create-images-run-path-overflow" role="status">
          {unavailablePathCount} inspected downstream path
          {unavailablePathCount === 1 ? " is" : "s are"} unavailable due to additional branch work
          or unresolved validation issues. Use Run workflow to include branching.
        </p>
      ) : null}
      {!selectedChoiceId ? (
        <p className="create-images-run-path-required" role="status">
          Choose one option to calculate the immutable request and output summary.
        </p>
      ) : null}
    </fieldset>
  );
}
