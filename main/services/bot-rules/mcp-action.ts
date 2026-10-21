// The rules classifier's view of a mutating connection (MCP) tool call: its
// names, its summary, and the live server tool's title, description and
// destructiveness. Read-only tools are not classified, since they change
// nothing a rule covers. Arguments never reach the classifier.

import { summarizeToolCall } from "../coding-tools.js";
import { classifySubagentMcpToolV2 } from "../subagents/subagent-mcp-read.js";
import type { BotToolFacts } from "../bot-runtime/bot-tool-policy.js";
import type { BotClassifiableAction } from "./classify.js";

const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_TITLE_CHARS = 200;

type McpAnnotations = NonNullable<Extract<BotClassifiableAction, { surface: "mcp" }>["annotations"]>;

/** The plain, well-typed annotation hints only; anything else is dropped. */
function annotationsOf(value: unknown): McpAnnotations | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  };
  const annotations: McpAnnotations = {};
  const title = read("title");
  if (typeof title === "string" && title.length > 0) annotations.title = title.slice(0, MAX_TITLE_CHARS);
  for (const key of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
    const hint = read(key);
    if (typeof hint === "boolean") annotations[key] = hint;
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

/**
 * The `mcp` classifier input for `name`, or `undefined` when it is not a
 * granted, mutating connection tool.
 */
export async function describeMcpAction(
  name: string,
  args: unknown,
  facts: BotToolFacts,
): Promise<BotClassifiableAction | undefined> {
  const grant = (await facts.mcpTools()).get(name);
  if (grant === undefined || grant.effect !== "mutating") return undefined;
  const live = await facts.mcpToolDescriptor?.(name);
  const connection = facts.authority.connections.find((candidate) =>
    candidate.tools.some((tool) => tool === grant || tool.toolId === grant.toolId),
  );
  const effect = classifySubagentMcpToolV2(live?.annotations, live?.execution);
  const annotations = annotationsOf(live?.annotations);
  const description = typeof live?.description === "string" ? live.description.slice(0, MAX_DESCRIPTION_CHARS) : undefined;
  return {
    surface: "mcp",
    modelName: name,
    serverId: connection?.sourceId ?? "",
    remoteName: live?.name ?? grant.name,
    summary: summarizeToolCall(name, args),
    ...(description === undefined || description.length === 0 ? {} : { description }),
    ...(annotations === undefined ? {} : { annotations }),
    destructive: effect?.effect === "mutating" ? effect.effectProfile.destructive : "unknown",
  };
}
