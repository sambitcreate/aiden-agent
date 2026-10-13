import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonValue } from "@earendil-works/pi-ai";
import { boundedToolOutput, truncateMiddle } from "./tool-output-context.js";
import { MAX_STORED_TOOL_OUTPUT_CHARS } from "./tool-output-store.js";
import { hasCanonicalBase64Padding, validateDisplayImageDimensions } from "./display-image-extension.js";
import { copyBoundedJson, utf8Size, worstCaseJsonSize } from "./bounded-json.js";
import { textCarriesStructured } from "./mcp-structured-text.js";

export { textCarriesStructured };

export const MAX_MCP_RESULT_TEXT_CHARS = 32_000;
const MAX_PARTS = 64;
const OMITTED = "\n[MCP result truncated; additional content omitted.]";
export const MAX_MCP_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_MCP_IMAGES = 4;
export const MAX_MCP_STRUCTURED_CHARS = 128 * 1024;
/** Codemode scripts see far more than the model: their output is what reaches the model. */
export const MAX_MCP_SCRIPT_CONTENT_BYTES = 2 * 1024 * 1024;
export const MAX_MCP_SCRIPT_STRUCTURED_BYTES = 1024 * 1024;
const MAX_SCRIPT_PARTS = 256;
export const MCP_STRUCTURED_OMITTED = "[structuredContent omitted: too large]";

/** Preserve complete JSON for programmatic callers, or omit it rather than silently alter values. */
function structuredContent(value: unknown): JsonValue | undefined {
  return copyBoundedJson(value, { maxNodes: 4096, maxDepth: 32, maxSize: MAX_MCP_STRUCTURED_CHARS, measure: worstCaseJsonSize });
}

function imagesFor(result: unknown): Map<unknown, ImageContent> {
  const images = new Map<unknown, ImageContent>();
  if (!record(result) || !Array.isArray(result.content)) return images;
  for (const part of result.content.slice(0, MAX_PARTS)) {
    if (images.size >= MAX_MCP_IMAGES) break;
    if (!record(part)) continue;
    const image = part.type === "image" ? part
      : part.type === "resource" && record(part.resource) && typeof part.resource.text !== "string"
        ? { data: part.resource.blob, mimeType: part.resource.mimeType } : undefined;
    if (!image || typeof image.data !== "string" ||
      typeof image.mimeType !== "string" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mimeType) ||
      image.data.length > Math.ceil(MAX_MCP_IMAGE_BYTES / 3) * 4 || image.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(image.data)) continue;
    if (!hasCanonicalBase64Padding(image.data)) continue;
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length > MAX_MCP_IMAGE_BYTES) continue;
    try { validateDisplayImageDimensions(bytes, image.mimeType, "MCP image"); } catch { continue; }
    images.set(part, { type: "image", data: image.data, mimeType: image.mimeType });
  }
  return images;
}

/** Resource reads share the exact raster validation and output budgets of tool results. */
export function mcpResourceImages(contents: readonly unknown[]): Map<number, ImageContent> {
  const blocks = contents.slice(0, MAX_PARTS).map((resource) => ({ type: "resource", resource }));
  const validated = imagesFor({ content: blocks });
  const images = new Map<number, ImageContent>();
  blocks.forEach((block, index) => {
    const image = validated.get(block);
    if (image) images.set(index, image);
  });
  return images;
}

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

