// Shared between main and every renderer: the reserved workspace id that keeps
// assistant threads out of the main window's sidebar. The sidebar always lists
// chats filtered by the active workspace, and workspace ids are main-generated,
// so a reserved literal is sufficient isolation.
export const ASSISTANT_WORKSPACE_ID = "assistant";

/**
 * Prompts offered in Aiden's empty state.
 *
 * Deliberately limited to questions Aiden can answer from what it knows about
 * the app. The live-state questions this feature is ultimately for — "Any
 * uncommitted changes?", "Summarize my settings" — need the get_settings and
 * list_projects tools, and offering them before those tools exist just invites
 * a confident wrong answer. Restore them with the tools.
 */
export const ASSISTANT_SUGGESTED_PROMPTS = [
  "What can you help me with?",
  "How do scheduled tasks work?",
  "Where do I add a provider?",
] as const;
