import type { ScheduledTask } from "./types.js";

export const ASSISTANT_SCHEDULE_EXECUTION_PROFILE = "assistant" as const;

type ScheduledTaskExecutionBoundary = Pick<
  ScheduledTask,
  | "executionProfile"
  | "mode"
  | "permission"
  | "script"
  | "workspaceId"
  | "mcpServerIds"
  | "mcpServerBindings"
  | "providerId"
  | "model"
  | "providerFingerprint"
>;

export const SCHEDULED_TASK_MCP_SERVER_LIMIT = 16;
export const SCHEDULED_TASK_MCP_SERVER_ID_LIMIT = 160;

function hasUnsafeMcpIdentityCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

/** Normalize the exact MCP identities persisted on a scheduled task. */
export function validateScheduledMcpServerIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > SCHEDULED_TASK_MCP_SERVER_LIMIT) {
    throw new Error(
      `Scheduled tasks may use at most ${SCHEDULED_TASK_MCP_SERVER_LIMIT} MCP servers.`,
    );
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") {
      throw new Error("Scheduled task MCP server IDs must be strings.");
    }
    const id = candidate.trim();
    if (
      !id ||
      id.length > SCHEDULED_TASK_MCP_SERVER_ID_LIMIT ||
      hasUnsafeMcpIdentityCharacter(id)
    ) {
      throw new Error("Scheduled task MCP server ID is invalid.");
    }
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/**
 * Assistant-created tasks remain LLM-only after persistence and UI edits.
 * Full access is valid only when the approval was bound to a concrete project
 * or at least one exact MCP server.
 */
export function assertAssistantScheduleExecutionBoundary(
  task: ScheduledTaskExecutionBoundary,
): void {
  const mcpServerIds = task.mcpServerIds ?? [];
  const hasMcpAccess = mcpServerIds.length > 0;
  if (task.workspaceId !== undefined && hasMcpAccess) {
    throw new Error(
      "Scheduled tasks must choose either one project or MCP servers, not both. Split local project work and external-service access into separate tasks.",
    );
  }
  if (task.executionProfile !== ASSISTANT_SCHEDULE_EXECUTION_PROFILE) return;
  const hasExactMcpBindings =
    !hasMcpAccess ||
    (task.mcpServerBindings?.length === mcpServerIds.length &&
      mcpServerIds.every((id, index) => task.mcpServerBindings?.[index]?.id === id));
  const hasPinnedRuntime = Boolean(
    task.providerId?.trim() &&
    task.model?.trim() &&
    /^[a-f0-9]{64}$/u.test(task.providerFingerprint ?? ""),
  );
  if (
    task.mode !== "llm" ||
    task.script !== undefined ||
    (task.permission === "full" && task.workspaceId === undefined && !hasMcpAccess) ||
    (hasMcpAccess && task.permission !== "full") ||
    !hasExactMcpBindings ||
    !hasPinnedRuntime
  ) {
    throw new Error(
      "Aiden-created automations must remain provider/model-pinned LLM tasks, choose either one project or exactly bound approved MCP servers, and Full access requires a project or exactly bound approved MCP server.",
    );
  }
}

export function scheduledTaskGenerationMode(
  task: Pick<ScheduledTask, "executionProfile" | "workspaceId">,
): "assistant-unattended" | "assistant-automation" | undefined {
  if (task.executionProfile !== ASSISTANT_SCHEDULE_EXECUTION_PROFILE) return undefined;
  return task.workspaceId ? "assistant-automation" : "assistant-unattended";
}

export function isSilentAssistantScheduleResponse(
  task: Pick<ScheduledTask, "executionProfile">,
  content: string,
): boolean {
  return (
    task.executionProfile === ASSISTANT_SCHEDULE_EXECUTION_PROFILE && content.trim() === "[SILENT]"
  );
}

