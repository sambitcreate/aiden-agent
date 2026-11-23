// Plain-language lineage for a chat another chat started (Phase 5, D7). The
// lead may have been deleted, so every label has a title-less form.

/** The header line and sidebar description of a started chat. */
export function startedByChatLabel(leadTitle: string | undefined): string {
  const title = leadTitle?.trim();
  return title ? `Started by “${title}”` : "Started by a deleted chat";
}

/** The label under a message the lead sent into a started chat. */
export function fromLeadChatLabel(leadTitle: string | undefined): string {
  const title = leadTitle?.trim();
  return title ? `From “${title}”` : "From the chat that started this one";
}
