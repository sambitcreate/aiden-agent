// Pure parsing helpers for the phase-2 IPC handlers (Skills, MCP servers),
// extracted so they can be unit-tested without importing Electron.
// See handlers/phase2.ts.

import { asString } from "./voice-codec.js";
import type { McpServer, McpTransport, Skill } from "../services/types.js";

export function parseSkill(value: unknown): Skill {
  if (typeof value !== "object" || value === null) throw new Error("Invalid skill payload.");
  const s = value as Record<string, unknown>;
  return {
    id: asString(s.id, "id"),
    name: asString(s.name, "name"),
    description: typeof s.description === "string" ? s.description : "",
    instructions: typeof s.instructions === "string" ? s.instructions : "",
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
  };
}

export function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function parseMcpServer(value: unknown): McpServer {
  if (typeof value !== "object" || value === null) throw new Error("Invalid MCP server payload.");
  const s = value as Record<string, unknown>;
  const transport: McpTransport =
    s.transport === "http" || s.transport === "sse" ? s.transport : "stdio";
  const args = Array.isArray(s.args)
    ? s.args.filter((argument): argument is string => typeof argument === "string")
    : undefined;
  return {
    id: asString(s.id, "id"),
    name: asString(s.name, "name"),
    transport,
    command: typeof s.command === "string" ? s.command : undefined,
    args: args?.length ? args : undefined,
    env: parseStringRecord(s.env),
    url: typeof s.url === "string" ? s.url : undefined,
    headers: parseStringRecord(s.headers),
    oauth: typeof s.oauth === "boolean" ? s.oauth : undefined,
    presetId: typeof s.presetId === "string" && s.presetId ? s.presetId : undefined,
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
  };
}
