// Presentation for the composer's pull-request chip and its popover list.

export function chatPullRequestChipLabels(counts: {
  linked: number;
  open: number;
  pending: number;
}): { text: string; ariaLabel: string } {
  const text =
    counts.linked === 0
      ? "Pull Requests"
      : counts.open > 0
        ? `${counts.open} open · ${counts.linked} linked`
        : `Pull Requests · ${counts.linked}`;
  const parts =
    counts.linked === 0
      ? ["Pull requests for this chat"]
      : [
          `Pull requests for this chat: ${counts.linked} linked`,
          ...(counts.open > 0 ? [`${counts.open} open`] : []),
        ];
  if (counts.pending > 0) {
    parts.push(
      `${counts.pending} pending ${counts.pending === 1 ? "creation needs" : "creations need"} review`,
    );
  }
  return { text, ariaLabel: parts.join(", ") };
}

export type ChatPullRequestListStatus = "loading" | "error" | "empty" | "list";

/** "Nothing linked" is only claimed once the saved links have actually loaded. */
export function chatPullRequestListStatus(input: {
  rows: number;
  linksLoaded: boolean;
  linksFailed: boolean;
}): ChatPullRequestListStatus {
  if (input.rows > 0) return "list";
  if (input.linksFailed) return "error";
  if (!input.linksLoaded) return "loading";
  return "empty";
}
