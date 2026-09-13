import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export const MAX_MCP_RESULT_TEXT_CHARS = 32_000;
const MAX_PARTS = 64;
const OMITTED = "\n[MCP result truncated; additional content omitted.]";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Project JSON with bounded work before stringifying; never serialize an unknown envelope. */
function structuredText(value: unknown): string {
  let nodes = 0;
  let remaining = 8_000;
  let fieldsOmitted = false;
  const seen = new Set<object>();
  const project = (entry: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 6 || remaining <= 0) return "[omitted: limit]";
    if (typeof entry === "string") {
      const limit = Math.min(remaining, 2_000);
      const text = entry.slice(0, limit);
      remaining -= text.length;
      return entry.length > limit ? `${text}[truncated]` : text;
    }
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number") return Number.isFinite(entry) ? entry : "[invalid number]";
    if (typeof entry !== "object") return "[unsupported value]";
    if (seen.has(entry)) return "[omitted: cycle]";
    seen.add(entry);
    if (Array.isArray(entry)) {
      const output: unknown[] = [];
      for (let index = 0; index < Math.min(entry.length, 32); index += 1) {
        if (nodes >= 256 || remaining <= 0) break;
        output.push(project(entry[index], depth + 1));
      }
      if (output.length < entry.length) output.push("[omitted: items]");
      seen.delete(entry);
      return output;
    }
    const output: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in entry) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      if (count++ >= 32 || nodes >= 256 || remaining <= 0) {
        fieldsOmitted = true;
        break;
      }
      if (key.length > 128) {
        fieldsOmitted = true;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      remaining -= key.length;
      output[key] = descriptor && "value" in descriptor
        ? project(descriptor.value, depth + 1)
        : "[unsupported accessor]";
    }
    seen.delete(entry);
    return output;
  };
  const json = JSON.stringify(project(value, 0));
  return json + (fieldsOmitted ? "\n[Structured fields omitted: key or field limit.]" : "");
}

function toText(result: unknown): string {
  if (!record(result)) throw new Error("MCP tool returned an invalid result.");
  const parts: string[] = [];
  let remaining = MAX_MCP_RESULT_TEXT_CHARS - OMITTED.length;
  let truncated = false;
  const append = (text: string) => {
    const separator = parts.length ? "\n" : "";
    const limit = Math.max(0, remaining - separator.length);
    if (text.length > limit) truncated = true;
    if (limit > 0 && text.length) {
      const part = separator + text.slice(0, limit);
      parts.push(part);
      remaining -= part.length;
    }
  };
  // Reserve space for structured evidence even when the text part is huge.
  const structured = result.structuredContent === undefined
    ? undefined : `Structured content:\n${structuredText(result.structuredContent)}`;
  if (structured) {
    const limit = 16_000;
    append(structured.length > limit ? structured.slice(0, limit) + "\n[Structured content truncated.]" : structured);
  }
  if (Array.isArray(result.content)) {
    for (let index = 0; index < Math.min(result.content.length, MAX_PARTS); index += 1) {
      const part: unknown = result.content[index];
      if (!record(part)) append("[Invalid MCP content block omitted.]");
      else if (part.type === "text" && typeof part.text === "string") append(part.text);
      else if (part.type === "image") append("[MCP image omitted: this tool result supports text only.]");
      else if (part.type === "audio") append("[MCP audio omitted: this tool result supports text only.]");
      else if (part.type === "resource" || part.type === "resource_link") {
        append("[MCP resource omitted: no resource was fetched.]");
      } else append("[Unsupported MCP content block omitted.]");
      if (remaining <= 0) { truncated = true; break; }
    }
    if (result.content.length > MAX_PARTS) truncated = true;
  } else if (result.content !== undefined) {
    append("[Invalid MCP content list omitted.]");
  }
  return (parts.join("") || "MCP tool returned no result.") + (truncated ? OMITTED : "");
}

/**
 * Preserve MCP's resolved `isError` outcome as a thrown tool failure so Pi,
 * Activity, and claim checking all observe the same terminal state.
 */
export function mcpAgentToolResult(result: unknown): AgentToolResult<null> {
  const text = toText(result);
  if ((result as { isError?: unknown } | null)?.isError === true) {
    throw new Error(text);
  }
  return { content: [{ type: "text", text }], details: null };
}

export async function executeMcpAgentTool(
  callTool: () => Promise<unknown>,
): Promise<AgentToolResult<null>> {
  return mcpAgentToolResult(await callTool());
}
