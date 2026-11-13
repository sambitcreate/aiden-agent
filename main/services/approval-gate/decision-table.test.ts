// The approval decision table: what asks, what runs and what is refused,
// recorded from the code as it stood before the gate was extracted
// (docs/plans/bot-ux-simplification.md, Phase 1). Every expected value below
// is a literal outcome captured from that code; the scenarios drive the real
// entry points (the workspace decision llm-client calls, ACP's
// `answerPermission`, a Bot's `checkPolicy`, the Computer Use access gate and
// a subagent run grant). Phase 1 did not change a single row; Phases 2 and 3
// change only the rows marked "Phase 2" or "Phase 3", each listed in that
// phase's notes in the plan.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";

import { answerPermission } from "../acp/permissions.js";
import { RecordingHost } from "../acp/test-support.js";
import { createComputerUseAccessGate } from "../computer-use/access-gate.js";
import { SCHEDULE_TOOL_NAME, EDIT_AUTOMATION_TOOL_NAME } from "../schedule-tool.js";
import { SubagentRunGrantV2 } from "../subagents/approval-v2.js";
import type { SubagentAuthorityV2 } from "../subagents/authority-v2.js";
import { assemblyDeps, assemblyState, FULL_GRANTS, MAIL_SERVER, SEND_EMAIL_TOOL, testAuthority } from "../bot-runtime/test-support/assembly-fixtures.js";
import { countingTool } from "../bot-runtime/test-support/fixtures.js";
import type { BotClassifiableAction } from "../bot-rules/classify.js";
import { defaultBotRules, type BotRule } from "../../../renderer/shared/bot-rules.js";
import { workspaceToolApproval, type WorkspaceToolApprovalInput } from "./workspace-tool-approval.js";

type TableName = keyof typeof EXPECTED;
const RECORD = process.env.AIDEN_RECORD_APPROVAL_TABLE === "1";
const recorded: Partial<Record<TableName, Record<string, string>>> = {};
const seen: Partial<Record<TableName, Set<string>>> = {};

function check(table: TableName, key: string, actual: string): void {
  (seen[table] ??= new Set()).add(key);
  if (RECORD) {
    (recorded[table] ??= {})[key] = actual;
    return;
  }
  const expected: Readonly<Record<string, string>> = EXPECTED[table];
  assert.ok(key in expected, `no recorded outcome for ${table}: ${key}`);
  assert.equal(actual, expected[key], `${table}: ${key}`);
}

after(() => {
  if (RECORD) {
    process.stdout.write(`\nRECORDED ${JSON.stringify(recorded, null, 1)}\n`);
    return;
  }
  // Every recorded row must still be exercised: a dropped scenario is a lost oracle row.
  for (const table of Object.keys(EXPECTED) as TableName[]) {
    for (const key of Object.keys(EXPECTED[table])) assert.ok(seen[table]?.has(key), `${table}: ${key} was not exercised`);
  }
});

// ---------------------------------------------------------------- workspace

function workspaceOutcome(input: WorkspaceToolApprovalInput, remembered?: "chat" | "always"): string {
  let decided = workspaceToolApproval(input);
  if (decided.readsRemembered && remembered) decided = workspaceToolApproval({ ...input, remembered });
  const decision = decided.decision;
  switch (decision.outcome) {
    case "allow":
      return decision.via ? `allow:${decision.via}` : "allow";
    case "block":
      return `block:${decision.reason}`;
    case "memory":
      return "memory";
    case "ask":
      return decision.ruleTarget ? "ask:scopes" : "ask:once";
  }
}

