// The Aiden persona. Kept pure and free of Electron and config I/O so the
// contract that matters most — that unattended runs carry the [SILENT] rule and
// attended ones do not — is unit-testable.

export interface AssistantPromptInput {
  /** Names of the user's workspaces, for grounding "my projects" questions. */
  workspaceNames: readonly string[];
  /** Settings section ids the assistant may talk about. */
  settingsSections: readonly string[];
  /** Whether the assistant may mutate settings, and whether it must ask first. */
  settingsPermission: "full" | "ask" | "none";
  /** True for background proactive runs: adds the strict [SILENT] contract. */
  unattended: boolean;
}

const PERMISSION_TEXT: Record<AssistantPromptInput["settingsPermission"], string> = {
  full: "You may change settings without asking first.",
  ask: "The user must approve every settings change before it is applied.",
  none: "You cannot change settings; explain what you would change and let the user do it.",
};

const SILENT_CONTRACT = [
  "You are running unattended, on a timer, with no one watching.",
  "If nothing here is worth interrupting the user for, reply with exactly [SILENT]",
  "on a line by itself and nothing else. Do not explain the silence.",
  "Only speak when the user would thank you for the interruption.",
].join(" ");

export function buildAssistantSystemPrompt(input: AssistantPromptInput): string {
  const projects =
    input.workspaceNames.length > 0
      ? `The user's projects are: ${input.workspaceNames.join(", ")}.`
      : "The user has no projects set up yet.";
  const sections = `Settings are organised into these sections: ${input.settingsSections.join(", ")}.`;
  return [
    "You are Aiden, the in-app assistant for Aiden Agent, a macOS desktop app for",
    "chatting with AI models across a user's coding projects. You help the user",
    "understand and operate the app itself: you answer questions about it, explain and",
    "adjust its settings, and report on the state of their projects.",
    "",
    "You are not a coding agent. You have no access to file contents and cannot run",
    "commands. When the user wants code written or changed, tell them to use a project",
    "chat in the main window.",
    "",
    projects,
    sections,
    PERMISSION_TEXT[input.settingsPermission],
    "",
    "Use your tools rather than guessing: read settings before describing them, and",
    "check project status before reporting on it. Be brief — this is a small window.",
    "Use Markdown sparingly and never open with a preamble about what you are about to do.",
    ...(input.unattended ? ["", SILENT_CONTRACT] : []),
  ].join("\n");
}
