import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GrabbedElementSourceLocation } from "../../../renderer/shared/browser-element-grab.js";
import type { RawGrabSourceHint } from "./grab-runtime/inspect-react.js";

const MAX_SOURCE_MAP_BYTES = 10 * 1024 * 1024;
const SOURCE_MAP_TIMEOUT_MS = 1_500;
const SOURCE_MAP_CACHE_LIMIT = 25;

const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < VLQ_CHARS.length; i += 1) {
  VLQ_LOOKUP[VLQ_CHARS.charCodeAt(i)] = i;
}

export interface DecodedSourcePosition {
  source: string;
  line: number;
  column: number;
}

interface ParsedSourceMapV3 {
  version: 3;
  sources: string[];
  sourceRoot?: string;
  mappings: string;
}

interface DecodedSegment {
  genCol: number;
  sourceIdx: number;
  origLine: number;
  origCol: number;
}

interface IndexedSourceMap {
  sources: string[];
  sourceRoot: string;
  lines: DecodedSegment[][];
}

/**
 * Compact standard Base64-VLQ Source Map v3 decoder (zero external dependencies).
 * Produces per-generated-line segment lists sorted by generated column.
 */
export function decodeSourceMapMappings(map: ParsedSourceMapV3): IndexedSourceMap {
  const lines: DecodedSegment[][] = [];
  let currentLine: DecodedSegment[] = [];
  const mappings = map.mappings;
  const len = mappings.length;
  let index = 0;

  let genCol = 0;
  let sourceIdx = 0;
  let origLine = 0;
  let origCol = 0;

  const decodeVlq = (): number | null => {
    let result = 0;
    let shift = 0;
    while (index < len) {
      const code = mappings.charCodeAt(index);
      const digit = code < 128 ? VLQ_LOOKUP[code] : -1;
      if (digit === -1) return null;
      index += 1;
      result += (digit & 31) << shift;
      shift += 5;
      if ((digit & 32) === 0) {
        const negative = (result & 1) === 1;
        const value = result >> 1;
        return negative ? -value : value;
      }
      if (shift > 30) return null;
    }
    return null;
  };

  while (index < len) {
    const ch = mappings.charCodeAt(index);
    if (ch === 59) {
      // ';'
      lines.push(currentLine);
      currentLine = [];
      genCol = 0;
      index += 1;
      continue;
    }
    if (ch === 44) {
      // ','
      index += 1;
      continue;
    }
    const genColDelta = decodeVlq();
    if (genColDelta === null) break;
    genCol += genColDelta;

    if (index < len && mappings.charCodeAt(index) !== 44 && mappings.charCodeAt(index) !== 59) {
      const srcDelta = decodeVlq();
      const lineDelta = decodeVlq();
      const colDelta = decodeVlq();
      if (srcDelta === null || lineDelta === null || colDelta === null) break;
      sourceIdx += srcDelta;
      origLine += lineDelta;
      origCol += colDelta;
      // Optional 5th field: name index delta (skip if present).
      if (index < len && mappings.charCodeAt(index) !== 44 && mappings.charCodeAt(index) !== 59) {
        decodeVlq();
      }
      currentLine.push({ genCol, sourceIdx, origLine, origCol });
    }
  }
  lines.push(currentLine);

  return {
    sources: map.sources,
    sourceRoot: typeof map.sourceRoot === "string" ? map.sourceRoot : "",
    lines,
  };
}

/** Looks up a 1-based generated `(line, column)` in an indexed Source Map v3. */
export function lookupOriginalPosition(
  indexed: IndexedSourceMap,
  generatedLine: number,
  generatedColumn: number,
): DecodedSourcePosition | null {
  if (generatedLine < 1 || generatedLine > indexed.lines.length) return null;
  const lineSegments = indexed.lines[generatedLine - 1];
  if (!lineSegments || lineSegments.length === 0) return null;
  const targetCol = Math.max(0, generatedColumn - 1);

  let lo = 0;
  let hi = lineSegments.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineSegments[mid]!.genCol <= targetCol) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const segment = best >= 0 ? lineSegments[best] : lineSegments[0];
  if (!segment) return null;
  const rawSource = indexed.sources[segment.sourceIdx];
  if (typeof rawSource !== "string" || !rawSource) return null;
  const combined =
    indexed.sourceRoot && !rawSource.startsWith("/") && !/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(rawSource)
      ? `${indexed.sourceRoot.replace(/\/+$/u, "")}/${rawSource.replace(/^\/+/u, "")}`
      : rawSource;
  return {
    source: combined,
    line: Math.max(1, segment.origLine + 1),
    column: Math.max(1, segment.origCol + 1),
  };
}

/**
 * Strict loopback-or-file-only URL guard. Never permits remote or LAN source-map fetches.
 */