/** One tool call per kind of workspace tool, with the arguments that matter. */
const WORKSPACE_CALLS: Record<string, Pick<WorkspaceToolApprovalInput, "toolName" | "args"> & Partial<WorkspaceToolApprovalInput>> = {
  "run_command": { toolName: "run_command", args: { command: "npm test" } },
  "edit_file": { toolName: "edit_file", args: { path: "src/a.ts", oldText: "a", newText: "b" } },
  "write_file": { toolName: "write_file", args: { path: "src/b.ts", content: "x" } },
  "read_file": { toolName: "read_file", args: { path: "src/a.ts" } },
  "list_files": { toolName: "list_files", args: { path: "." } },
  "web_search": { toolName: "web_search", args: { query: "weather" } },
  "browser_open": { toolName: "browser_open", args: { url: "https://example.com" } },
  "browser_open local file": { toolName: "browser_open", args: { url: "file:///w/index.html" }, browserFileRequired: true },
  "browser_click": { toolName: "browser_click", args: { ref: "e1" } },
  "browser_type": { toolName: "browser_type", args: { ref: "e1", text: "hi" } },
  "device_open": { toolName: "device_open", args: { id: "sim" } },
  "device_screenshot": { toolName: "device_screenshot", args: {} },
  "device_screenshot saveTo": { toolName: "device_screenshot", args: { saveTo: "shot.png" } },
  "background_job start": { toolName: "background_job", args: { action: "start", command: "npm run dev" } },
  "background_job read": { toolName: "background_job", args: { action: "read", job_id: "job_1a2b3c4d" } },
  "share_image": { toolName: "share_image", args: { path: "a.png" } },
  "generate_image": { toolName: "generate_image", args: { prompt: "a cat" } },
  "classify": { toolName: "classify", args: { provider: "p" } },
  "schedule create": { toolName: SCHEDULE_TOOL_NAME, args: { action: "create", title: "t" } },
  "schedule list": { toolName: SCHEDULE_TOOL_NAME, args: { action: "list" } },
  "edit_automation": { toolName: EDIT_AUTOMATION_TOOL_NAME, args: { id: "a" } },
  "remember_fact": { toolName: "remember_fact", args: { text: "likes tea" } },
  "forget_fact": { toolName: "forget_fact", args: { id: "f1" } },
  "workspace_artifact needing review": { toolName: "workspace_artifact", args: { action: "save" }, artifactRequired: true },
  "workspace_artifact read": { toolName: "workspace_artifact", args: { action: "list" } },
  "ask_user_question": { toolName: "ask_user_question", args: {} },
  "computer_use": { toolName: "computer_use", args: { action: "click" } },
  "form_fill": { toolName: "form_fill", args: {} },
};

for (const permission of ["full", "ask", "read-only", "none"] as const) {
  test(`workspace chat, ${permission} access, no hook`, () => {
    for (const [name, call] of Object.entries(WORKSPACE_CALLS)) {
      check("workspace", `${permission} | ${name}`, workspaceOutcome({ workspaceId: "ws-1", permission, ...call }));
    }
  });
}

const HOOK_CALLS = ["run_command", "edit_file", "read_file", "share_image", "schedule create", "remember_fact", "computer_use", "form_fill"];
for (const permission of ["full", "ask"] as const) {
  for (const hook of ["block", "ask", "allow"] as const) {
    test(`workspace chat, ${permission} access, hook ${hook}`, () => {
      for (const name of HOOK_CALLS) {
        const call = WORKSPACE_CALLS[name]!;
        check("workspace", `${permission} | hook ${hook} | ${name}`, workspaceOutcome({ workspaceId: "ws-1", permission, hook, ...call }));
      }
    });
  }
}

test("workspace chat, remembered approvals and their limits", () => {
  const cases: Record<string, [WorkspaceToolApprovalInput, ("chat" | "always")?]> = {
    "ask | run_command remembered for chat": [{ workspaceId: "ws-1", permission: "ask", toolName: "run_command", args: { command: "npm test" } }, "chat"],
    "ask | run_command remembered always": [{ workspaceId: "ws-1", permission: "ask", toolName: "run_command", args: { command: "npm test" } }, "always"],
    "ask | edit_file remembered always": [{ workspaceId: "ws-1", permission: "ask", toolName: "edit_file", args: { path: "src/a.ts" } }, "always"],
    "ask | write_file remembered for chat": [{ workspaceId: "ws-1", permission: "ask", toolName: "write_file", args: { path: "src/b.ts" } }, "chat"],
    "ask | browser_click remembered (not rememberable)": [{ workspaceId: "ws-1", permission: "ask", toolName: "browser_click", args: {} }, "always"],
    "ask | background_job start remembered (not rememberable)": [{ workspaceId: "ws-1", permission: "ask", toolName: "background_job", args: { action: "start" } }, "always"],
    "ask | run_command without a workspace": [{ permission: "ask", toolName: "run_command", args: { command: "npm test" } }, "always"],
    "ask | run_command with no command": [{ workspaceId: "ws-1", permission: "ask", toolName: "run_command", args: {} }, "always"],
    "ask | edit_file with a parent path": [{ workspaceId: "ws-1", permission: "ask", toolName: "edit_file", args: { path: "../x.ts" } }, "always"],
    "ask | Bot-bound run_command remembered": [{ workspaceId: "ws-1", permission: "ask", botBound: true, toolName: "run_command", args: { command: "ls" } }, "always"],
    "ask | Bot-bound run_command": [{ workspaceId: "ws-1", permission: "ask", botBound: true, toolName: "run_command", args: { command: "ls" } }],
    "full | Bot-bound mutating connection tool": [{ workspaceId: "ws-1", permission: "full", botBound: true, botMutating: true, toolName: "mail__send", args: {} }],
    "ask | Bot-bound mutating connection tool": [{ workspaceId: "ws-1", permission: "ask", botBound: true, botMutating: true, toolName: "mail__send", args: {} }],
    "ask | hook ask on remembered run_command": [{ workspaceId: "ws-1", permission: "ask", hook: "ask", toolName: "run_command", args: { command: "npm test" } }, "always"],
    "ask | hook allow without a rememberable target": [{ workspaceId: "ws-1", permission: "ask", hook: "allow", toolName: "run_command", args: {} }],
    "ask | hook allow on browser_click": [{ workspaceId: "ws-1", permission: "ask", hook: "allow", toolName: "browser_click", args: {} }],
  };
  for (const [name, [input, remembered]] of Object.entries(cases)) {
    check("workspace", name, workspaceOutcome(input, remembered));
  }
});

