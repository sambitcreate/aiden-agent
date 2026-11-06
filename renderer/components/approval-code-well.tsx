import * as React from "react";
import { Text } from "./ui";

/**
 * A labelled, monospaced well for the exact text an approval authorizes, such
 * as a shell command. The well takes keyboard focus so a long command can be
 * scrolled without a pointer, and it is named by its visible label.
 */
export function ApprovalCodeWell({ label, children }: { label: string; children: string }): React.ReactElement {
  const labelId = React.useId();
  return (
    <div>
      <Text as="p" id={labelId} variant="small-strong" color="tertiary">
        {label}
      </Text>
      <pre
        role="group"
        aria-labelledby={labelId}
        tabIndex={0}
        className="approval-well mt-1 max-h-48 select-text overflow-auto whitespace-pre-wrap break-all bg-well px-3 py-2 text-small text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        {children}
      </pre>
    </div>
  );
}
