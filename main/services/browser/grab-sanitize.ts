import { randomUUID } from "node:crypto";
import {
  GRABBED_ELEMENT_FRAMEWORKS,
  GRABBED_ELEMENT_SCHEMA_VERSION,
  parseGrabbedElements,
  type GrabbedElementComponentFrame,
  type GrabbedElementContextV1,
  type GrabbedElementFramework,
} from "../../../renderer/shared/browser-element-grab.js";
import { browserDisplayUrl, browserMeasuredViewport } from "./core.js";
import type { CssRect } from "./credential-fields.js";
import type { RawGrabComponentFrame, RawGrabSourceHint } from "./grab-runtime/inspect-react.js";
import {
  defaultGrabSourceMapResolver,
  sameGrabSourceAuthority,
  type LocalGrabSourceMapResolver,
} from "./grab-source-map.js";

const FRAMEWORK_SET = new Set<string>(GRABBED_ELEMENT_FRAMEWORKS);
const TAG_NAME_PATTERN = /^[a-z][a-z0-9:_-]{0,63}$/u;
const SECRET_KEY_PATTERN =
  /pass|secret|token|auth|api[_-]?key|cookie|session|credit|card|cvv|cvc|ssn|bearer|jwt|private|credential/iu;
/** A field's live contents travel under these keys whatever the field is. */
const VALUE_KEY_PATTERN = /^(?:default)?value$/iu;
/** On a credential field only these describe the field rather than hold its contents. */
const SENSITIVE_FIELD_SAFE_KEYS = new Set(["type", "autocomplete", "inputmode"]);
const CREDENTIAL_AUTOCOMPLETE_PATTERN = /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:\s|$)/iu;
const SECRET_VALUE_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu;

export interface SanitizeGrabOptions {
  /** Authoritative URL from `webContents.getURL()` — never trust guest `location.href`. */
  pageUrl: string;
  /**
   * Authoritative URL recorded when the grab started. When the page has since
   * moved to another origin, the payload's stack belongs to the old page, so no
   * source hint is resolved or reported.
   */
  grabPageUrl?: string;
  /** Authoritative title from `webContents.getTitle()`. */
  pageTitle?: string;
  workspaceRoot?: string;
  zoomFactor?: number;
  id?: string;
  capturedAt?: number;
  sourceMapResolver?: LocalGrabSourceMapResolver;
}

export interface SanitizedGrabResult {
  element: GrabbedElementContextV1;
  keepActive: boolean;
  measuredViewport?: { width: number; height: number };
  sensitiveRects: CssRect[];
}

function stripUrlCredentials(rawUrl: string): string {
  const display = browserDisplayUrl(rawUrl);
  try {
    const parsed = new URL(display);
    parsed.username = "";
    parsed.password = "";
    return parsed.href.slice(0, 2048);
  } catch {
    return (display || "about:blank").slice(0, 2048);
  }
}

export function redactGrabSecrets(value: string): string {
  return value.replace(SECRET_VALUE_PATTERN, "[redacted]");
}

function cleanString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = redactGrabSecrets(value).trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxChars) : undefined;
}

function sanitizeSourceHint(raw: unknown): RawGrabSourceHint | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const hint: RawGrabSourceHint = {};
  if (typeof rec.fileName === "string" && rec.fileName.trim()) {
    hint.fileName = rec.fileName.trim().slice(0, 512);
  }
  if (typeof rec.lineNumber === "number" && Number.isSafeInteger(rec.lineNumber) && rec.lineNumber >= 1) {
    hint.lineNumber = rec.lineNumber;
  }
  if (typeof rec.columnNumber === "number" && Number.isSafeInteger(rec.columnNumber) && rec.columnNumber >= 1) {
    hint.columnNumber = rec.columnNumber;
  }
  if (typeof rec.debugStack === "string" && rec.debugStack.length > 0) {
    hint.debugStack = rec.debugStack.slice(0, 4096);
  }
  return hint.fileName || hint.debugStack ? hint : undefined;
}

function propsDescribeSensitiveField(props: Record<string, unknown>): boolean {
  const type = props.type;
  if (typeof type === "string" && type.trim().toLowerCase() === "password") return true;
  return [props.autoComplete, props.autocomplete].some(
    (value) => typeof value === "string" && CREDENTIAL_AUTOCOMPLETE_PATTERN.test(value),
  );
}

