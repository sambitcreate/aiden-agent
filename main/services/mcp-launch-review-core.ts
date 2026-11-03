import { hasPlaintextMcpFields, mcpStdioLaunchFingerprint } from "./mcp-field-secrets-core.js";
import type { McpServer } from "./types.js";

/** JSON escaping makes whitespace and control characters part of the visible launch. Never log this text. */
export function mcpLaunchReviewText(effective: McpServer): string {
  return JSON.stringify({ command: effective.command ?? "", args: effective.args ?? [], env: effective.env ?? {} }, null, 2)
    .replace(/[\p{Cf}\p{Zl}\p{Zp}\u007f-\u009f]/gu, (character) =>
      character.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}

export interface McpLaunchReviewDependencies {
  seal(serverId: string): Promise<void>;
  configured(serverId: string): Promise<McpServer | undefined>;
  resolve(server: McpServer): Promise<McpServer>;
  confirm(effective: McpServer): Promise<boolean>;
  approve(server: McpServer, shownFingerprint: string): Promise<boolean>;
  isCurrent(): boolean;
}

/** Approval follows a successful encrypted publication and an exact, still-current effective launch review. */
export async function approveReviewedMcpLaunch(serverId: string, shownFingerprint: string, deps: McpLaunchReviewDependencies): Promise<boolean> {
  const currentDocument = () => { if (!deps.isCurrent()) throw new Error("The renderer document is no longer active."); };
  currentDocument();
  await deps.seal(serverId);
  const configured = await deps.configured(serverId);
  if (!configured || configured.transport !== "stdio" || mcpStdioLaunchFingerprint(configured) !== shownFingerprint) return false;
  if (hasPlaintextMcpFields(configured)) throw new Error("Save this connector’s environment in secure storage before approving it.");
  const effective = await deps.resolve(configured);
  const fingerprint = mcpStdioLaunchFingerprint(effective);
  currentDocument();
  if (!(await deps.confirm(effective))) throw new Error("Launch review cancelled.");
  currentDocument();
  const latest = await deps.configured(serverId);
  if (!latest || latest.transport !== "stdio" || hasPlaintextMcpFields(latest) || mcpStdioLaunchFingerprint(latest) !== shownFingerprint) return false;
  if (mcpStdioLaunchFingerprint(await deps.resolve(latest)) !== fingerprint) return false;
  currentDocument();
  return deps.approve(latest, shownFingerprint);
}
