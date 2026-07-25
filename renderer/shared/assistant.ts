// Shared between main and every renderer: the reserved workspace id that keeps
// assistant threads out of the main window's sidebar. The sidebar always lists
// chats filtered by the active workspace, and workspace ids are main-generated,
// so a reserved literal is sufficient isolation.
export const ASSISTANT_WORKSPACE_ID = "assistant";

/** Prompts offered in the assistant window's empty state. */
export const ASSISTANT_SUGGESTED_PROMPTS = [
  "Any uncommitted changes?",
  "What did I change today?",
  "Summarize my settings",
] as const;
