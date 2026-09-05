
export type CompactionReason = "manual" | "threshold" | "overflow";

export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

export type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number | string }
  | { kind: "assistant"; text: string; sourceIndex?: number | string }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number | string }
  | { kind: "tool_result"; name: string; text: string; sourceIndex?: number | string }
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number | string };
