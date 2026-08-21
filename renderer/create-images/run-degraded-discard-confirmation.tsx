import * as React from "react";
import { CircleAlert, HardDrive, ShieldCheck } from "lucide-react";
import type { CreateImagesDegradedRunDiscardPlanResult } from "../shared/create-images/ipc";

type ReadyDiscardPlan = Extract<CreateImagesDegradedRunDiscardPlanResult, { status: "ready" }>;

export function CreateImagesDegradedRunDiscardConfirmation({
  plan,
  reviewed,
  disabled = false,
  reviewRef,
  onReviewedChange,
}: {
  plan: ReadyDiscardPlan;
  reviewed: boolean;
  disabled?: boolean;
  reviewRef?: React.RefObject<HTMLInputElement | null>;
  onReviewedChange(reviewed: boolean): void;
}) {
  const warningId = React.useId();
  return (
    <div className="create-images-run-discard-confirmation">
      <section className="create-images-run-discard-warning" aria-labelledby={warningId}>
        <CircleAlert aria-hidden="true" />
        <div>
          <h3 id={warningId}>This permanently removes the durable run record</h3>
          <p>
            Aiden cannot recover this journal. Discarding it may remove the only durable evidence of
            submitted work and retained image or asset references. These references may include
            imported inputs and generated outputs. It cannot be undone.
          </p>
          <p>
            A provider request may still complete. Starting another run can duplicate images and
            incur another charge. Discarding does not cancel provider work.
          </p>
        </div>
      </section>
      <dl className="create-images-run-discard-summary">
        <div>
          <dt>Record</dt>
          <dd>{plan.association === "unassociated" ? "Unassociated run" : "Workflow run"}</dd>
        </div>
        <div>
          <dt>Retained images and assets</dt>
          <dd>Imported-input and generated-output references may be released</dd>
        </div>
      </dl>
      <div className="create-images-run-discard-local-note" role="note">
        <ShieldCheck aria-hidden="true" />
        <p>
          <strong>Current Phase 3 mode is a $0 local mock with no network request.</strong> This
          warning remains conservative for future provider-backed runs.
        </p>
      </div>
      <div className="create-images-run-discard-storage-note">
        <HardDrive aria-hidden="true" />
        <p>
          Imported inputs or generated outputs with no other workflow or run reference may later be
          removed by device-local cleanup.
        </p>
      </div>
      <label className="create-images-run-review-check create-images-run-discard-check">
        <input
          ref={reviewRef}
          type="checkbox"
          checked={reviewed}
          disabled={disabled}
          onChange={(event) => onReviewedChange(event.target.checked)}
        />
        <span>
          <strong>
            I understand this journal and its unique imported-input or generated-output references
            may be lost.
          </strong>{" "}
          I want to permanently discard this irrecoverable run record.
        </span>
      </label>
    </div>
  );
}
