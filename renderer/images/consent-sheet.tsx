import { IMAGE_WORKFLOW_LIMITS } from "../shared/images/schema";
import { Dialog, Text } from "../components/ui";
import type { ImageRunConsentPlan } from "../shared/images/run-types";
import { consentTitle, referenceSummary, requestCountLabel, scopeNote } from "./run-view-core";

export function ConsentSummary({ plan }: { plan: ImageRunConsentPlan }) {
  const note = scopeNote(plan.scope);
  const upstream = plan.requests.some((request) => request.pendingReferenceCount > 0);
  return (
    <div className="flex flex-col gap-3">
      {note ? <Text as="p" variant="small" color="secondary">{note}</Text> : null}
      <ul aria-label="Image requests" className="flex flex-col gap-2">
        {plan.requests.map((request) => {
          const references = referenceSummary(request);
          return (
            <li key={`${request.nodeId}:${request.variant}`} className="flex flex-col gap-0.5 rounded-control bg-control px-3 py-2">
              <Text variant="strong">{`${request.providerLabel} · ${request.modelLabel}`}</Text>
              {references ? <Text variant="small" color="secondary">{references}</Text> : null}
            </li>
          );
        })}
      </ul>
      {upstream ? (
        <Text as="p" variant="small" color="secondary">
          {`Up to ${IMAGE_WORKFLOW_LIMITS.maxReferences} reference images per request, including images from earlier steps.`}
        </Text>
      ) : null}
      <Text as="p" variant="small" color="secondary">
        Estimate unavailable. The cost each request reports is shown after it finishes.
      </Text>
      <Text as="p" variant="small" color="secondary">
        Each request is sent once. Aiden never retries a paid request automatically.
      </Text>
    </div>
  );
}

export function ConsentSheet({
  plan,
  busy,
  onCancel,
  onConfirm,
  returnFocus,
}: {
  plan: ImageRunConsentPlan | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
  /** Where focus lands when the sheet closes; the opener may have been replaced by then. */
  returnFocus?: () => HTMLElement | null;
}) {
  return (
    <Dialog
      open={plan !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={plan ? consentTitle(plan) : ""}
      description={plan ? `Generating sends ${requestCountLabel(plan.totalRequests)} and may incur charges.` : undefined}
      confirmLabel="Generate"
      cancelLabel="Cancel"
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      returnFocus={returnFocus}
    >
      {plan ? <ConsentSummary plan={plan} /> : null}
    </Dialog>
  );
}
