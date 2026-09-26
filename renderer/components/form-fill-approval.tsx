import * as React from "react";
import type { FormFillBatchApprovalDetails } from "../shared/assistant";
import { Text } from "./ui";

/**
 * Form Fill Specialist review card. Rows are checkboxes the user can deselect;
 * deselected orders are returned via `onDeselectChange` and travel with the
 * approval decision — the exact reviewed values can never be edited.
 */
export function FormFillApproval({
  details,
  descriptionId,
  onDeselectChange,
}: {
  details: FormFillBatchApprovalDetails;
  descriptionId: string;
  onDeselectChange?: (excludedOrders: number[]) => void;
}) {
  const [excluded, setExcluded] = React.useState<ReadonlySet<number>>(new Set());
  const toggleRow = (order: number) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(order)) next.delete(order);
      else next.add(order);
      onDeselectChange?.([...next]);
      return next;
    });
  };
  const includedCount = details.rows.length - excluded.size;
  return (
    <div id={descriptionId} className="mt-2.5 space-y-2.5" data-form-fill-approval="true">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-control bg-well px-3 py-2 text-small">
        <dt className="text-tertiary">Target</dt>
        <dd className="min-w-0 truncate text-primary">
          {details.targetApp} — {details.targetTitle}
        </dd>
        <dt className="text-tertiary">Source</dt>
        <dd className="min-w-0 truncate text-primary">
          {details.sourceDocument}
          <span className="text-tertiary"> · sha256 {details.sourceHashPrefix}</span>
        </dd>
        <dt className="text-tertiary">Fields</dt>
        <dd className="text-primary">
          {details.fillCount} to fill
          {details.reviewCount > 0 ? ` · ${details.reviewCount} need review` : ""}
        </dd>
      </dl>
      {details.rows.length > 0 ? (
        <ul
          className="max-h-52 space-y-1 overflow-y-auto rounded-control bg-well px-3 py-2"
          aria-label="Fields to fill"
        >
          {details.rows.map((row) => (
            <li key={row.order} className="flex items-start gap-2 text-small">
              <input
                type="checkbox"
                className="mt-0.5 shrink-0 accent-accent"
                checked={!excluded.has(row.order)}
                onChange={() => toggleRow(row.order)}
                aria-label={`Fill ${row.label}`}
              />
              <span className="min-w-0 flex-1">
                <span className="text-primary">{row.label}</span>
                <span className="mx-1.5 text-tertiary">→</span>
                <span className="break-words font-mono text-primary">{row.value}</span>
                <span className="block text-mini text-tertiary">
                  from “{row.sourceLabel}” · line {row.sourceLine}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {details.skippedRows.length > 0 ? (
        <ul
          className="max-h-32 space-y-1 overflow-y-auto rounded-control bg-well px-3 py-2"
          aria-label="Fields left unchanged"
        >
          {details.skippedRows.map((row, index) => (
            <li key={index} className="flex items-baseline gap-2 text-small">
              <span className="min-w-0 flex-1 text-secondary">{row.label}</span>
              <span className="shrink-0 text-mini text-tertiary">{row.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <Text as="p" variant="small" color="secondary">
        This will not submit the form. Approval applies only to these {includedCount} field
        {includedCount === 1 ? "" : "s"} in {details.targetApp}; every fill is verified after it is
        written, and Aiden stops on any unexpected change.
      </Text>
    </div>
  );
}