function sanitizeProps(
  raw: unknown,
  sensitiveTarget: boolean,
): Record<string, string | number | boolean | null> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries = raw as Record<string, unknown>;
  // A password, one-time-code or card field keeps only the props that describe it.
  const sensitive = sensitiveTarget || propsDescribeSensitiveField(entries);
  const out: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const [key, val] of Object.entries(entries)) {
    if (count >= 12) break;
    if (!key || key.length > 80 || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (
      SECRET_KEY_PATTERN.test(key) ||
      VALUE_KEY_PATTERN.test(key) ||
      (sensitive && (typeof val === "string" || typeof val === "number") &&
        !SENSITIVE_FIELD_SAFE_KEYS.has(key.toLowerCase()))
    ) {
      out[key] = "[redacted]";
      count += 1;
      continue;
    }
    if (val === null || typeof val === "boolean") {
      out[key] = val;
      count += 1;
    } else if (typeof val === "number" && Number.isFinite(val)) {
      out[key] = val;
      count += 1;
    } else if (typeof val === "string") {
      out[key] = redactGrabSecrets(val).slice(0, 256);
      count += 1;
    }
  }
  return count > 0 ? out : undefined;
}

function sanitizeAttributes(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 20) break;
    if (!key || key.length > 80 || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const lower = key.toLowerCase();
    if (lower === "value" || /^on[a-z]/u.test(lower)) continue;
    if (typeof val !== "string") continue;
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactGrabSecrets(val).slice(0, 512);
    count += 1;
  }
  return count > 0 ? out : undefined;
}

function sanitizeComputedStyles(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 24) break;
    if (!key || key.length > 80 || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (typeof val !== "string" || !val.trim()) continue;
    out[key] = val.trim().slice(0, 256);
    count += 1;
  }
  return count > 0 ? out : undefined;
}

