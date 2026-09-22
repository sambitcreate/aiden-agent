import * as React from "react";
import { CircleAlert, ShieldCheck } from "lucide-react";

export function CreateImagesAmbiguityAcknowledgement({
  reviewed,
  disabled = false,
  reviewRef,
  onReviewedChange,
}: {
  reviewed: boolean;
  disabled?: boolean;
  reviewRef?: React.RefObject<HTMLInputElement | null>;
  onReviewedChange(reviewed: boolean): void;
}) {
  const consequencesId = React.useId();
  return (
    <div className="create-images-run-ambiguity-confirmation">
      <section className="create-images-run-ambiguity-warning" aria-labelledby={consequencesId}>
        <CircleAlert aria-hidden="true" />
        <div>
          <h3 id={consequencesId}>The submission outcome will remain unknown</h3>
          <p>
            Acknowledging this record does not cancel, reconcile, retry, or resubmit it. A provider
            request may still complete. Starting another run can duplicate images and incur another
            charge.
          </p>
          <p>
            Aiden preserves the original needs-attention record, ambiguous node state, and retained
            outputs as durable audit history.
          </p>
        </div>
      </section>
      <div className="create-images-run-ambiguity-mock-note" role="note">
        <ShieldCheck aria-hidden="true" />
        <p>
          <strong>Current Phase 3 mode is a $0 local mock.</strong> It sends no network request.
          This acknowledgement remains conservative for future provider-backed runs.
        </p>
      </div>
      <label className="create-images-run-review-check create-images-run-ambiguity-check">
        <input
          ref={reviewRef}
          type="checkbox"
          checked={reviewed}
          disabled={disabled}
          onChange={(event) => onReviewedChange(event.target.checked)}
        />
        <span>
          <strong>I understand the unresolved submission may still complete.</strong>I want to
          acknowledge this durable record and allow a separately confirmed new run.
        </span>
      </label>
    </div>
  );
}
