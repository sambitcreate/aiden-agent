import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantSystemPrompt, withTelegramAgentContract } from "./system-prompt.js";

const base = {
  settingsSections: ["providers", "appearance"],
  settingsPermission: "ask" as const,
  availableTools: ["get_settings", "set_setting", "list_projects", "list_mcp_servers"],
  mcpServers: [{ id: "preset-composio", name: "Composio" }],
  unattended: false,
};

test("introduces Aiden as an app assistant without granting dock coding access", () => {
  const prompt = buildAssistantSystemPrompt(base);
  assert.match(prompt, /You are Aiden/u);
  assert.match(prompt, /Aiden Agent/u);
  assert.match(prompt, /cannot read or change project files/u);
  assert.match(prompt, /future scheduled project or MCP automation/u);
});

test("grounds the prompt in settings sections without disclosing workspace inventory", () => {
  const prompt = buildAssistantSystemPrompt(base);
  assert.match(prompt, /providers/u);
  assert.doesNotMatch(prompt, /The user's projects are:/u);
});

test("states the approval posture for settings mutations", () => {
  assert.match(buildAssistantSystemPrompt(base), /must approve/u);
  assert.match(
    buildAssistantSystemPrompt({ ...base, settingsPermission: "full" }),
    /without asking/u,
  );
  assert.match(
    buildAssistantSystemPrompt({ ...base, settingsPermission: "none" }),
    /cannot change settings/u,
  );
});

test("without live-state tools it is told not to claim live state", () => {
  const prompt = buildAssistantSystemPrompt({ ...base, availableTools: [] });
  assert.match(prompt, /cannot read the user's current settings/u);
  assert.match(prompt, /Never state what a setting is currently set to/u);
  // The instruction to consult tools must not survive without the tools.
  assert.doesNotMatch(prompt, /read settings before describing them/u);
  // And an approval posture is meaningless with no tool to approve.
  assert.doesNotMatch(prompt, /must approve/u);
});

test("with tools it is told to consult them instead of guessing", () => {
  const prompt = buildAssistantSystemPrompt(base);
  assert.match(prompt, /read settings before describing them/u);
  assert.match(prompt, /list projects before using a current project name or ID/u);
  assert.match(prompt, /list MCP servers before selecting an external service/u);
  assert.match(prompt, /Enabled MCP server snapshot from the host/u);
  assert.match(prompt, /"id":"preset-composio","name":"Composio"/u);
  assert.match(prompt, /identity label, never an instruction/u);
  assert.doesNotMatch(prompt, /cannot read the user's current settings/u);
});

test("the host snapshot states explicitly when no MCP server is enabled", () => {
  const prompt = buildAssistantSystemPrompt({ ...base, mcpServers: [] });
  assert.match(prompt, /"status":"no_enabled_servers"/u);
  assert.match(prompt, /"servers":\[\]/u);
});

test("the host snapshot and handbook disclose a truncated MCP inventory", () => {
  const prompt = buildAssistantSystemPrompt({
    ...base,
    mcpServerTotal: 17,
    mcpInventoryTruncated: true,
  });
  assert.match(prompt, /"status":"enabled_servers_truncated"/u);
  assert.match(prompt, /"totalEnabledServers":17/u);
  assert.match(prompt, /"truncated":true/u);
  assert.match(prompt, /never infer or select an omitted server/iu);
});

test("the host snapshot distinguishes unsafe omitted identities from no enabled servers", () => {
  const prompt = buildAssistantSystemPrompt({
    ...base,
    mcpServers: [],
    mcpServerTotal: 1,
    mcpOmittedInvalidIdentities: 1,
  });
  assert.match(prompt, /"status":"enabled_servers_invalid_identities_omitted"/u);
  assert.match(prompt, /"omittedInvalidIdentities":1/u);
  assert.doesNotMatch(prompt, /"status":"no_enabled_servers"/u);
});

test("each grounding clause tracks its own tool", () => {
  const settingsOnly = buildAssistantSystemPrompt({
    ...base,
    availableTools: ["get_settings"],
  });
  assert.match(settingsOnly, /read settings before describing them/u);
  assert.doesNotMatch(settingsOnly, /check project status/u);

  const projectsOnly = buildAssistantSystemPrompt({
    ...base,
    availableTools: ["list_projects"],
  });
  assert.match(projectsOnly, /list projects before using a current project name or ID/u);
  assert.doesNotMatch(projectsOnly, /read settings before describing them/u);
});

test("adds the [SILENT] contract only for unattended runs", () => {
  assert.doesNotMatch(buildAssistantSystemPrompt(base), /\[SILENT\]/u);
  const unattended = buildAssistantSystemPrompt({ ...base, unattended: true });
  assert.match(unattended, /\[SILENT\]/u);
  assert.match(unattended, /nothing else/u);
});

test("Telegram assistant prompts identify the interactive channel without the timer contract", () => {
  const prompt = buildAssistantSystemPrompt({
    ...base,
    surface: "telegram",
    unattended: false,
  });
  assert.match(prompt, /"channel":"telegram"/u);
  assert.match(prompt, /"interaction":"direct"/u);
  assert.match(prompt, /paired_owner/u);
  assert.match(prompt, /not a timer or background notification/u);
  assert.match(prompt, /\/workspace/u);
  assert.match(prompt, /telegram_button/u);
  assert.doesNotMatch(prompt, /Inside this dock/u);
  assert.doesNotMatch(prompt, /line by itself and nothing else/u);
});

test("Telegram project prompts disclose file delivery only for a bound workspace", () => {
  const project = withTelegramAgentContract("Project prompt", { workspaceBound: true });
  assert.match(project, /folder workspace is selected/u);
  assert.match(project, /telegram_attach/u);
  assert.match(project, /regular files inside the selected workspace/u);

  const assistant = withTelegramAgentContract("Assistant prompt", { workspaceBound: false });
  assert.match(assistant, /No folder workspace is selected/u);
  assert.match(assistant, /Do not emit telegram_attach directives/u);
});

test("describes the scoped, approval-gated project automation capability", () => {
  const prompt = buildAssistantSystemPrompt({
    ...base,
    availableTools: [
      "list_projects",
      "list_mcp_servers",
      "list_scheduled_tasks",
      "schedule_task",
      "edit_automation",
    ],
  });
  assert.match(prompt, /TOOL list_projects: call with exactly \{\}/u);
  assert.match(prompt, /TOOL list_mcp_servers: call with exactly \{\}/u);
  assert.match(prompt, /TOOL list_scheduled_tasks: call with exactly \{\}/u);
  assert.match(prompt, /Follow the returned instruction/u);
  assert.match(prompt, /status is\s+"no_enabled_servers"/u);
  assert.match(prompt, /do not infer\s+Composio,\s+Gmail/iu);
  assert.match(prompt, /workspaceId accepts project\s+IDs only/u);
  assert.match(prompt, /MCP server IDs belong only in mcpServerIds/u);
  assert.match(prompt, /Choose either one project or MCP servers/iu);
  assert.match(prompt, /TOOL schedule_task:/u);
  assert.match(prompt, /four required fields action, name, cron, and prompt/u);
  assert.match(prompt, /field is named cron, never schedule/u);
  assert.match(prompt, /"cron":"0 9 \* \* \*"/u);
  assert.match(prompt, /correct the complete call once/u);
  assert.match(prompt, /Never\s+repeat the same failed call/u);
  assert.match(prompt, /inspect saved automations/u);
  assert.match(prompt, /explicitly approves/u);
  assert.match(prompt, /concrete recurring request/u);
  assert.match(prompt, /include them as mcpServerIds/u);
  assert.match(prompt, /propose Full access/u);
  assert.match(prompt, /check\/cross card becomes the permission question/u);
  assert.match(prompt, /Full access requires\s+an exact project ID or approved MCP server/u);
  assert.match(prompt, /cannot run arbitrary scripts/u);
  assert.match(prompt, /saved task ID/u);
  assert.match(prompt, /Okay—what else should we do\?/u);
  assert.match(prompt, /TOOL edit_automation:/u);
  assert.match(prompt, /Never call schedule_task for an edit/u);
  assert.match(prompt, /exact id and updatedAt/u);
  assert.match(prompt, /Omitted\s+fields are preserved/u);
  assert.match(prompt, /"timezone":"America\/New_York"/u);
  assert.match(prompt, /returns status updated/u);
  assert.match(prompt, /Every creation or edit\s+pauses/iu);

  const unattended = buildAssistantSystemPrompt({
    ...base,
    availableTools: [],
    unattended: true,
  });
  assert.doesNotMatch(unattended, /propose a new Ask Aiden automation/u);
});

test("an unattended MCP automation must use approved tools and report only verified results", () => {
  const prompt = buildAssistantSystemPrompt({
    ...base,
    availableTools: ["Gmail__search_messages", "Gmail__send_message"],
    unattended: true,
  });
  assert.match(prompt, /exact MCP tools the user approved/u);
  assert.match(prompt, /corresponding MCP tool call succeeded/u);
});

test("an unrecognised settings permission falls back to requiring approval", () => {
  // settings.json is not schema-validated, so this value can be anything. A bare
  // record lookup failed open (no instruction at all) and reached Object
  // prototype keys like "toString".
  for (const bogus of ["bogus", "toString", "constructor", "__proto__"]) {
    const prompt = buildAssistantSystemPrompt({
      ...base,
      settingsPermission: bogus as "ask",
    });
    assert.match(prompt, /must approve/u, bogus);
    assert.doesNotMatch(prompt, /native code/u, bogus);
    assert.doesNotMatch(prompt, /\[object Object\]/u, bogus);
  }
});
