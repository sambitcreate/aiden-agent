// The Aiden persona. Kept pure and free of Electron and config I/O so the
// contract that matters most — that unattended runs carry the [SILENT] rule and
// attended ones do not — is unit-testable.

export interface AssistantPromptInput {
  /** Settings section ids the assistant may talk about. */
  settingsSections: readonly string[];
  /** Whether the assistant may mutate settings, and whether it must ask first. */
  settingsPermission: "full" | "ask" | "none";
  /**
   * Names of the tools actually handed to this generation. The prompt is
   * derived from it rather than assuming: telling the model to "read settings
   * before describing them" when no such tool exists is an instruction to
   * hallucinate, which is exactly what a confident, app-grounded persona makes
   * most convincing.
   */
  availableTools: readonly string[];
  /** True for background proactive runs: adds the strict [SILENT] contract. */
  unattended: boolean;
}

const PERMISSION_TEXT: Record<AssistantPromptInput["settingsPermission"], string> = {
  full: "You may change settings without asking first.",
  ask: "The user must approve every settings change before it is applied.",
  none: "You cannot change settings; explain what you would change and let the user do it.",
};

/**
 * Resolve the approval posture through an explicit membership check.
 *
 * `settings.json` is not schema-validated on read, so this value can be any
 * string. A bare `PERMISSION_TEXT[value]` lookup fails *open* on an unknown one
 * — the approval instruction silently disappears — and reaches
 * `Object.prototype` for keys like "toString" or "constructor", emitting
 * `function toString() { [native code] }` into the prompt.
 */
function permissionText(value: AssistantPromptInput["settingsPermission"]): string {
  return value === "full" || value === "none" ? PERMISSION_TEXT[value] : PERMISSION_TEXT.ask;
}

const SILENT_CONTRACT = [
  "You are running unattended, on a timer, with no one watching.",
  "If nothing here is worth interrupting the user for, reply with exactly [SILENT]",
  "on a line by itself and nothing else. Do not explain the silence.",
  "Only speak when the user would thank you for the interruption.",
].join(" ");

export function buildAssistantSystemPrompt(input: AssistantPromptInput): string {
  const sections = `Settings are organised into these sections: ${input.settingsSections.join(", ")}.`;
  const canReadSettings = input.availableTools.includes("get_settings");
  const canReadProjects = input.availableTools.includes("list_projects");
  const grounding =
    canReadSettings || canReadProjects
      ? [
          "Use your tools rather than guessing:",
          canReadSettings ? "read settings before describing them," : "",
          canReadProjects ? "check project status before reporting on it." : "",
        ]
          .filter(Boolean)
          .join(" ")
      : // No live-state tools in this generation. Say so plainly instead of
        // inventing an answer that sounds authoritative because the persona is.
        [
          "You cannot read the user's current settings or the state of their projects:",
          "you have no tool for it. Never state what a setting is currently set to, how",
          "many uncommitted changes exist, or what changed today. Explain how the app",
          "works and where in Settings to look, and say plainly that you cannot see the",
          "live value.",
        ].join(" ");
  return [
    "You are Aiden, the in-app assistant for Aiden Agent, a macOS desktop app for",
    "chatting with AI models across a user's coding projects. You help the user",
    "understand and operate the app itself: you answer questions about it and explain",
    "its settings.",
    "",
    "You are not a coding agent. You have no access to file contents and cannot run",
    "commands. When the user wants code written or changed, tell them to use a project",
    "chat in the main window.",
    "",
    sections,
    ...(canReadSettings ? [permissionText(input.settingsPermission)] : []),
    "",
    grounding,
    "Be brief — this is a small window. Use Markdown sparingly and never open with a",
    "preamble about what you are about to do.",
    ...(input.unattended ? ["", SILENT_CONTRACT] : []),
  ].join("\n");
}
