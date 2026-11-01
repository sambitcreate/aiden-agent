import * as React from "react";
import { Callout, Text } from "./ui";

/**
 * What a workspace hook's approval covers beyond its command: the workspace
 * files it runs, whose edits ask for approval again, and a soft warning when
 * the command also runs something Aiden can't follow to a file.
 */
export function HookScriptCoverage({
  files,
  coverage,
}: {
  files?: readonly string[];
  coverage?: "partial";
}): React.ReactElement | null {
  const labelId = React.useId();
  const listed = files ?? [];
  if (listed.length === 0 && coverage !== "partial") return null;
  return (
    <div className="flex flex-col gap-2">
      {listed.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <Text as="p" variant="small-strong" id={labelId}>
            Script files
          </Text>
          <ul aria-labelledby={labelId} className="flex flex-col gap-1 rounded-control bg-well px-3 py-2">
            {listed.map((file, index) => (
              <li key={`${index}:${file}`} className="min-w-0 break-all font-mono text-small text-primary">
                {file}
              </li>
            ))}
          </ul>
          <Text as="p" variant="small" color="secondary">
            Editing one of these files asks you to approve the hook again.
          </Text>
        </div>
      ) : null}
      {coverage === "partial" ? (
        <Callout color="warning" role="note">
          <Text variant="small-strong">Aiden can’t check every file this command runs</Text>
          <Text variant="small">
            It also runs something Aiden can’t follow to a file, such as a script started through cd, source, npx or npm run.
            Editing that won’t ask you to approve the hook again.
          </Text>
        </Callout>
      ) : null}
    </div>
  );
}
