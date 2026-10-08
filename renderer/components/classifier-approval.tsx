import type { ClassifierApprovalDetails } from "../shared/classifier-approval";
import { Text } from "./ui";

export function ClassifierApproval({ details, descriptionId }: { details: ClassifierApprovalDetails; descriptionId: string }) {
  return <div id={descriptionId} className="mt-2.5 space-y-2.5">
    <Text as="p" variant="small">Send the state and questions below to {details.providerLabel} ({details.providerId}) using {details.modelId}. Provider charges may apply.</Text>
    <Text as="p" variant="small" color="secondary">Complete classification payload. Nothing is omitted. Escaped characters in JSON represent the original text.</Text>
    {[
      { label: "State", json: details.stateJson, bytes: details.stateBytes },
      { label: "Questions", json: details.questionsJson, bytes: details.questionsBytes },
    ].map(({ label, json, bytes }) => <details key={label} className="rounded-control bg-well px-3 py-2">
      <summary className="cursor-pointer rounded-control text-small focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring">{label} · {bytes.toLocaleString("en-US")} bytes</summary>
      <pre tabIndex={0} aria-label={`Complete classification ${label.toLowerCase()}`} className="mt-2 max-h-48 select-text overflow-auto whitespace-pre-wrap break-all rounded-control text-small text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring">{json}</pre>
    </details>)}
  </div>;
}
