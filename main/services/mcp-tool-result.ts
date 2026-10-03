import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonValue } from "@earendil-works/pi-ai";
import { boundedToolOutput } from "./tool-output-context.js";
import { MAX_STORED_TOOL_OUTPUT_CHARS } from "./tool-output-store.js";
import { validateDisplayImageDimensions } from "./display-image-extension.js";
import { copyBoundedJson, worstCaseJsonSize } from "./bounded-json.js";

export const MAX_MCP_RESULT_TEXT_CHARS = 32_000;
const MAX_PARTS = 64;
const OMITTED = "\n[MCP result truncated; additional content omitted.]";
export const MAX_MCP_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_MCP_IMAGES = 4;
export const MAX_MCP_STRUCTURED_CHARS = 128 * 1024;

/** Preserve complete JSON for programmatic callers, or omit it rather than silently alter values. */
function structuredContent(value: unknown): JsonValue | undefined {
  return copyBoundedJson(value, { maxNodes: 4096, maxDepth: 32, maxSize: MAX_MCP_STRUCTURED_CHARS, measure: worstCaseJsonSize });
}

/**
 * After the strict alphabet test and a length that is a multiple of four, the
 * only non-canonical base64 left is a set bit in the unused low bits before
 * the padding. Checking that one character replaces a full re-encode.
 */
function hasCanonicalPadding(data: string): boolean {
  if (data.endsWith("==")) return "AQgw".includes(data.charAt(data.length - 3));
  if (data.endsWith("=")) return "AEIMQUYcgkosw048".includes(data.charAt(data.length - 2));
  return true;
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
    if (!hasCanonicalPadding(image.data)) continue;
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length > MAX_MCP_IMAGE_BYTES) continue;
    try { validateDisplayImageDimensions(bytes, image.mimeType, "MCP image"); } catch { continue; }
    images.set(part, { type: "image", data: image.data, mimeType: image.mimeType });
  }
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
  const structured = result.structuredContent === undefined
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

export async function executeMcpAgentTool(
  callTool: () => Promise<unknown>,
): Promise<AgentToolResult<null>> {
  const result = await callTool();
  const images = imagesFor(result);
  const text = await boundedToolOutput(toText(result, MAX_STORED_TOOL_OUTPUT_CHARS, 2_048, images), MAX_MCP_RESULT_TEXT_CHARS);
  if ((result as { isError?: unknown } | null)?.isError === true) throw new Error(text);
  const structured = record(result) ? structuredContent(result.structuredContent) : undefined;
  return { content: [{ type: "text", text }, ...images.values()], details: null,
    ...(structured === undefined ? {} : { structuredContent: structured }) };
}