function sanitizeRect(raw: unknown): CssRect {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const rec = raw as Record<string, unknown>;
  const num = (value: unknown, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : 0;
  return {
    x: num(rec.x, -50_000, 50_000),
    y: num(rec.y, -50_000, 50_000),
    width: num(rec.width, 0, 50_000),
    height: num(rec.height, 0, 50_000),
  };
}

function sanitizeSensitiveRects(raw: unknown): CssRect[] {
  if (!Array.isArray(raw)) return [];
  const rects: CssRect[] = [];
  for (const entry of raw.slice(0, 128)) {
    const rect = sanitizeRect(entry);
    if (rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  return rects;
}

function semanticDomLabel(tagName: string, attributes?: Record<string, string>): string {
  const id = attributes?.id?.trim();
  if (id && id.length <= 40 && !/^\d+$/u.test(id)) {
    return `${tagName}#${id}`.slice(0, 120);
  }
  const cls = attributes?.class?.trim();
  if (cls) {
    const tokens = cls
      .split(/\s+/u)
      .filter((t) => t.length > 0 && t.length <= 40 && !/^(css|sc|emotion)-[a-z0-9]{5,}$/iu.test(t))
      .slice(0, 2);
    if (tokens.length > 0) {
      return `${tagName}.${tokens.join(".")}`.slice(0, 120);
    }
  }
  return tagName.slice(0, 64);
}

/**
 * Validates, redacts, and locally symbolicates an untrusted guest grab payload into
 * a schema-verified `GrabbedElementContextV1`.
 */
export async function sanitizeRawGrabPayload(
  raw: unknown,
  options: SanitizeGrabOptions,
): Promise<SanitizedGrabResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid browser grab payload.");
  }
  const rec = raw as Record<string, unknown>;
  const resolver = options.sourceMapResolver ?? defaultGrabSourceMapResolver;
  const pageUrl = stripUrlCredentials(options.pageUrl);
  // The resolver binds source-map reads to this authoritative page origin.
  const sourceAuthority = { pageUrl: options.pageUrl };
  const sourceHintsTrusted =
    options.grabPageUrl === undefined || sameGrabSourceAuthority(options.grabPageUrl, options.pageUrl);

  const rawTag = typeof rec.tagName === "string" ? rec.tagName.trim().toLowerCase() : "div";
  const tagName = TAG_NAME_PATTERN.test(rawTag) ? rawTag : "div";
  const framework: GrabbedElementFramework =
    typeof rec.framework === "string" && FRAMEWORK_SET.has(rec.framework)
      ? (rec.framework as GrabbedElementFramework)
      : "dom";

  const rawStack = Array.isArray(rec.componentStack)
    ? (rec.componentStack.slice(0, 12) as RawGrabComponentFrame[])
    : [];

  const resolvedFrames: GrabbedElementComponentFrame[] = [];
  await Promise.all(
    rawStack.map(async (frame, index) => {
      if (!frame || typeof frame !== "object") return;
      const name = cleanString((frame as { name?: unknown }).name, 160);
      if (!name) return;
      const env = (frame as { environment?: unknown }).environment;
      const minified = (frame as { minified?: unknown }).minified === true;
      const hint = sourceHintsTrusted ? sanitizeSourceHint((frame as { source?: unknown }).source) : undefined;
      // Symbolicate up to the top 5 component frames to stay fast.
      const source =
        index < 5 && hint
          ? await resolver.resolveSourceHint(hint, options.workspaceRoot, sourceAuthority)
          : undefined;
      const cleanFrame: GrabbedElementComponentFrame = { name };
      if (env === "client" || env === "server") cleanFrame.environment = env;
      if (source) cleanFrame.source = source;
      if (minified) cleanFrame.minified = true;
      resolvedFrames[index] = cleanFrame;
    }),
  );
  const componentStack = resolvedFrames.filter(Boolean);

  const topSourceHint = sourceHintsTrusted ? sanitizeSourceHint(rec.source) : undefined;
  const resolvedTopSource =
    (topSourceHint
      ? await resolver.resolveSourceHint(topSourceHint, options.workspaceRoot, sourceAuthority)
      : undefined) ?? componentStack.find((frame) => !frame.minified && frame.source)?.source;

  const rawComponentName = cleanString(rec.componentName, 160);
  const primaryNonMinified = componentStack.find((frame) => !frame.minified)?.name;
  const componentName = rawComponentName ?? primaryNonMinified;

  const attributes = sanitizeAttributes(rec.attributes);
  const props = sanitizeProps(rec.props, rec.sensitiveTarget === true);
  const label = (componentName ? `<${componentName} />` : semanticDomLabel(tagName, attributes)).slice(0, 160);
  const selector = cleanString(rec.selector, 1024) ?? tagName;
  const htmlSnippet =
    typeof rec.htmlSnippet === "string"
      ? redactGrabSecrets(rec.htmlSnippet).slice(0, 4096)
      : "";
  const boundingBox = sanitizeRect(rec.boundingBox);

  const measuredViewport = browserMeasuredViewport(rec.viewport);
  const rawViewport = rec.viewport && typeof rec.viewport === "object" ? (rec.viewport as Record<string, unknown>) : undefined;
  const rawDpr = rawViewport?.devicePixelRatio;
  const devicePixelRatio =
    typeof rawDpr === "number" && Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : undefined;
  const zoomFactor =
    typeof options.zoomFactor === "number" && Number.isFinite(options.zoomFactor) && options.zoomFactor > 0
      ? options.zoomFactor
      : undefined;

  const id = (options.id ?? randomUUID().replace(/-/gu, "")).slice(0, 64);
  const pageTitle = cleanString(options.pageTitle, 256);

  const candidate: GrabbedElementContextV1 = {
    version: GRABBED_ELEMENT_SCHEMA_VERSION,
    id,
    label,
    framework,
    ...(componentName ? { componentName } : {}),
    ...(componentStack.length > 0 ? { componentStack } : {}),
    ...(resolvedTopSource ? { source: resolvedTopSource } : {}),
    ...(props ? { props } : {}),
    tagName,
    selector,
    ...(cleanString(rec.role, 80) ? { role: cleanString(rec.role, 80) } : {}),
    ...(cleanString(rec.accessibleName, 256) ? { accessibleName: cleanString(rec.accessibleName, 256) } : {}),
    htmlSnippet,
    ...(cleanString(rec.textPreview, 1024) ? { textPreview: cleanString(rec.textPreview, 1024) } : {}),
    ...(attributes ? { attributes } : {}),
    ...(sanitizeComputedStyles(rec.computedStyles)
      ? { computedStyles: sanitizeComputedStyles(rec.computedStyles) }
      : {}),
    boundingBox,
    pageUrl,
    ...(pageTitle ? { pageTitle } : {}),
    ...(measuredViewport
      ? {
          viewport: {
            width: measuredViewport.width,
            height: measuredViewport.height,
            ...(devicePixelRatio ? { devicePixelRatio } : {}),
            ...(zoomFactor ? { zoomFactor } : {}),
          },
        }
      : {}),
    ...(rec.inIframe === true ? { inIframe: true } : {}),
    capturedAt: options.capturedAt ?? Date.now(),
  };

  const validated = parseGrabbedElements([candidate], "append");
  if (!validated || validated.length !== 1) {
    throw new Error("Sanitized browser grab failed schema validation.");
  }

  return {
    element: validated[0]!,
    keepActive: rec.keepActive === true,
    ...(measuredViewport ? { measuredViewport } : {}),
    sensitiveRects: sanitizeSensitiveRects(rec.sensitiveRects),
  };
}