const STRICT_THREAT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+(?:\w+\s+)*instructions/iu,
    "instruction override",
  ],
  [/do\s+not\s+tell\s+the\s+user/iu, "hidden action"],
  [/system\s+prompt\s+override/iu, "system prompt override"],
  [/disregard\s+(?:your|all|any)\s+(?:instructions|rules|guidelines)/iu, "instruction override"],
  [/\bcat\s+[^\n]*(?:\.env|credentials|\.netrc|\.pgpass)\b/iu, "secret access"],
  [/\bauthorized_keys\b/iu, "SSH key modification"],
  [/\/etc\/sudoers|\bvisudo\b/iu, "privilege escalation"],
  [/\brm\s+-rf\s+\/(?:\s|$)/iu, "destructive root command"],
];

const EXFILTRATION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:curl|wget)\s+[^\n]*https?:\/\/[^\s"']*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\w*\}?/iu,
    "secret exfiltration",
  ],
  [
    /\bcurl\s+[^\n]*(?:--data(?:-raw|-binary|-urlencode)?|-d|--form|-F)\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\w*\}?/iu,
    "secret exfiltration",
  ],
  [
    /\bwget\s+[^\n]*--post-(?:data|file)=[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\w*\}?/iu,
    "secret exfiltration",
  ],
  [
    /\bcurl\s+[^\n]*(?:-H|--header)\s+["']?(?:authorization|x-api-key)\s*:[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\w*\}?/iu,
    "secret exfiltration",
  ],
];

const INVISIBLE_UNICODE_POINTS = new Set([
  0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xfeff, 0xffa0,
]);
const ZWJ = "\u200d";
const VARIATION_SELECTOR = "\ufe0f";

function isEmojiCodePoint(value: string | undefined): boolean {
  if (value === undefined) return false;
  const codePoint = value.codePointAt(0) as number;
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1ffff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2300 && codePoint <= 0x23ff) ||
    (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) ||
    codePoint === 0x20e3
  );
}

function previousCodePoint(text: string, index: number): string | undefined {
  const prefix = text.slice(0, index).replace(new RegExp(`${VARIATION_SELECTOR}+$`, "u"), "");
  const codePoints = [...prefix];
  return codePoints[codePoints.length - 1];
}

function nextCodePoint(text: string, index: number): string | undefined {
  return [
    ...text.slice(index + ZWJ.length).replace(new RegExp(`^${VARIATION_SELECTOR}+`, "u"), ""),
  ][0];
}

function hasSuspiciousInvisibleUnicode(prompt: string): boolean {
  for (let index = 0; index < prompt.length; index += 1) {
    const character = prompt[index];
    const codePoint = character.codePointAt(0) as number;
    const invisible =
      INVISIBLE_UNICODE_POINTS.has(codePoint) ||
      (codePoint >= 0x180b && codePoint <= 0x180f) ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x206f);
    if (!invisible) continue;
    if (
      character === ZWJ &&
      isEmojiCodePoint(previousCodePoint(prompt, index)) &&
      isEmojiCodePoint(nextCodePoint(prompt, index))
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function assertSafeScheduledPrompt(prompt: string): void {
  if (hasSuspiciousInvisibleUnicode(prompt)) {
    throw new Error("Scheduled task prompt contains hidden Unicode characters.");
  }
  for (const [pattern, label] of [...STRICT_THREAT_PATTERNS, ...EXFILTRATION_PATTERNS]) {
    if (pattern.test(prompt)) {
      throw new Error(`Scheduled task prompt was blocked for possible ${label}.`);
    }
  }
}

export function recommendedScheduledPermission(prompt: string): "read-only" | "full" {
  return /\b(?:edit|modify|update|fix|format|append|rename|move|delete|remove|commit|push|merge|rebase|checkout|install|deploy|publish|send)\b|\bopen\s+(?:a\s+|the\s+)?(?:pull request|pr)\b|\b(?:write|create)\s+(?:a\s+|the\s+)?(?:file|folder|directory|code|script|commit|branch)\b|\b(?:run|execute)\s+(?:a\s+|the\s+)?(?:command|script|test|build|program)\b/iu.test(
    prompt,
  )
    ? "full"
    : "read-only";
}
