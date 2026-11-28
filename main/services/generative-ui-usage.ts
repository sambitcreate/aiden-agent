export function displayedAssistantHtmlUsage(
  messages: readonly {
    role: string;
    htmlArtifacts?: readonly { size: number }[];
  }[],
): { bytes: number; count: number } {
  let bytes = 0;
  let count = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const artifact of message.htmlArtifacts ?? []) {
      if (!Number.isSafeInteger(artifact.size) || artifact.size < 1) continue;
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + artifact.size);
      count += 1;
    }
  }
  return { bytes, count };
}