// ---------------------------------------------------------------------- ACP

function acpRequest(kind: ToolKind | undefined): RequestPermissionRequest {
  return {
    sessionId: "s",
    toolCall: { toolCallId: "t1", title: "Do it", ...(kind ? { kind } : {}), locations: [{ path: "/w/file.ts" }] },
    options: (["allow_once", "allow_always", "reject_once"] as const).map((option) => ({ optionId: option, name: option, kind: option })),
  };
}

test("ACP harness permission requests", async () => {
  for (const permission of ["full", "ask", "read-only", "none"] as const) {
    for (const kind of ["read", "search", "think", "execute", "edit", "delete", "move", "fetch", "other", undefined] as const) {
      const host = new RecordingHost("c", "/w");
      host.currentPermission = permission;
      host.approvalAnswer = "allow_once";
      const response = await answerPermission(acpRequest(kind), { kind: "approval" }, host, new AbortController().signal);
      const chosen = response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled";
      check("acp", `${permission} | ${kind ?? "no kind"}`, `${host.approvals.length > 0 ? "ask" : "no card"} → ${chosen}`);
    }
  }
});

// ---------------------------------------------------------------------- Bots

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function botHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "aiden-gate-bot-"));
  roots.push(home);
  return home;
}

const BOT_ACTIONS: Record<string, BotClassifiableAction> = {
  "purchase click": { surface: "computer_use", action: "click", app: "Safari", windowTitle: "Checkout", element: { role: "AXButton", label: "Place your order" } },
  "plain click": { surface: "computer_use", action: "click", app: "Notes", element: { role: "AXButton", label: "Bold" } },
  "password typing": { surface: "computer_use", action: "type", app: "Safari", focusedElement: { role: "AXSecureTextField", label: "Password" } },
};

const BOT_TURNS: Record<string, { requestIds: string[]; hasRoutineInputs?: true }> = {
  person: { requestIds: ["req-1"] },
  routine: { requestIds: ["routine:daily:fire-1"], hasRoutineInputs: true },
  telegram: { requestIds: ["tg:chat-1"] },
  "bot message": { requestIds: ["bot:J:1:00112233-4455-4677-8899-aabbccddeeff"] },
};

function rulesWith(purchase: BotRule["behavior"], communicate?: BotRule["behavior"]): BotRule[] {
  return defaultBotRules().map((rule) =>
    rule.actionClass === "purchase" ? { ...rule, behavior: purchase }
      : rule.actionClass === "communicate" && communicate ? { ...rule, behavior: communicate } : rule);
}

async function botOutcome(options: {
  toolName?: string;
  action: BotClassifiableAction;
  baseline: boolean;
  purchase: BotRule["behavior"];
  communicate?: BotRule["behavior"];
  turn: { requestIds: string[]; hasRoutineInputs?: true };
  goAhead: boolean;
}): Promise<string> {
  const state = assemblyState(testAuthority({ mode: "full", home: botHome(), ...FULL_GRANTS }));
  const deps = assemblyDeps(state, {
    candidates: () => [{ tool: countingTool(options.toolName ?? "computer_use"), ...(options.toolName === SEND_EMAIL_TOOL ? { mcp: true } : {}) }],
    rules: () => rulesWith(options.purchase, options.communicate),
    botName: "Ada",
    routinesGoAhead: () => options.goAhead,
    approvalFor: async () => ({
      approval: options.baseline ? { summary: "Click the button" } : null,
      action: options.action,
    }),
  });
  const decision = await deps.checkPolicy("bot-1", options.toolName ?? "computer_use", {
    callId: "call-1",
    args: { action: "click" },
    signal: undefined,
    requestIds: options.turn.requestIds,
    ...(options.turn.hasRoutineInputs ? { hasRoutineInputs: async () => true } : {}),
  });
  if (!decision.allowed) return `block: ${decision.reason}`;
  if (decision.handoff) return "hand off";
  if (!decision.approval) return "allow";
  if (decision.approval.preapproved) return "allow (go ahead)";
  return decision.approval.rule ? "ask (rule)" : "ask";
}

