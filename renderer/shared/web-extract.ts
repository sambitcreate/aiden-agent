/**
 * Renderer-safe contract for `web_fetch` extract mode: the field result shape
 * scripts receive, and the bounded recap a completed tool step carries to the
 * transcript on desktop and on paired phones.
 *
 * The recap is display-only. It holds the field names, a short display form
 * of each value, and the page line it was read from. It never holds the page
 * itself, a credential, or the request.
 */

export const WEB_FETCH_TOOL_NAME = "web_fetch" as const;
export const WEB_EXTRACT_RECAP_VERSION = 1 as const;
export const WEB_EXTRACT_MAX_FIELDS = 16;
/** Letters, digits and underscores, not starting with a digit: a subset of what Clairic accepts. */
export const WEB_EXTRACT_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
/** A source line is the matched page line, or a window of it, with ellipses. */
export const WEB_EXTRACT_MAX_SOURCE_LINE_CHARS = 200;
/** Display form of one value in the recap; scripts get the whole value. */
export const WEB_EXTRACT_MAX_RECAP_VALUE_CHARS = 200;
export const WEB_EXTRACT_MAX_RECAP_HOST_CHARS = 253;

/** JSON a model may return as a field value. */
export type WebExtractJsonValue =
  | string
  | number
  | boolean
  | null
  | WebExtractJsonValue[]
  | { [key: string]: WebExtractJsonValue };

/**
 * One field's result, as scripts receive it.
 *
 * - `extracted`: typed, confident, and found on the page at `sourceLine`.
 * - `uncertain`: a `guess` only. Low confidence, the wrong type, or not found
 *   on the page (`notFound`). Never treat a guess as read from the page.
 * - `null`: the model found no value on the page.
 */
export type WebExtractFieldResult =
  | {
      readonly status: "extracted";
      readonly value: WebExtractJsonValue;
      readonly confidence: number;
      readonly sourceLine: string;
    }
  | {
      readonly status: "uncertain";
      readonly guess: WebExtractJsonValue;
      readonly confidence?: number;
      readonly sourceLine?: string;
      readonly notFound?: true;
    }
  | { readonly status: "null"; readonly value: null };

export type WebExtractFieldStatus = WebExtractFieldResult["status"];

/** Why extraction failed for a page; the page itself may still have loaded. */
export type WebExtractErrorKind =
  | "setup"
  | "auth"
  | "quota"
  | "timeout"
  | "unavailable"
  | "invalid-response";

const ERROR_KINDS: ReadonlySet<string> = new Set<WebExtractErrorKind>([
  "setup",
  "auth",
  "quota",
  "timeout",
  "unavailable",
  "invalid-response",
]);

export function isWebExtractErrorKind(value: unknown): value is WebExtractErrorKind {
  return typeof value === "string" && ERROR_KINDS.has(value);
}

/** Plain words for each failure, shared by the tool text and the card. */
export const WEB_EXTRACT_ERROR_MESSAGES: Readonly<Record<WebExtractErrorKind, string>> =
  Object.freeze({
    setup: "the extraction model is not set up",
    auth: "the extraction model rejected every saved key",
    quota: "the extraction model is rate-limited or out of quota",
    timeout: "the extraction model did not answer in time",
    unavailable: "the extraction model could not be reached",
    "invalid-response": "the extraction model sent an answer Aiden could not read",
  });

export interface WebExtractRecapFieldV1 {
  readonly name: string;
  readonly status: WebExtractFieldStatus;
  /** Display form of the value (extracted) or the guess (uncertain). */
  readonly value?: string;
  readonly confidence?: number;
  readonly sourceLine?: string;
  /** An uncertain value that was not found anywhere on the page. */
  readonly notFound?: true;
}