function toText(result: unknown, maxChars = MAX_MCP_RESULT_TEXT_CHARS, maxParts = MAX_PARTS, images = new Map<unknown, ImageContent>()): string {
  if (!record(result)) throw new Error("MCP tool returned an invalid result.");
  const parts: string[] = [];
  let remaining = maxChars - OMITTED.length;
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
  // MCP servers SHOULD also serialize structured content into a text block;
  // when one already carries the same JSON, the model reads it once.
  const structured = result.structuredContent === undefined || textCarriesStructured(result.content, result.structuredContent)
    ? undefined : `Structured content:\n${structuredText(result.structuredContent)}`;
  if (structured) {
    const limit = 16_000;
    append(structured.length > limit ? structured.slice(0, limit) + "\n[Structured content truncated.]" : structured);
  }
  if (Array.isArray(result.content)) {
    for (let index = 0; index < Math.min(result.content.length, maxParts); index += 1) {
      const part: unknown = result.content[index];
      if (!record(part)) append("[Invalid MCP content block omitted.]");
      else if (part.type === "text" && typeof part.text === "string") append(part.text);
      else if (part.type === "image") append(images.has(part)
        ? "[MCP image attached for vision-capable models.]"
        : "[MCP image omitted: invalid, unsupported, or above the image limit.]");
      else if (part.type === "audio") append("[MCP audio omitted: this tool result supports text and raster images.]");
      else if (part.type === "resource" && record(part.resource)) {
        const resource = part.resource;
        if (typeof resource.text === "string") append(resource.text);
        else append(images.has(part)
          ? "[Embedded MCP resource image attached for vision-capable models.]"
          : "[Embedded MCP resource omitted: unsupported, invalid, or above the image limit.]");
      } else if (part.type === "resource_link" && typeof part.uri === "string") {
        append(`MCP resource link (no resource was fetched): ${structuredText({
          uri: part.uri, ...(typeof part.name === "string" ? { name: part.name } : {}),
          ...(typeof part.description === "string" ? { description: part.description } : {}),
          ...(typeof part.mimeType === "string" ? { mimeType: part.mimeType } : {}),
        })}`);
      } else append("[Unsupported MCP content block omitted.]");
      if (remaining <= 0) { truncated = true; break; }
    }
    if (result.content.length > maxParts) truncated = true;
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
  const images = imagesFor(result);
  const text = toText(result, MAX_MCP_RESULT_TEXT_CHARS, MAX_PARTS, images);
  if ((result as { isError?: unknown } | null)?.isError === true) {
    throw new Error(text);
  }
  const structured = record(result) ? structuredContent(result.structuredContent) : undefined;
  return { content: [{ type: "text", text }, ...images.values()], details: null,
    ...(structured === undefined ? {} : { structuredContent: structured }) };
}

/** What a codemode script receives from an MCP call: the server's result, bounded far above the model's view. */
export interface McpScriptResult {
  content: JsonValue[];
  structuredContent?: JsonValue;
  isError: boolean;
}

interface ScriptCapture {
  record?: { content?: readonly unknown[]; errorText?: string; result: McpScriptResult };
}
const scriptCapture = new AsyncLocalStorage<ScriptCapture>();

/**
 * Run one nested (codemode) tool call and return the script-facing MCP result
 * it produced, if any. The large form is used only when the outcome still
 * carries the exact model-facing result the MCP tool returned: a hook that
 * replaced or blocked it (permissions, durable-effect faults) wins.
 */
export async function captureMcpScriptResult<T extends { result: { content: readonly unknown[] }; isError: boolean }>(
  run: () => Promise<T>,
): Promise<{ outcome: T; script?: McpScriptResult }> {
  const capture: ScriptCapture = {};
  const outcome = await scriptCapture.run(capture, run);
  const captured = capture.record;
  if (!captured) return { outcome };
  const [first] = outcome.result.content;
  const unchanged = captured.content !== undefined
    ? !outcome.isError && outcome.result.content === captured.content
    : outcome.isError && outcome.result.content.length === 1 && record(first) && first.text === captured.errorText;
  return unchanged ? { outcome, script: captured.result } : { outcome };
}

/** Bounded, protocol-shaped copy of an MCP result for scripts; omissions are explicit. */
export function mcpScriptResult(result: unknown): McpScriptResult {
  const content: JsonValue[] = [];
  let remaining = MAX_MCP_SCRIPT_CONTENT_BYTES;
  const blocks = record(result) && Array.isArray(result.content) ? result.content : [];
  for (const block of blocks.slice(0, MAX_SCRIPT_PARTS)) {
    const copy = remaining > 0
      ? copyBoundedJson(block, { maxNodes: 4096, maxDepth: 16, maxSize: remaining, measure: utf8Size, ordinaryObjects: true })
      : undefined;
    if (copy !== undefined && record(copy)) {
      content.push(copy);
      remaining -= utf8Size(JSON.stringify(copy));
    } else if (record(block) && block.type === "text" && typeof block.text === "string" && remaining > 1024) {
      // Keep both ends of oversized text; a UTF-16 unit is at most 3 UTF-8 bytes.
      const total = block.text.length;
      const text = truncateMiddle(block.text, Math.floor((remaining - 256) / 3),
        (omitted) => `\n[MCP text truncated: ${omitted} of ${total} characters omitted from the middle.]\n`);
      content.push({ type: "text", text });
      remaining -= utf8Size(text) + 32;
    } else {
      const type = record(block) && typeof block.type === "string" ? block.type.slice(0, 32) : "invalid";
      content.push({ type: "text", text: `[MCP ${type} content block omitted: too large or invalid.]` });
    }
  }
  if (blocks.length > MAX_SCRIPT_PARTS) content.push({ type: "text", text: `[${blocks.length - MAX_SCRIPT_PARTS} MCP content blocks omitted: block limit.]` });
  const raw = record(result) ? result.structuredContent : undefined;
  const structured = raw === undefined ? undefined
    : copyBoundedJson(raw, { maxNodes: 200_000, maxDepth: 64, maxSize: MAX_MCP_SCRIPT_STRUCTURED_BYTES, measure: utf8Size, ordinaryObjects: true });
  if (raw !== undefined && structured === undefined) content.push({ type: "text", text: MCP_STRUCTURED_OMITTED });
  return { content, ...(structured === undefined ? {} : { structuredContent: structured }), isError: record(result) && result.isError === true };
}

export async function executeMcpAgentTool(
  callTool: () => Promise<unknown>,
): Promise<AgentToolResult<null>> {
  const result = await callTool();
  const capture = scriptCapture.getStore();
  const images = imagesFor(result);
  const text = await boundedToolOutput(toText(result, MAX_STORED_TOOL_OUTPUT_CHARS, 2_048, images), MAX_MCP_RESULT_TEXT_CHARS);
  if ((result as { isError?: unknown } | null)?.isError === true) {
    if (capture) capture.record = { errorText: text, result: mcpScriptResult(result) };
    throw new Error(text);
  }
  const structured = record(result) ? structuredContent(result.structuredContent) : undefined;
  const content: AgentToolResult<null>["content"] = [{ type: "text", text }, ...images.values()];
  if (capture) capture.record = { content, result: mcpScriptResult(result) };
  return { content, details: null,
    ...(structured === undefined ? {} : { structuredContent: structured }) };
}

export const MAX_MCP_TOOL_DESCRIPTION_CHARS = 1024;
const MAX_LABEL_PART_CHARS = 64;

function displayText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Model- and Activity-facing presentation of one MCP tool: a bounded
 * description that falls back to the tool's title, a `server/tool` label from
 * display names, and the tool's structured-content schema when it declares one.
 */
export function mcpAgentToolPresentation(
  serverName: string,
  tool: { name: string; title?: unknown; description?: unknown; annotations?: unknown; outputSchema?: unknown },
): { label: string; description: string; outputSchema?: Record<string, unknown> } {
  const title = displayText(tool.title, MAX_MCP_TOOL_DESCRIPTION_CHARS) ??
    (record(tool.annotations) ? displayText(tool.annotations.title, MAX_MCP_TOOL_DESCRIPTION_CHARS) : undefined);
  const raw = typeof tool.description === "string" && tool.description.trim() ? tool.description.trim() : title ?? tool.name;
  const description = raw.length > MAX_MCP_TOOL_DESCRIPTION_CHARS
    ? `${raw.slice(0, MAX_MCP_TOOL_DESCRIPTION_CHARS - 1)}…` : raw;
  const server = displayText(serverName, MAX_LABEL_PART_CHARS) ?? "MCP";
  const label = `${server}/${displayText(title, MAX_LABEL_PART_CHARS) ?? displayText(tool.name, MAX_LABEL_PART_CHARS) ?? "tool"}`;
  return { label, description, ...(record(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}) };
}
