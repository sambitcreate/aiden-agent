import type { WorkDetailsMode } from "../shared/appearance";

export function workDetailsOpen(mode: WorkDetailsMode, eligible: boolean): boolean {
  return mode === "verbose" || (mode === "detailed" && eligible);
}

/** Keep each assistant response after the last ordinary input in the latest exchange. */
export function latestWorkDetailsStart(messages: readonly { role: string; content: string }[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return 0;
}