export function isAllowedSourceMapUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * Normalizes Webpack, Turbopack, Vite, RSC, and file:// bundler paths into clean
 * workspace-relative (when inside `workspaceRoot`) or display paths.
 */
export function normalizeBundlerSourcePath(rawPath: string, workspaceRoot?: string): string {
  let cleaned = rawPath.trim();
  if (!cleaned) return "";

  // Strip query strings and fragments.
  cleaned = cleaned.replace(/[?#].*$/u, "");

  // Unwrap RSC server wrappers.
  cleaned = cleaned.replace(/^rsc:\/\/React\/Server\//iu, "");

  // Unwrap webpack-internal and webpack URLs.
  cleaned = cleaned.replace(
    /^webpack-internal:\/\/\/(?:\([^)]+\)\/)?\.?\//iu,
    "",
  );
  cleaned = cleaned.replace(/^webpack:\/\/[^/]*\/\.?\//iu, "");
  cleaned = cleaned.replace(/^webpack:\/\/\//iu, "");

  // Unwrap Turbopack prefixes.
  cleaned = cleaned.replace(/^turbopack:\/\/\/\[project\]\//iu, "");
  cleaned = cleaned.replace(/^turbopack:\/\/\//iu, "");
  cleaned = cleaned.replace(/^\[project\]\//iu, "");

  // Unwrap Vite /@fs/ absolute file prefixes.
  if (cleaned.startsWith("/@fs/")) {
    cleaned = cleaned.slice(4);
  } else {
    cleaned = cleaned.replace(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/@fs\//iu, "/");
  }

  // Decode file:// URLs.
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = fileURLToPath(cleaned);
    } catch {
      cleaned = cleaned.replace(/^file:\/\//iu, "");
    }
  }

  // Strip leading "./"
  cleaned = cleaned.replace(/^\.\//u, "");

  // Relativize against active workspace root when inside it.
  if (workspaceRoot && path.isAbsolute(cleaned)) {
    const resolvedRoot = path.resolve(workspaceRoot);
    const resolvedFile = path.resolve(cleaned);
    const rel = path.relative(resolvedRoot, resolvedFile);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      cleaned = rel.split(path.sep).join("/");
    }
  }

  return cleaned.slice(0, 512);
}

export interface ParsedStackFrame {
  url: string;
  line: number;
  column: number;
}

const IGNORED_STACK_URL_PATTERN =
  /\/node_modules\/|react-dom|react_jsx|scheduler\.development|webpack\/runtime|__vite\/client|@react-refresh/iu;

/** Extracts userland `(url, line, column)` frames from a React 19 `_debugStack` string. */
export function parseDebugStackFrames(debugStack: string): ParsedStackFrame[] {
  const frames: ParsedStackFrame[] = [];
  for (const rawLine of debugStack.split(/\r?\n/u).slice(0, 30)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Chrome/V8: "at Component (http://localhost:3000/src/App.tsx:42:13)" or "at http://..."
    const match =
      /\(([^()]+):(\d+):(\d+)\)\s*$/u.exec(line) ??
      /^\s*at\s+(?:async\s+)?([^\s()]+):(\d+):(\d+)\s*$/u.exec(line) ??
      /@([^\s@]+):(\d+):(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const url = match[1]!.trim();
    const lineNum = Number(match[2]);
    const colNum = Number(match[3]);
    if (!url || !Number.isSafeInteger(lineNum) || lineNum < 1 || !Number.isSafeInteger(colNum) || colNum < 1) {
      continue;
    }
    if (IGNORED_STACK_URL_PATTERN.test(url)) continue;
    frames.push({ url, line: lineNum, column: colNum });
  }
  return frames;
}

function extractSourceMappingUrl(jsContent: string): string | null {
  // Scan only the tail of the bundle where sourceMappingURL pragmas live.
  const tail = jsContent.slice(-4096);
  const matches = [...tail.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/gu)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1]![1] ?? null;
}

function parseInlineDataSourceMap(dataUrl: string): ParsedSourceMapV3 | null {
  const match = /^data:application\/json(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)$/iu.exec(dataUrl.trim());
  if (!match) return null;
  const base64 = match[1]!;
  if (Math.floor((base64.length * 3) / 4) > MAX_SOURCE_MAP_BYTES) return null;
  try {
    const parsed = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as Partial<ParsedSourceMapV3>;
    if (parsed.version === 3 && Array.isArray(parsed.sources) && typeof parsed.mappings === "string") {
      return parsed as ParsedSourceMapV3;
    }
  } catch {
    return null;
  }
  return null;
}

export interface SourceMapFetcherDeps {
  fetchImpl?: typeof fetch;
  readFileImpl?: (filePath: string) => Promise<Buffer>;
}

async function readBoundedResponseText(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_MAP_BYTES) return null;
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") <= MAX_SOURCE_MAP_BYTES ? text : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_SOURCE_MAP_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Local-only (loopback + `file://`) VLQ source-map resolver with 25-entry LRU cache,
 * `redirect: "error"`, 1500ms timeout, and 10 MB size cap.
 */
export class LocalGrabSourceMapResolver {
  private readonly cache = new Map<string, IndexedSourceMap | null>();
  private readonly fetchImpl: typeof fetch;
  private readonly readFileImpl: (filePath: string) => Promise<Buffer>;

  constructor(deps: SourceMapFetcherDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.readFileImpl = deps.readFileImpl ?? ((filePath) => readFile(filePath));
  }

  private cacheGet(key: string): IndexedSourceMap | null | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  private cacheSet(key: string, value: IndexedSourceMap | null): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > SOURCE_MAP_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchLocalText(url: string): Promise<string | null> {
    if (!isAllowedSourceMapUrl(url)) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "file:") {
        const filePath = fileURLToPath(parsed);
        const buf = await this.readFileImpl(filePath);
        if (buf.byteLength > MAX_SOURCE_MAP_BYTES) return null;
        return buf.toString("utf8");
      }
      const response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(SOURCE_MAP_TIMEOUT_MS),
      });
      return await readBoundedResponseText(response);
    } catch {
      return null;
    }
  }

  private async loadSourceMapForBundle(bundleUrl: string): Promise<IndexedSourceMap | null> {
    const cached = this.cacheGet(bundleUrl);
    if (cached !== undefined) return cached;
    if (!isAllowedSourceMapUrl(bundleUrl)) {
      return null;
    }

    let parsedMap: ParsedSourceMapV3 | null = null;
    const jsText = await this.fetchLocalText(bundleUrl);
    if (jsText) {
      const mappingRef = extractSourceMappingUrl(jsText);
      if (mappingRef) {
        if (mappingRef.startsWith("data:")) {
          parsedMap = parseInlineDataSourceMap(mappingRef);
        } else {
          try {
            const mapUrl = new URL(mappingRef, bundleUrl).href;
            const mapText = await this.fetchLocalText(mapUrl);
            if (mapText) {
              const json = JSON.parse(mapText) as Partial<ParsedSourceMapV3>;
              if (json.version === 3 && Array.isArray(json.sources) && typeof json.mappings === "string") {
                parsedMap = json as ParsedSourceMapV3;
              }
            }
          } catch {
            parsedMap = null;
          }
        }
      }
    }

    if (!parsedMap) {
      // Fallback: try <bundleUrl>.map directly if still allowed.
      try {
        const directMapUrl = `${bundleUrl.split(/[?#]/u)[0]}.map`;
        const mapText = await this.fetchLocalText(directMapUrl);
        if (mapText) {
          const json = JSON.parse(mapText) as Partial<ParsedSourceMapV3>;
          if (json.version === 3 && Array.isArray(json.sources) && typeof json.mappings === "string") {
            parsedMap = json as ParsedSourceMapV3;
          }
        }
      } catch {
        parsedMap = null;
      }
    }

    const indexed = parsedMap ? decodeSourceMapMappings(parsedMap) : null;
    this.cacheSet(bundleUrl, indexed);
    return indexed;
  }

  async resolveSourceHint(
    hint: RawGrabSourceHint | undefined,
    workspaceRoot?: string,
  ): Promise<GrabbedElementSourceLocation | undefined> {
    if (!hint) return undefined;

    if (hint.fileName) {
      const normalized = normalizeBundlerSourcePath(hint.fileName, workspaceRoot);
      if (normalized) {
        return {
          filePath: normalized,
          ...(hint.lineNumber !== undefined ? { line: hint.lineNumber } : {}),
          ...(hint.columnNumber !== undefined ? { column: hint.columnNumber } : {}),
          symbolicated: false,
        };
      }
    }

    if (hint.debugStack) {
      const frames = parseDebugStackFrames(hint.debugStack);
      for (const frame of frames.slice(0, 4)) {
        if (isAllowedSourceMapUrl(frame.url)) {
          const map = await this.loadSourceMapForBundle(frame.url);
          if (map) {
            const original = lookupOriginalPosition(map, frame.line, frame.column);
            if (original) {
              const filePath = normalizeBundlerSourcePath(original.source, workspaceRoot);
              if (filePath) {
                return {
                  filePath,
                  line: original.line,
                  column: original.column,
                  symbolicated: true,
                };
              }
            }
          }
        }
        const fallbackPath = normalizeBundlerSourcePath(frame.url, workspaceRoot);
        if (fallbackPath) {
          return {
            filePath: fallbackPath,
            line: frame.line,
            column: frame.column,
            symbolicated: false,
          };
        }
      }
    }

    return undefined;
  }
}

export const defaultGrabSourceMapResolver = new LocalGrabSourceMapResolver();
