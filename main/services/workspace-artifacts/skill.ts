import { WORKSPACE_ARTIFACT_LIMITS, WORKSPACE_ARTIFACT_TOOL_NAME } from "../../../renderer/shared/workspace-artifacts.js";

/**
 * Built-in skill that teaches the model how to build workspace artifacts.
 * It lives in main rather than `resources/aiden-help` because artifacts are
 * desktop-only and the CLI copies that folder.
 */
export const AIDEN_ARTIFACTS_SKILL = Object.freeze({
  name: "aiden-artifacts",
  description:
    "Build and update interactive pages in the workspace's Artifacts tab: live status boards such as open pull requests, release checklists or TODO lists.",
  instructions: [
    `Use ${WORKSPACE_ARTIFACT_TOOL_NAME} when the person wants a page they will come back to in this workspace, such as open pull requests, CI status, a release checklist or a TODO board. For a one-off answer, chart or form, use render_ui in the chat instead. If ${WORKSPACE_ARTIFACT_TOOL_NAME} is not among your tools, artifacts are not available here (they live in the Aiden desktop app), so use render_ui.`,
    "",
    "Before you write a page:",
    `1. Call ${WORKSPACE_ARTIFACT_TOOL_NAME} with operation "list". If a page already covers the request, update it by id instead of creating a near-duplicate. A workspace holds at most ${WORKSPACE_ARTIFACT_LIMITS.perWorkspace} pages.`,
    '2. Call visualize_guide with the "catalog" module (and "interactive" for buttons and state) for the markup components. Pages use the same Aiden UI Markup as render_ui and start with <Visual title="…">.',
    "",
    "Live data comes from named sources, re-read each time the page refreshes:",
    `- kind "shell": a read-only command run in the workspace folder, for example \`gh pr list --json number,title,author,url,isDraft\`. Prefer commands that print JSON and set parse "json". Each run has ${WORKSPACE_ARTIFACT_LIMITS.sourceTimeoutMs / 1000} seconds and ${WORKSPACE_ARTIFACT_LIMITS.sourceOutputBytes / 1024} KiB of output.`,
    '- kind "file": a workspace-relative path, read with parse "text", "lines" (non-empty lines as a list) or "json".',
    `- Up to ${WORKSPACE_ARTIFACT_LIMITS.sources} sources. In markup, read a source as $name. It is null until it first loads, so guard with a fallback, for example {$pulls == null ? "Loading…" : len($pulls) + " open"}.`,
    "",
    "Buttons:",
    '- sendPrompt("…") asks Aiden in the chat beside the page; compose("…") puts text in the composer for the person to edit and send; openUrl, copy and setState work as in render_ui.',
    `- run("actionName", value…) runs one of the page's declared actions. An action's command is a shell template where each {{param}} is a standalone, unquoted word (for example \`gh pr merge {{number}} --squash\`); Aiden quotes the value. Values may not start with "-". Up to ${WORKSPACE_ARTIFACT_LIMITS.actions} actions.`,
    "- Label actions with what they do. The person confirms a command before it runs unless the workspace has Full access.",
    "",
    "Refresh: pages re-read their sources when shown unless refresh.onOpen is false. Set refresh.intervalSeconds only for data that changes on its own, and never below 60.",
    "",
    "Access follows the workspace, like chat: with No access nothing runs; under Ask, the person approves the page's commands when you save it, and any change to its commands needs approval again; with Full access everything runs. File sources run under Ask without approval.",
    "",
    "Delete a page only when the person asks. After creating or updating one, say in a sentence what it shows; the Artifacts tab opens on it.",
  ].join("\n"),
});
