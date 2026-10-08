import * as React from "react";
import type { ImageModelOption } from "../shared/images/port";
import type { AttemptSnapshot, OutputRef } from "../shared/images/run-types";
import type { EditorOp } from "./workflow-session-core";

export interface WorkflowEditorContextValue {
  apply(op: EditorOp): void;
  models: readonly ImageModelOption[];
  assetUrls: Readonly<Record<string, string>>;
  attempts: ReadonlyMap<string, AttemptSnapshot>;
  outputsFor(nodeId: string): readonly OutputRef[];
  running: boolean;
  /** Nodes whose output is older than a newer upstream result, e.g. after a node-only run. */
  stale: ReadonlySet<string>;
  importImage(nodeId: string): void;
  runFromHere(nodeId: string): void;
}

export const WorkflowEditorContext = React.createContext<WorkflowEditorContextValue | null>(null);

export function useWorkflowEditor(): WorkflowEditorContextValue {
  const value = React.useContext(WorkflowEditorContext);
  if (!value) throw new Error("Workflow nodes must render inside the workflow editor.");
  return value;
}
