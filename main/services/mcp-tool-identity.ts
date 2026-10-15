import { createHash } from "node:crypto";

/**
 * Model-facing MCP tool names.
 *
 * A name is `<server>__<tool>` where every character outside `[A-Za-z0-9_]`
 * becomes `_`, so the name is also the identifier a codemode script calls
 * (`tools.github__create_issue`). A stable hash suffix is added only when it is
 * needed: the name would exceed 64 characters, or two tools of one server
 * sanitize to the same name (then every tool in that group gets one). Two
 * configured servers whose prefixes collide each get a short hash of their id.
 *
 * Names depend only on the configured server list and the server's own tool
 * inventory, never on discovery order or timing, so the desktop foreground,
 * late-arriving tools, Bots, schedules and the CLI all agree. Authority (Bot
 * grants, schedule bindings, subagent scopes) is keyed on server id plus raw
 * tool name, never on these names.
 */

export const MCP_AGENT_TOOL_NAME_LIMIT = 64;
const SERVER_PREFIX_LIMIT = 24;

export interface McpToolNamingServer {
  readonly id: string;
  readonly name: string;
}

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function identifierPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

/** The readable server prefix before any collision suffix. */
function serverBase(server: McpToolNamingServer): string {
  let base = identifierPart((server.name.trim() || server.id).toLowerCase())
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (!base) base = "mcp";
  // Script identifiers cannot start with a digit.
  if (/^[0-9]/.test(base)) base = `mcp_${base}`;
  return base.slice(0, SERVER_PREFIX_LIMIT).replace(/_+$/g, "");
}

/**
 * The tool-name prefix for `server`, disambiguated against every configured
 * server. A prefix never contains `__` and never ends in `_`, so the first `__`
 * of a tool name always ends the server part.
 */
export function mcpServerToolPrefix(
  server: McpToolNamingServer,
  configured: readonly McpToolNamingServer[],
): string {
  const base = serverBase(server);
  const ids = new Set([server.id]);
  for (const peer of configured) {
    if (serverBase(peer) === base) ids.add(peer.id);
  }
  return ids.size > 1 ? `${base}_${digest(server.id, 6)}` : base;
}

/**
 * Model-facing names for one server's whole inventory, keyed by raw tool name.
 * Order-independent: the same configured servers and inventory always produce
 * the same map.
 */
export function mcpAgentToolNames(
  server: McpToolNamingServer,
  configured: readonly McpToolNamingServer[],
  inventory: readonly string[],
): ReadonlyMap<string, string> {
  const prefix = mcpServerToolPrefix(server, configured);
  const readable = new Map<string, string>();
  const groups = new Map<string, number>();
  for (const tool of new Set(inventory)) {
    const name = `${prefix}__${identifierPart(tool) || "tool"}`;
    readable.set(tool, name);
    groups.set(name, (groups.get(name) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const [tool, name] of readable) {
    if (name.length <= MCP_AGENT_TOOL_NAME_LIMIT && groups.get(name) === 1) {
      names.set(tool, name);
      continue;
    }
    const suffix = `_${digest(`${server.id}\0${tool}`, 8)}`;
    names.set(tool, `${name.slice(0, MCP_AGENT_TOOL_NAME_LIMIT - suffix.length)}${suffix}`);
  }
  return names;
}

/** The model-facing name of one tool; `scope.inventory` is the server's full tool list. */
export function mcpAgentToolName(
  server: McpToolNamingServer,
  toolName: string,
  scope: { configured: readonly McpToolNamingServer[]; inventory: readonly string[] },
): string {
  const inventory = scope.inventory.includes(toolName) ? scope.inventory : [...scope.inventory, toolName];
  return mcpAgentToolNames(server, scope.configured, inventory).get(toolName)!;
}

/**
 * A name for lanes that see only part of a server's inventory (a subagent's
 * approved scopes). With no inventory to compare against, any tool whose name
 * changed when sanitized gets the hash suffix, so two scoped tools can never
 * share a name whichever subset is approved.
 */
export function mcpScopedAgentToolName(
  server: McpToolNamingServer,
  toolName: string,
  configured: readonly McpToolNamingServer[] = [],
): string {
  const prefix = mcpServerToolPrefix(server, configured);
  const part = identifierPart(toolName);
  const name = `${prefix}__${part || "tool"}`;
  if (part === toolName && part && name.length <= MCP_AGENT_TOOL_NAME_LIMIT) return name;
  const suffix = `_${digest(`${server.id}\0${toolName}`, 8)}`;
  return `${name.slice(0, MCP_AGENT_TOOL_NAME_LIMIT - suffix.length)}${suffix}`;
}

/** Fold case and treat any run of separators (`-`, `_`, spaces) as one, for alias lookups. */
export function normalizeMcpNamespaceAlias(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function assertUniqueMcpAgentToolNames(tools: readonly { name: string }[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`MCP tool identity collision for "${tool.name}".`);
    }
    seen.add(tool.name);
  }
}

/** Host-owned identity of a built MCP tool: the server id and the raw remote tool name. */
export interface McpAgentToolIdentity {
  readonly serverId: string;
  readonly toolName: string;
}

const MCP_TOOL_IDENTITY = Symbol.for("aiden.mcpAgentToolIdentity");

/** Tag a built MCP agent tool with its real identity (survives object spread). */
export function markMcpAgentTool<T extends object>(tool: T, identity: McpAgentToolIdentity): T {
  return Object.assign(tool, { [MCP_TOOL_IDENTITY]: Object.freeze({ serverId: identity.serverId, toolName: identity.toolName }) });
}

/** The identity of an MCP agent tool, or undefined for any other tool. */
export function mcpAgentToolIdentity(tool: object): McpAgentToolIdentity | undefined {
  return (tool as { [MCP_TOOL_IDENTITY]?: McpAgentToolIdentity })[MCP_TOOL_IDENTITY];
}

/**
 * The `server/tool` presentation label of the MCP tool with this generated
 * name, for the Activity feed. Undefined for any non-MCP tool.
 */
export function mcpToolActivityLabel(
  tools: Iterable<{ readonly name: string; readonly label?: string }>,
  toolName: string,
): string | undefined {
  for (const tool of tools) {
    if (tool.name === toolName && mcpAgentToolIdentity(tool)) return tool.label || undefined;
  }
  return undefined;
}