for (const [actionName, action] of Object.entries(BOT_ACTIONS)) {
  test(`Bot Computer Use call: ${actionName}`, async () => {
    for (const baseline of [true, false]) {
      for (const purchase of ["ask", "hand_off"] as const) {
        if (actionName !== "purchase click" && purchase !== "ask") continue;
        for (const [turnName, turn] of Object.entries(BOT_TURNS)) {
          for (const goAhead of turnName === "routine" ? [false, true] : [false]) {
            const key = `${actionName} | ${baseline ? "approval" : "no approval"} | purchase ${purchase} | ${turnName}${goAhead ? " | go ahead" : ""}`;
            check("bot", key, await botOutcome({ action, baseline, purchase, turn, goAhead }));
          }
        }
      }
    }
  });
}

test("Bot connection tool (send email)", async () => {
  const actions: Record<string, BotClassifiableAction> = {
    "send email": { surface: "mcp", modelName: SEND_EMAIL_TOOL, serverId: MAIL_SERVER.id, remoteName: "send_email", summary: "Send email", destructive: "additive" },
  };
  for (const [actionName, action] of Object.entries(actions)) {
    for (const baseline of [true, false]) {
      for (const purchase of ["ask", "hand_off"] as const) {
        for (const [turnName, turn] of Object.entries(BOT_TURNS)) {
          for (const goAhead of turnName === "routine" ? [false, true] : [false]) {
            const key = `${actionName} | ${baseline ? "approval" : "no approval"} | communicate ${purchase} | ${turnName}${goAhead ? " | go ahead" : ""}`;
            check("bot", key, await botOutcome({ toolName: SEND_EMAIL_TOOL, action, baseline, purchase, communicate: purchase, turn, goAhead }));
          }
        }
      }
    }
  }
});

test("Bot disclosure tool (share_image)", async () => {
  // A plain action no Bot rule matches: only the tool's class decides.
  for (const [turnName, turn] of Object.entries(BOT_TURNS)) {
    for (const goAhead of turnName === "routine" ? [false, true] : [false]) {
      const key = `share image | approval | ${turnName}${goAhead ? " | go ahead" : ""}`;
      check("bot", key, await botOutcome({ toolName: "share_image", action: BOT_ACTIONS["plain click"]!, baseline: true, purchase: "ask", turn, goAhead }));
    }
  }
});

// ----------------------------------------------------------- Computer Use access

async function computerUseOutcome(options: {
  granted: boolean;
  status: "ready" | "needs permissions" | "unavailable";
  answer: "allow" | "deny";
}): Promise<string> {
  let cards = 0;
  const gate = createComputerUseAccessGate({
    readGrant: async () => options.granted,
    status: async () =>
      options.status === "ready"
        ? { ready: true, available: true, detail: "Ready." }
        : options.status === "needs permissions"
          ? { ready: false, available: true, detail: "Allow Accessibility." }
          : { ready: false, available: false, detail: "Not supported." },
    requestAccess: async () => {
      cards += 1;
      return { outcome: options.answer === "allow" ? "allowed" : "denied", scope: "once" };
    },
    grantChat: async () => undefined,
    grantAlways: async () => undefined,
    setPendingContinue: async () => undefined,
    cancellationOrigin: () => undefined,
    warn: () => undefined,
  });
  const first = await gate.authorize("call-1");
  const second = await gate.authorize("call-2");
  const word = (decision: { allowed: boolean }) => (decision.allowed ? "allow" : "refuse");
  return `${word(first)}, then ${word(second)}; cards ${cards}`;
}

test("Computer Use access in a workspace chat", async () => {
  for (const granted of [false, true]) {
    for (const status of ["ready", "needs permissions", "unavailable"] as const) {
      for (const answer of ["allow", "deny"] as const) {
        check("computerUse", `${granted ? "granted" : "not granted"} | ${status} | answer ${answer}`,
          await computerUseOutcome({ granted, status, answer }));
      }
    }
  }
});

// ------------------------------------------------------------- subagent run grants

test("subagent implementer run grants", async () => {
  const authority = { expiresAt: Date.now() + 3_600_000, runId: "run-1" } as unknown as SubagentAuthorityV2;
  for (const permission of ["full", "ask", "none"] as const) {
    for (const answer of [true, false]) {
      let cards = 0;
      const grant = new SubagentRunGrantV2(authority, permission);
      const ask = async () => {
        cards += 1;
        return answer;
      };
      const first = await grant.ensure(authority, permission, ask);
      const second = await grant.ensure(authority, permission, ask);
      check("subagent", `${permission} | answer ${answer ? "allow" : "deny"}`,
        `${first ? "allow" : "refuse"}, then ${second ? "allow" : "refuse"}; cards ${cards}`);
    }
  }
});