export interface WebExtractRecapV1 {
  readonly version: typeof WEB_EXTRACT_RECAP_VERSION;
  /** The page's host, such as `example.com`. */
  readonly host: string;
  /** Only the first part of the page was read. */
  readonly cut: boolean;
  /** Set when extraction failed for this page; `fields` is then empty. */
  readonly error?: WebExtractErrorKind;
  readonly fields: readonly WebExtractRecapFieldV1[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** C0 controls (newline and tab included) and DEL never reach a one-line display. */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function clip(value: string, maximum: number): string {
  const characters = Array.from(value);
  return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join("")}…`;
}

/** The short form of a value a person reads: text as is, anything else as JSON. */
export function displayWebExtractValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "";
    }
  }
  return clip(oneLine(text), WEB_EXTRACT_MAX_RECAP_VALUE_CHARS);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = oneLine(value);
  if (!line || line !== value || Array.from(line).length > maximum) return undefined;
  return line;
}

function confidenceOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

/**
 * Build the transcript recap for one page. Returns undefined when the result
 * would not pass `parseWebExtractRecap`, so a stored timeline never carries a
 * recap that replay would reject.
 */
export function buildWebExtractRecap(input: {
  readonly url: string;
  readonly cut?: boolean;
  readonly error?: WebExtractErrorKind;
  readonly fields?: Readonly<Record<string, WebExtractFieldResult>>;
}): WebExtractRecapV1 | undefined {
  let host: string;
  try {
    host = new URL(input.url).hostname;
  } catch {
    return undefined;
  }
  const fields = Object.entries(input.fields ?? {}).map(
    ([name, result]): WebExtractRecapFieldV1 => {
      if (result.status === "null") return { name, status: "null" };
      const value = displayWebExtractValue(
        result.status === "extracted" ? result.value : result.guess,
      );
      const sourceLine =
        result.sourceLine === undefined
          ? undefined
          : clip(oneLine(result.sourceLine), WEB_EXTRACT_MAX_SOURCE_LINE_CHARS);
      return {
        name,
        status: result.status,
        ...(value ? { value } : {}),
        ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
        ...(sourceLine ? { sourceLine } : {}),
        ...(result.status === "uncertain" && result.notFound ? { notFound: true as const } : {}),
      };
    },
  );
  return parseWebExtractRecap({
    version: WEB_EXTRACT_RECAP_VERSION,
    host,
    cut: input.cut === true,
    ...(input.error ? { error: input.error } : {}),
    fields,
  });
}

/** Validate a stored or received recap before it reaches the transcript. */
export function parseWebExtractRecap(value: unknown): WebExtractRecapV1 | undefined {
  const input = record(value);
  if (!input || input.version !== WEB_EXTRACT_RECAP_VERSION || typeof input.cut !== "boolean") {
    return undefined;
  }
  const host = boundedString(input.host, WEB_EXTRACT_MAX_RECAP_HOST_CHARS);
  if (!host || !Array.isArray(input.fields) || input.fields.length > WEB_EXTRACT_MAX_FIELDS) {
    return undefined;
  }
  if (input.error !== undefined && !isWebExtractErrorKind(input.error)) return undefined;
  // A failed page has no fields; a page that worked has at least one.
  if (input.error === undefined ? input.fields.length === 0 : input.fields.length > 0) {
    return undefined;
  }
  const names = new Set<string>();
  const fields: WebExtractRecapFieldV1[] = [];
  for (const candidate of input.fields) {
    const field = record(candidate);
    if (!field || typeof field.name !== "string") return undefined;
    if (!WEB_EXTRACT_FIELD_NAME_PATTERN.test(field.name) || names.has(field.name)) return undefined;
    names.add(field.name);
    const status = field.status;
    if (status !== "extracted" && status !== "uncertain" && status !== "null") return undefined;
    if (status === "null") {
      if (
        field.value !== undefined ||
        field.confidence !== undefined ||
        field.sourceLine !== undefined ||
        field.notFound !== undefined
      ) {
        return undefined;
      }
      fields.push({ name: field.name, status });
      continue;
    }
    const display =
      field.value === undefined
        ? undefined
        : boundedString(field.value, WEB_EXTRACT_MAX_RECAP_VALUE_CHARS);
    if (field.value !== undefined && display === undefined) return undefined;
    const confidence = confidenceOf(field.confidence);
    if (field.confidence !== undefined && confidence === undefined) return undefined;
    const sourceLine =
      field.sourceLine === undefined
        ? undefined
        : boundedString(field.sourceLine, WEB_EXTRACT_MAX_SOURCE_LINE_CHARS);
    if (field.sourceLine !== undefined && sourceLine === undefined) return undefined;
    if (field.notFound !== undefined && (field.notFound !== true || status !== "uncertain")) {
      return undefined;
    }
    // Extracted means typed, confident and on the page: all three are present.
    if (
      status === "extracted" &&
      (display === undefined || confidence === undefined || sourceLine === undefined)
    ) {
      return undefined;
    }
    fields.push({
      name: field.name,
      status,
      ...(display === undefined ? {} : { value: display }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(sourceLine === undefined ? {} : { sourceLine }),
      ...(field.notFound === true ? { notFound: true as const } : {}),
    });
  }
  return {
    version: WEB_EXTRACT_RECAP_VERSION,
    host,
    cut: input.cut,
    ...(input.error === undefined ? {} : { error: input.error }),
    fields,
  };
}