// Recorded from the pre-gate code (AIDEN_RECORD_APPROVAL_TABLE=1 prints a fresh recording; never paste one over a failing row).
const EXPECTED = {
  workspace: {
    "full | run_command": "allow",
    "full | edit_file": "allow",
    "full | write_file": "allow",
    "full | read_file": "allow",
    "full | list_files": "allow",
    "full | web_search": "allow",
    "full | browser_open": "allow",
    "full | browser_open local file": "ask:once",
    "full | browser_click": "allow",
    "full | browser_type": "allow",
    "full | device_open": "allow",
    "full | device_screenshot": "allow",
    "full | device_screenshot saveTo": "allow",
    "full | background_job start": "allow",
    "full | background_job read": "allow",
    "full | share_image": "ask:once",
    "full | generate_image": "ask:once",
    "full | classify": "ask:once",
    "full | schedule create": "ask:once",
    "full | schedule list": "allow",
    "full | edit_automation": "ask:once",
    "full | remember_fact": "memory",
    "full | forget_fact": "memory",
    "full | workspace_artifact needing review": "ask:once",
    "full | workspace_artifact read": "allow",
    "full | ask_user_question": "allow",
    "full | computer_use": "allow",
    "full | form_fill": "ask:once",
    "ask | run_command": "ask:scopes",
    "ask | edit_file": "ask:scopes",
    "ask | write_file": "ask:scopes",
    "ask | read_file": "allow",
    "ask | list_files": "allow",
    "ask | web_search": "allow",
    "ask | browser_open": "allow",
    "ask | browser_open local file": "ask:once",
    "ask | browser_click": "ask:once",
    "ask | browser_type": "ask:once",
    "ask | device_open": "ask:once",
    "ask | device_screenshot": "allow",
    "ask | device_screenshot saveTo": "ask:once",
    "ask | background_job start": "ask:once",
    "ask | background_job read": "allow",
    "ask | share_image": "ask:once",
    "ask | generate_image": "ask:once",
    "ask | classify": "ask:once",
    "ask | schedule create": "ask:once",
    "ask | schedule list": "allow",
    "ask | edit_automation": "ask:once",
    "ask | remember_fact": "memory",
    "ask | forget_fact": "memory",
    "ask | workspace_artifact needing review": "ask:once",
    "ask | workspace_artifact read": "allow",
    "ask | ask_user_question": "allow",
    "ask | computer_use": "allow",
    "ask | form_fill": "ask:once",
    "read-only | run_command": "allow",
    "read-only | edit_file": "allow",
    "read-only | write_file": "allow",
    "read-only | read_file": "allow",
    "read-only | list_files": "allow",
    "read-only | web_search": "allow",
    "read-only | browser_open": "allow",
    "read-only | browser_open local file": "ask:once",
    "read-only | browser_click": "allow",
    "read-only | browser_type": "allow",
    "read-only | device_open": "allow",
    "read-only | device_screenshot": "allow",
    "read-only | device_screenshot saveTo": "allow",
    "read-only | background_job start": "allow",
    "read-only | background_job read": "allow",
    "read-only | share_image": "ask:once",
    "read-only | generate_image": "ask:once",
    "read-only | classify": "ask:once",
    "read-only | schedule create": "ask:once",
    "read-only | schedule list": "allow",
    "read-only | edit_automation": "ask:once",
    "read-only | remember_fact": "memory",
    "read-only | forget_fact": "memory",
    "read-only | workspace_artifact needing review": "ask:once",
    "read-only | workspace_artifact read": "allow",
    "read-only | ask_user_question": "allow",
    "read-only | computer_use": "allow",
    "read-only | form_fill": "ask:once",
    "none | run_command": "allow",
    "none | edit_file": "allow",
    "none | write_file": "allow",
    "none | read_file": "allow",
    "none | list_files": "allow",
    "none | web_search": "allow",
    "none | browser_open": "allow",
    "none | browser_open local file": "ask:once",
    "none | browser_click": "allow",
    "none | browser_type": "allow",
    "none | device_open": "allow",
    "none | device_screenshot": "allow",
    "none | device_screenshot saveTo": "allow",
    "none | background_job start": "allow",
    "none | background_job read": "allow",
    "none | share_image": "ask:once",
    "none | generate_image": "ask:once",
    "none | classify": "ask:once",
    "none | schedule create": "ask:once",
    "none | schedule list": "allow",
    "none | edit_automation": "ask:once",
    "none | remember_fact": "memory",
    "none | forget_fact": "memory",
    "none | workspace_artifact needing review": "ask:once",
    "none | workspace_artifact read": "allow",
    "none | ask_user_question": "allow",
    "none | computer_use": "allow",
    "none | form_fill": "ask:once",
    "full | hook block | run_command": "block:hook",
    "full | hook block | edit_file": "block:hook",
    "full | hook block | read_file": "block:hook",
    "full | hook block | share_image": "block:hook",
    "full | hook block | schedule create": "block:hook",
    "full | hook block | remember_fact": "block:hook",
    "full | hook block | computer_use": "block:hook",
    "full | hook block | form_fill": "block:hook",
    "full | hook ask | run_command": "ask:once",
    "full | hook ask | edit_file": "ask:once",
    "full | hook ask | read_file": "ask:once",
    "full | hook ask | share_image": "ask:once",
    "full | hook ask | schedule create": "ask:once",
    "full | hook ask | remember_fact": "memory",
    "full | hook ask | computer_use": "ask:once",
    "full | hook ask | form_fill": "ask:once",
    "full | hook allow | run_command": "allow",
    "full | hook allow | edit_file": "allow",
    "full | hook allow | read_file": "allow",
    "full | hook allow | share_image": "ask:once",
    "full | hook allow | schedule create": "ask:once",
    "full | hook allow | remember_fact": "memory",
    "full | hook allow | computer_use": "allow",
    "full | hook allow | form_fill": "ask:once",
    "ask | hook block | run_command": "block:hook",
    "ask | hook block | edit_file": "block:hook",
    "ask | hook block | read_file": "block:hook",
    "ask | hook block | share_image": "block:hook",
    "ask | hook block | schedule create": "block:hook",
    "ask | hook block | remember_fact": "block:hook",
    "ask | hook block | computer_use": "block:hook",
    "ask | hook block | form_fill": "block:hook",
    "ask | hook ask | run_command": "ask:once",
    "ask | hook ask | edit_file": "ask:once",
    "ask | hook ask | read_file": "ask:once",
    "ask | hook ask | share_image": "ask:once",
    "ask | hook ask | schedule create": "ask:once",
    "ask | hook ask | remember_fact": "memory",
    "ask | hook ask | computer_use": "ask:once",
    "ask | hook ask | form_fill": "ask:once",
    "ask | hook allow | run_command": "allow:hook-allow",
    "ask | hook allow | edit_file": "allow:hook-allow",
    "ask | hook allow | read_file": "allow",
    "ask | hook allow | share_image": "ask:once",
    "ask | hook allow | schedule create": "ask:once",
    "ask | hook allow | remember_fact": "memory",
    "ask | hook allow | computer_use": "allow",
    "ask | hook allow | form_fill": "ask:once",
    "ask | run_command remembered for chat": "allow:remembered",
    "ask | run_command remembered always": "allow:remembered",
    "ask | edit_file remembered always": "allow:remembered",
    "ask | write_file remembered for chat": "allow:remembered",
    "ask | browser_click remembered (not rememberable)": "ask:once",
    "ask | background_job start remembered (not rememberable)": "ask:once",
    "ask | run_command without a workspace": "ask:once",
    "ask | run_command with no command": "ask:once",
    "ask | edit_file with a parent path": "ask:once",
    "ask | Bot-bound run_command remembered": "ask:once",
    "ask | Bot-bound run_command": "ask:once",
    "full | Bot-bound mutating connection tool": "ask:once",
    "ask | Bot-bound mutating connection tool": "ask:once",
    "ask | hook ask on remembered run_command": "ask:once",
    "ask | hook allow without a rememberable target": "ask:once",
    "ask | hook allow on browser_click": "ask:once",
  },
  acp: {
    "full | read": "no card \u2192 allow_once",
    "full | search": "no card \u2192 allow_once",
    "full | think": "no card \u2192 allow_once",
    "full | execute": "no card \u2192 allow_once",
    "full | edit": "no card \u2192 allow_once",
    "full | delete": "no card \u2192 allow_once",
    "full | move": "no card \u2192 allow_once",
    "full | fetch": "no card \u2192 allow_once",
    "full | other": "no card \u2192 allow_once",
    "full | no kind": "no card \u2192 allow_once",
    "ask | read": "no card \u2192 allow_once",
    "ask | search": "no card \u2192 allow_once",
    "ask | think": "no card \u2192 allow_once",
    "ask | execute": "ask \u2192 allow_once",
    "ask | edit": "ask \u2192 allow_once",
    "ask | delete": "ask \u2192 allow_once",
    "ask | move": "ask \u2192 allow_once",
    "ask | fetch": "ask \u2192 allow_once",
    "ask | other": "ask \u2192 allow_once",
    "ask | no kind": "ask \u2192 allow_once",
    "read-only | read": "no card \u2192 allow_once",
    "read-only | search": "no card \u2192 allow_once",
    "read-only | think": "no card \u2192 allow_once",
    "read-only | execute": "no card \u2192 reject_once",
    "read-only | edit": "no card \u2192 reject_once",
    "read-only | delete": "no card \u2192 reject_once",
    "read-only | move": "no card \u2192 reject_once",
    "read-only | fetch": "no card \u2192 reject_once",
    "read-only | other": "no card \u2192 reject_once",
    "read-only | no kind": "no card \u2192 reject_once",
    "none | read": "no card \u2192 allow_once",
    "none | search": "no card \u2192 allow_once",
    "none | think": "no card \u2192 allow_once",
    "none | execute": "no card \u2192 reject_once",
    "none | edit": "no card \u2192 reject_once",
    "none | delete": "no card \u2192 reject_once",
    "none | move": "no card \u2192 reject_once",
    "none | fetch": "no card \u2192 reject_once",
    "none | other": "no card \u2192 reject_once",
    "none | no kind": "no card \u2192 reject_once",
  },
  bot: {
    "purchase click | approval | purchase ask | person": "ask (rule)",
    // Phase 2: a routine refuses where it would ask (plan §3.2 Unattended runs).
    "purchase click | approval | purchase ask | routine": "block: This step needs the person's OK, and nobody is here to give it during a routine, so it didn't run. Tell them in your reply.",
    // Phase 2: a routine refuses where it would ask (plan §3.2 Unattended runs).
    "purchase click | approval | purchase ask | routine | go ahead": "block: This step needs the person's OK, and nobody is here to give it during a routine, so it didn't run. Tell them in your reply.",
    "purchase click | approval | purchase ask | telegram": "ask (rule)",
    "purchase click | approval | purchase ask | bot message": "ask (rule)",
    "purchase click | approval | purchase hand_off | person": "hand off",
    "purchase click | approval | purchase hand_off | routine": "block: This needs the person (Make a purchase or booking). Tell them in your reply.",
    "purchase click | approval | purchase hand_off | routine | go ahead": "block: This needs the person (Make a purchase or booking). Tell them in your reply.",
    "purchase click | approval | purchase hand_off | telegram": "block: This needs the person (Make a purchase or booking). Tell them in your reply.",
    "purchase click | approval | purchase hand_off | bot message": "block: This needs the person (Make a purchase or booking). Tell them in your reply.",
    "purchase click | no approval | purchase ask | person": "ask (rule)",
    "purchase click | no approval | purchase ask | routine": "block: This needs the person's OK (Make a purchase or booking). Tell them in your reply.",
    "purchase click | no approval | purchase ask | routine | go ahead": "block: This needs the person's OK (Make a purchase or booking). Tell them in your reply.",
    "purchase click | no approval | purchase ask | telegram": "block: This needs the person's OK (Make a purchase or booking). Tell them in your reply.",
    "purchase click | no approval | purchase ask | bot message": "ask (rule)",
    "purchase click | no approval | purchase hand_off | person": "hand off",
    "purchase click | no approval | purchase hand_off | routine": "block: This needs the person (Make a purchase or booking). Tell them in your reply.",
    "purchase click | no approval | purchase hand_off | routine | go ahead": "block: This needs the person (Make a purchase or booking). Tell them in your reply.",
    "purchase click | no approval | purchase hand_off | telegram": "block: This needs the person (Make a purchase or booking). Tell them in your reply.",
    "purchase click | no approval | purchase hand_off | bot message": "block: This needs the person (Make a purchase or booking). Tell them in your reply.",
    "plain click | approval | purchase ask | person": "ask",
    // Phase 2: a routine refuses where it would ask (plan §3.2 Unattended runs).
    "plain click | approval | purchase ask | routine": "block: This step needs the person's OK, and nobody is here to give it during a routine, so it didn't run. Tell them in your reply.",
    // Phase 2: a routine refuses where it would ask (plan §3.2 Unattended runs).
    "plain click | approval | purchase ask | routine | go ahead": "block: This step needs the person's OK, and nobody is here to give it during a routine, so it didn't run. Tell them in your reply.",
    "plain click | approval | purchase ask | telegram": "ask",
    "plain click | approval | purchase ask | bot message": "ask",
    "plain click | no approval | purchase ask | person": "allow",
    "plain click | no approval | purchase ask | routine": "allow",
    "plain click | no approval | purchase ask | routine | go ahead": "allow",
    "plain click | no approval | purchase ask | telegram": "allow",
    "plain click | no approval | purchase ask | bot message": "allow",
    "password typing | approval | purchase ask | person": "hand off",
    "password typing | approval | purchase ask | routine": "block: This needs the person (Enter a password or 2FA code, or change account security). Tell them in your reply.",
    "password typing | approval | purchase ask | routine | go ahead": "block: This needs the person (Enter a password or 2FA code, or change account security). Tell them in your reply.",
    "password typing | approval | purchase ask | telegram": "block: This needs the person (Enter a password or 2FA code, or change account security). Tell them in your reply.",
    "password typing | approval | purchase ask | bot message": "block: This needs the person (Enter a password or 2FA code, or change account security). Tell them in your reply.",
    "password typing | no approval | purchase ask | person": "hand off",
    "password typing | no approval | purchase ask | routine": "block: This needs the person (Enter a password or 2FA code, or change account security). Tell them in your reply.",
    "password typing | no approval | purchase ask | routine | go ahead": "block: This needs the person (Enter a password or 2FA code, or change account security). Tell them in your reply.",
    "password typing | no approval | purchase ask | telegram": "block: This needs the person (Enter a password or 2FA code, or change account security). Tell them in your reply.",
    "password typing | no approval | purchase ask | bot message": "block: This needs the person (Enter a password or 2FA code, or change account security). Tell them in your reply.",
    "send email | approval | communicate ask | person": "ask (rule)",
    // Phase 2: a routine refuses where it would ask (plan §3.2 Unattended runs).
    "send email | approval | communicate ask | routine": "block: This step needs the person's OK, and nobody is here to give it during a routine, so it didn't run. Tell them in your reply.",
    "send email | approval | communicate ask | routine | go ahead": "allow (go ahead)",
    "send email | approval | communicate ask | telegram": "ask (rule)",
    "send email | approval | communicate ask | bot message": "ask (rule)",
    "send email | approval | communicate hand_off | person": "hand off",
    "send email | approval | communicate hand_off | routine": "block: This needs the person (Send a message or email to someone). Tell them in your reply.",
    "send email | approval | communicate hand_off | routine | go ahead": "block: This needs the person (Send a message or email to someone). Tell them in your reply.",
    "send email | approval | communicate hand_off | telegram": "block: This needs the person (Send a message or email to someone). Tell them in your reply.",
    "send email | approval | communicate hand_off | bot message": "block: This needs the person (Send a message or email to someone). Tell them in your reply.",
    "send email | no approval | communicate ask | person": "ask (rule)",
    "send email | no approval | communicate ask | routine": "block: This needs the person's OK (Send a message or email to someone). Tell them in your reply.",
    "send email | no approval | communicate ask | routine | go ahead": "allow (go ahead)",
    "send email | no approval | communicate ask | telegram": "block: This needs the person's OK (Send a message or email to someone). Tell them in your reply.",
    "send email | no approval | communicate ask | bot message": "ask (rule)",
    "send email | no approval | communicate hand_off | person": "hand off",
    "send email | no approval | communicate hand_off | routine": "block: This needs the person (Send a message or email to someone). Tell them in your reply.",
    "send email | no approval | communicate hand_off | routine | go ahead": "block: This needs the person (Send a message or email to someone). Tell them in your reply.",
    "send email | no approval | communicate hand_off | telegram": "block: This needs the person (Send a message or email to someone). Tell them in your reply.",
    "send email | no approval | communicate hand_off | bot message": "block: This needs the person (Send a message or email to someone). Tell them in your reply.",
    "share image | approval | person": "ask",
    "share image | approval | routine": "block: This step needs the person's OK, and nobody is here to give it during a routine, so it didn't run. Tell them in your reply.",
    // Phase 3: disclosure tools are explicit-only for Bots too (plan deviation e), so the routines go-ahead no longer shares.
    "share image | approval | routine | go ahead": "block: This step needs the person's OK, and nobody is here to give it during a routine, so it didn't run. Tell them in your reply.",
    "share image | approval | telegram": "ask",
    "share image | approval | bot message": "ask",
  },
  computerUse: {
    "not granted | ready | answer allow": "allow, then allow; cards 1",
    "not granted | ready | answer deny": "refuse, then refuse; cards 1",
    "not granted | needs permissions | answer allow": "refuse, then refuse; cards 1",
    "not granted | needs permissions | answer deny": "refuse, then refuse; cards 1",
    "not granted | unavailable | answer allow": "refuse, then refuse; cards 0",
    "not granted | unavailable | answer deny": "refuse, then refuse; cards 0",
    "granted | ready | answer allow": "allow, then allow; cards 0",
    "granted | ready | answer deny": "allow, then allow; cards 0",
    "granted | needs permissions | answer allow": "refuse, then refuse; cards 0",
    "granted | needs permissions | answer deny": "refuse, then refuse; cards 0",
    "granted | unavailable | answer allow": "refuse, then refuse; cards 0",
    "granted | unavailable | answer deny": "refuse, then refuse; cards 0",
  },
  subagent: {
    "full | answer allow": "allow, then allow; cards 0",
    "full | answer deny": "allow, then allow; cards 0",
    "ask | answer allow": "allow, then allow; cards 1",
    "ask | answer deny": "refuse, then refuse; cards 1",
    "none | answer allow": "refuse, then refuse; cards 0",
    "none | answer deny": "refuse, then refuse; cards 0",
  },
} as const satisfies Record<string, Record<string, string>>;
