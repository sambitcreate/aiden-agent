/**
 * `web_fetch` extract mode: typed values read off a fetched page.
 *
 * A small extraction model (pluggable; Cloudflare's Clairic first) proposes
 * a value and a confidence for each named field. Aiden then checks every
 * value against the page itself, so a value the model did not read from the
 * page can never come back as `extracted`, and every extracted value carries
 * the page line it came from.
 *
 * Field types, the 0.80 threshold and the text matching rules follow
 * pi-web-access v0.45.0 (MIT, `field-extract.ts`); the per-type page checks
 * for numbers, dates, times and lists are Aiden's own.
 */

import {
  WEB_EXTRACT_ERROR_MESSAGES,
  WEB_EXTRACT_FIELD_NAME_PATTERN,
  WEB_EXTRACT_MAX_FIELDS,
  WEB_EXTRACT_MAX_SOURCE_LINE_CHARS,
  type WebExtractErrorKind,
  type WebExtractFieldResult,
  type WebExtractJsonValue,
} from "../../renderer/shared/web-extract.js";

/** pi-web-access measured no wrong value at or above 0.80 on its fixtures. */
export const WEB_EXTRACT_CONFIDENCE_THRESHOLD = 0.8;
export const WEB_EXTRACT_TIMEOUT_MS = 30_000;
export const WEB_EXTRACT_MAX_INSTRUCTION_CHARS = 500;
export const WEB_EXTRACT_DURATION_UNITS = [
  "seconds",
  "minutes",
  "hours",
  "days",
  "weeks",
  "months",
  "years",
] as const;

export type WebExtractItemType = "text" | "number" | "date";

/** One field as the extraction model receives it. */
export interface WebExtractFieldSpec {
  readonly type: "text" | "number" | "date" | "time" | "datetime" | "duration" | "list";
  readonly integer?: true;
  readonly unit?: (typeof WEB_EXTRACT_DURATION_UNITS)[number];
  readonly items?: WebExtractItemType;
  readonly instructions?: string;
}

export type WebExtractFieldSpecs = Readonly<Record<string, WebExtractFieldSpec>>;

export const WEB_EXTRACT_FIELD_TYPE_HINT =
  "text, number, integer, date, time, datetime, duration[.unit], list[.number|.date]";

/**
 * Parse the model-supplied `fields` map. Every field is `"type"` or
 * `"type: what to find"`. An invalid map fails the call before anything is
 * fetched.
 */
export function parseWebExtractFields(fields: unknown): WebExtractFieldSpecs {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("fields must map each name to a type, such as \"number: Pro plan monthly price\".");
  }
  const entries = Object.entries(fields);
  if (entries.length === 0 || entries.length > WEB_EXTRACT_MAX_FIELDS) {
    throw new Error(`fields must list 1 to ${WEB_EXTRACT_MAX_FIELDS} fields.`);
  }
  // No prototype, so a field named "__proto__" or "constructor" is an ordinary key.
  const specs: Record<string, WebExtractFieldSpec> = Object.create(null);
  for (const [name, raw] of entries) {
    if (!WEB_EXTRACT_FIELD_NAME_PATTERN.test(name)) {
      throw new Error(
        `Field name "${name.slice(0, 64)}" must start with a letter or underscore and use at most 64 letters, digits or underscores.`,
      );
    }
    if (typeof raw !== "string") {
      throw new Error(`Field ${name} must be a string such as "number" or "date: when it ships".`);
    }
    const colon = raw.indexOf(":");
    const type = (colon === -1 ? raw : raw.slice(0, colon)).trim();
    const instructions = colon === -1 ? "" : raw.slice(colon + 1).trim();
    if (instructions.length > WEB_EXTRACT_MAX_INSTRUCTION_CHARS) {
      throw new Error(`Field ${name} describes what to find in more than ${WEB_EXTRACT_MAX_INSTRUCTION_CHARS} characters.`);
    }
    const [base, sub, extra] = type.split(".");
    let spec: WebExtractFieldSpec | undefined;
    if (sub === undefined && (base === "text" || base === "number" || base === "date" || base === "time" || base === "datetime" || base === "duration")) {
      spec = { type: base };
    } else if (sub === undefined && base === "integer") spec = { type: "number", integer: true };
    else if (sub === undefined && base === "list") spec = { type: "list", items: "text" };
    else if (base === "duration" && (WEB_EXTRACT_DURATION_UNITS as readonly string[]).includes(sub ?? "")) {
      spec = { type: "duration", unit: sub as WebExtractFieldSpec["unit"] };
    } else if (base === "list" && (sub === "number" || sub === "date")) spec = { type: "list", items: sub };
    if (!spec || extra !== undefined) {
      throw new Error(`Field ${name} has unknown type "${type.slice(0, 40)}"; use ${WEB_EXTRACT_FIELD_TYPE_HINT}.`);
    }
    specs[name] = instructions ? { ...spec, instructions } : spec;
  }
  return specs;
}

// ── Extraction model seam ────────────────────────────────────────────────

export interface WebExtractModelRequest {
  readonly page: string;
  readonly fields: WebExtractFieldSpecs;
  /** ISO date that anchors relative dates and dates without a year. */
  readonly referenceDate: string;
  readonly signal: AbortSignal;
}

export interface WebExtractModelResponse {
  /** One answer per field name: `{ value, confidence }`, value `null` when absent. */
  readonly answers: Readonly<Record<string, unknown>>;
  /** The model read only part of the page. */
  readonly truncated: boolean;
}

/** A pluggable extraction model. Adapters live in `web-extract-models.ts`. */
export interface WebExtractModel {
  readonly id: string;
  /** Longest page text the model accepts; longer pages are cut and say so. */
  readonly maxPageChars: number;
  run(request: WebExtractModelRequest): Promise<WebExtractModelResponse>;
}

export class WebExtractError extends Error {
  constructor(readonly kind: WebExtractErrorKind) {
    super(WEB_EXTRACT_ERROR_MESSAGES[kind]);
    this.name = "WebExtractError";
  }
}

export type WebPageExtraction =
  | { readonly fields: Readonly<Record<string, WebExtractFieldResult>>; readonly cut: boolean }
  | { readonly error: WebExtractErrorKind };

// ── Status from the model's answer ───────────────────────────────────────

function realDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function realTime(text: string): boolean {
  const [hours = 99, minutes = 99, seconds = 0] = text.split(":").map(Number);
  return hours <= 23 && minutes <= 59 && seconds <= 59;
}

function isoDate(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return realDate(year, month, day) ? { year, month, day } : undefined;
}

/** Whether the value has the field's type; dates and times must also exist. */
function matchesType(spec: Pick<WebExtractFieldSpec, "type" | "integer" | "items">, value: unknown): boolean {
  switch (spec.type) {
    case "text":
      return typeof value === "string" && value.trim() !== "";
    case "number":
      return typeof value === "number" && Number.isFinite(value) && (!spec.integer || Number.isInteger(value));
    case "duration":
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    case "date":
      return typeof value === "string" && isoDate(value) !== undefined;
    case "time":
      return typeof value === "string" && /^\d{2}:\d{2}(:\d{2})?$/u.test(value) && realTime(value);
    case "datetime": {
      const match =
        typeof value === "string"
          ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-](\d{2}:\d{2}))?$/u.exec(value)
          : null;
      return (
        match !== null &&
        isoDate(match[1]!) !== undefined &&
        realTime(match[2]!) &&
        (match[3] === undefined || realTime(match[3]))
      );
    }
    case "list":
      return Array.isArray(value) && value.every((item) => matchesType({ type: spec.items ?? "text" }, item));
  }
}

type Verdict =
  | { readonly status: "extracted"; readonly value: WebExtractJsonValue; readonly confidence: number }
  | { readonly status: "uncertain"; readonly guess: WebExtractJsonValue; readonly confidence?: number }
  | { readonly status: "null" };

function verdictFor(spec: WebExtractFieldSpec, answer: unknown): Verdict {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    throw new WebExtractError("invalid-response");
  }
  // A missing value (only `p_null` sent) and an explicit null both mean "not on
  // the page". The fallback guess a model may still send then is not evidence.
  const { value = null, confidence: rawConfidence } = answer as { value?: WebExtractJsonValue; confidence?: unknown };
  if (value === null) return { status: "null" };
  const confidence =
    typeof rawConfidence === "number" && Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
      ? rawConfidence
      : undefined;
  if (confidence !== undefined && confidence >= WEB_EXTRACT_CONFIDENCE_THRESHOLD && matchesType(spec, value)) {
    return { status: "extracted", value, confidence };
  }
  return { status: "uncertain", guess: value, ...(confidence === undefined ? {} : { confidence }) };
}

// ── Finding a value on the page ──────────────────────────────────────────

/** The page split into lines, with a lazily folded copy for text matching. */
export class WebExtractPage {
  readonly lines: readonly string[];
  private readonly starts: number[] = [];
  private foldedText: Folded | undefined;

  constructor(readonly text: string) {
    this.lines = text.split("\n");
    let offset = 0;
    for (const line of this.lines) {
      this.starts.push(offset);
      offset += line.length + 1;
    }
  }

  get folded(): Folded {
    return (this.foldedText ??= fold(this.text));
  }

  /** The line holding raw offset `at`, and that line's start offset. */
  lineAt(at: number): { line: string; start: number } {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.starts[middle]! <= at) low = middle;
      else high = middle - 1;
    }
    return { line: this.lines[low] ?? "", start: this.starts[low] ?? 0 };
  }
}

/** The line, or a window of it around raw [start, end), at most 200 characters with ellipses. */
export function citeLine(line: string, start: number, end: number): string {
  const flat = (text: string) => text.replace(/\s+/gu, " ").trim();
  if (line.length <= WEB_EXTRACT_MAX_SOURCE_LINE_CHARS) return flat(line);
  const size = WEB_EXTRACT_MAX_SOURCE_LINE_CHARS - 2;
  const span = Math.max(0, end - start);
  let from = span >= size ? start : start - Math.floor((size - span) / 2);
  from = Math.max(0, Math.min(line.length - size, from));
  // Never start or end inside a surrogate pair.
  if (from > 0 && /[\udc00-\udfff]/u.test(line[from] ?? "")) from -= 1;
  let to = from + size;
  if (to < line.length && /[\udc00-\udfff]/u.test(line[to] ?? "")) to -= 1;
  return `${from > 0 ? "…" : ""}${flat(line.slice(from, to))}${to < line.length ? "…" : ""}`;
}

interface Folded {
  readonly text: string;
  /** Raw UTF-16 offset each folded unit came from. */
  readonly map: readonly number[];
}

/**
 * Text reduced for comparison: NFKC, lowercase, curly quotes and dashes made
 * plain, emphasis and bracket marks dropped, whitespace collapsed. The same
 * steps run on the value, so matching only ever gets looser on the page side.
 */
function fold(raw: string): Folded {
  let text = "";
  const map: number[] = [];
  let space = false;
  for (let index = 0; index < raw.length; ) {
    // A character with its combining marks normalizes as one unit.
    let next = index + String.fromCodePoint(raw.codePointAt(index)!).length;
    while (next < raw.length) {
      const mark = String.fromCodePoint(raw.codePointAt(next)!);
      if (!/\p{M}/u.test(mark)) break;
      next += mark.length;
    }
    const unit = raw.slice(index, next);
    const normalized = unit.normalize("NFKC");
    // A character whose NFKC form is much longer (U+FDFA) stays as it is, on both sides.
    for (const character of normalized.length > 4 * unit.length ? unit : normalized) {
      const plain = /[‘’‚‛′]/u.test(character)
        ? "'"
        : /[“”„‟″]/u.test(character)
          ? '"'
          : /[‐-―−]/u.test(character)
            ? "-"
            : character;
      if (/[*_`[\]]/u.test(plain)) continue;
      if (/\s/u.test(plain)) {
        if (text) space = true;
        continue;
      }
      if (space) {
        text += " ";
        map.push(index);
        space = false;
      }
      const lower = plain.toLowerCase();
      text += lower;
      for (let unitIndex = 0; unitIndex < lower.length; unitIndex++) map.push(index);
    }
    index = next;
  }
  return { text, map };
}

const WORD = /[\p{L}\p{N}]/u;

interface Located {
  readonly line: string;
  readonly start: number;
  readonly end: number;
}

function cited(located: Located | undefined): string | undefined {
  return located ? citeLine(located.line, located.start, located.end) : undefined;
}

/** Text anywhere on the page, as whole words where the value starts or ends with one. */
function locateText(value: string, page: WebExtractPage): Located | undefined {
  const wanted = fold(value).text;
  if (!wanted) return undefined;
  const { text, map } = page.folded;
  const wordStart = WORD.test(wanted[0]!);
  const wordEnd = WORD.test(wanted[wanted.length - 1]!);
  for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
    if (wordStart && WORD.test(text[at - 1] ?? "")) continue;
    if (wordEnd && WORD.test(text[at + wanted.length] ?? "")) continue;
    const rawStart = map[at]!;
    const rawEnd = map[at + wanted.length - 1]! + 1;
    const { line, start } = page.lineAt(rawStart);
    return { line, start: rawStart - start, end: Math.min(rawEnd - start, line.length) };
  }
  return undefined;
}

// Thousands separators seen on pages: comma, period, space, no-break and narrow no-break space, apostrophe.
const NUMBER_SEPARATORS = new Set([",", ".", " ", " ", " ", "'"]);
const isDigit = (character: string | undefined) => character !== undefined && character >= "0" && character <= "9";

/** The values one run of digit groups can mean: "1.299" is 1.299 or 1299, "1.299,00" is 1299. */
function groupReadings(groups: readonly string[], separators: readonly string[]): number[] {
  if (groups.length === 1) return [Number(groups[0])];
  const thousands = (parts: readonly string[]) => parts.slice(1).every((part) => part.length === 3);
  const readings: number[] = [];
  if (thousands(groups)) readings.push(Number(groups.join("")));
  const decimal = separators[separators.length - 1];
  if (
    (decimal === "." || decimal === ",") &&
    separators.slice(0, -1).every((separator) => separator !== decimal) &&
    thousands(groups.slice(0, -1))
  ) {
    readings.push(Number(`${groups.slice(0, -1).join("")}.${groups[groups.length - 1]}`));
  }
  return readings;
}

const MULTIPLIERS: Readonly<Record<string, number>> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(right));
}

/**
 * The first line holding the number, sign included: 299 is not in "1 299",
 * -42 is not "42", and "1.2k" is 1200. A run of digits with no sensible
 * reading ("5.3.1") is read group by group.
 */
function locateNumber(value: number, page: WebExtractPage): Located | undefined {
  for (const line of page.lines) {
    for (let index = 0; index < line.length; ) {
      if (!isDigit(line[index]) || isDigit(line[index - 1])) {
        index++;
        continue;
      }
      const groups: string[] = [];
      const separators: string[] = [];
      const starts: number[] = [];
      let end = index;
      for (;;) {
        starts.push(end);
        const from = end;
        while (isDigit(line[end])) end++;
        groups.push(line.slice(from, end));
        if (!NUMBER_SEPARATORS.has(line[end] ?? "") || !isDigit(line[end + 1])) break;
        separators.push(line[end]!);
        end++;
      }
      const suffix = /^(?:([kKmMbB]|bn)(?![\p{L}])|\s(thousand|million|billion)\b)/u.exec(line.slice(end));
      const multiplier = suffix ? MULTIPLIERS[(suffix[1] ?? suffix[2] ?? "").toLowerCase()] : undefined;
      // A minus, optionally before a currency sign, that does not join two words or numbers ("2026-11").
      let sign = index - 1;
      if (/[$€£¥]/u.test(line[sign] ?? "")) sign--;
      const negative = (line[sign] === "-" || line[sign] === "−") && !/[\p{L}\p{N}]/u.test(line[sign - 1] ?? "");
      const signed = (reading: number) => (negative ? -reading : reading);
      const matches = (reading: number) =>
        sameNumber(signed(reading), value) || (multiplier !== undefined && sameNumber(signed(reading * multiplier), value));
      const readings = groupReadings(groups, separators);
      if (readings.some(matches)) return { line, start: negative ? sign : index, end };
      if (readings.length === 0) {
        for (const [groupIndex, group] of groups.entries()) {
          if (sameNumber(groupIndex === 0 ? signed(Number(group)) : Number(group), value)) {
            const from = starts[groupIndex]!;
            return { line, start: from, end: from + group.length };
          }
        }
      }
      index = end;
    }
  }
  return undefined;
}

const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** Each pattern reads a match as [month, day, year]; a year-less form has no year. */
const DATE_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly read: (match: RegExpExecArray) => readonly (readonly [number, number, number | undefined])[];
}[] = [
  // 2026-11-03, 2026/11/03
  {
    pattern: /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/gu,
    read: (match) => [[Number(match[2]), Number(match[3]), Number(match[1])]],
  },
  // Nov 3, 2026 · November 3rd 2026 · Nov. 3
  {
    pattern: new RegExp(`(?<!\\p{L})${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4})(?!\\d))?`, "giu"),
    read: (match) => [[MONTH_NUMBERS[match[1]!.toLowerCase()]!, Number(match[2]), match[3] === undefined ? undefined : Number(match[3])]],
  },
  // 3 November 2026 · 3rd of Nov
  {
    pattern: new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?!\\p{L})\\.?(?:,?\\s+(\\d{4})(?!\\d))?`, "giu"),
    read: (match) => [[MONTH_NUMBERS[match[2]!.toLowerCase()]!, Number(match[1]), match[3] === undefined ? undefined : Number(match[3])]],
  },
  // 11/03/2026 or 03/11/2026, 03.11.26
  {
    pattern: /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/.-])/gu,
    read: (match) => {
      const year = match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
      return [[Number(match[1]), Number(match[2]), year], [Number(match[2]), Number(match[1]), year]];
    },
  },
];

type IsoDate = NonNullable<ReturnType<typeof isoDate>>;

/** The wanted day on one line, in ISO, English month-name or numeric form; a year-less form matches month and day. */
function dateInLine(wanted: IsoDate, line: string): Located | undefined {
  if (!/\d/u.test(line)) return undefined;
  for (const { pattern, read } of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      if (read(match).some(([month, day, year]) => month === wanted.month && day === wanted.day && (year === undefined || year === wanted.year))) {
        return { line, start: match.index, end: match.index + match[0].length };
      }
    }
  }
  return undefined;
}

function locateDate(value: string, page: WebExtractPage): Located | undefined {
  const wanted = isoDate(value);
  if (!wanted) return undefined;
  for (const line of page.lines) {
    const found = dateInLine(wanted, line);
    if (found) return found;
  }
  return undefined;
}

function locateTime(value: string, page: WebExtractPage): Located | undefined {
  const [hours, minutes, seconds = 0] = value.split(":").map(Number) as [number, number, number?];
  for (const line of page.lines) {
    const found = timeInLine(hours, minutes, seconds, line);
    if (found) return found;
  }
  return undefined;
}

/** A time on one line in 24-hour form, 12-hour form with am/pm, or "noon"/"midnight". */
function timeInLine(hours: number, minutes: number, seconds: number, line: string): Located | undefined {
  const pattern = /(?<![\d:])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:\s*([ap])\.?\s?m\b\.?)?(?![\d:])|\b(noon|midnight)\b/giu;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    let hour: number;
    let minute = 0;
    let second: number | undefined;
    if (match[5]) {
      hour = match[5].toLowerCase() === "noon" ? 12 : 0;
    } else {
      // A bare number is only a time with minutes or am/pm.
      if (match[2] === undefined && match[4] === undefined) continue;
      hour = Number(match[1]);
      minute = match[2] === undefined ? 0 : Number(match[2]);
      second = match[3] === undefined ? undefined : Number(match[3]);
      const meridiem = match[4]?.toLowerCase();
      if (meridiem) {
        if (hour < 1 || hour > 12) continue;
        hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
      }
    }
    if (hour === hours && minute === minutes && (second ?? 0) === seconds) {
      return { line, start: match.index, end: match.index + match[0].length };
    }
  }
  return undefined;
}

/**
 * A UTC offset as pages write it. UTC reads as "Z" after a time, "UTC",
 * "GMT" or "+00:00"; "+09:00" also reads as "UTC+9" or "GMT+09:00".
 */
function zonePattern(zone: string): RegExp {
  const offset = zone === "Z" ? "+00:00" : zone;
  const sign = offset.startsWith("+") ? "\\+" : "[-−]";
  const hours = offset.slice(1, 3);
  const minutes = offset.slice(4, 6);
  // "+09:00", "+0900"
  const numeric = `(?<![\\d:])${sign}${hours}:?${minutes}(?!\\d)`;
  if (hours === "00" && minutes === "00") {
    // UTC itself ("09:00Z", "UTC", "GMT"), but not "UTC+9".
    return new RegExp(`(?:(?<=\\d)Z|(?<!\\p{L})(?:UTC|GMT))(?!\\p{L})(?!\\s?[-+−]\\s?\\d)|${numeric}`, "u");
  }
  // "UTC+9", "GMT+09:00", "UTC+5:30", but "UTC+9" is never the start of "UTC+9:30".
  const minutesPart = minutes === "00" ? "(?::?00)?" : `:?${minutes}`;
  const named = `(?<!\\p{L})(?:UTC|GMT)\\s?${sign}\\s?0?${Number(hours)}${minutesPart}(?![:.]?\\d)`;
  return new RegExp(`${named}|${numeric}`, "iu");
}

const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/u;

/**
 * The date, the time and any UTC offset on one line. A date from one line and
 * a time from another is a different moment, and a claimed offset the line
 * does not state is not on the page.
 */
function locateDateTime(value: string, page: WebExtractPage): Located | undefined {
  const exact = locateText(value, page);
  if (exact) return exact;
  const match = ISO_DATETIME.exec(value);
  const wanted = match ? isoDate(match[1]!) : undefined;
  if (!match || !wanted) return undefined;
  // Pages do not write fractions of a second; only a zero fraction can match.
  if (match[5] !== undefined && /[1-9]/u.test(match[5])) return undefined;
  const [hours, minutes, seconds] = [Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
  const zone = match[6] === undefined ? undefined : zonePattern(match[6]);
  for (const line of page.lines) {
    const date = dateInLine(wanted, line);
    if (date && timeInLine(hours, minutes, seconds, line) && (!zone || zone.test(line))) return date;
  }
  return undefined;
}

type DurationUnit = (typeof WEB_EXTRACT_DURATION_UNITS)[number];

const DURATION_UNIT_ALIASES: Readonly<Record<string, DurationUnit>> = {
  s: "seconds", sec: "seconds", secs: "seconds", second: "seconds", seconds: "seconds",
  min: "minutes", mins: "minutes", minute: "minutes", minutes: "minutes",
  h: "hours", hr: "hours", hrs: "hours", hour: "hours", hours: "hours",
  d: "days", day: "days", days: "days",
  w: "weeks", wk: "weeks", wks: "weeks", week: "weeks", weeks: "weeks",
  mo: "months", mos: "months", month: "months", months: "months",
  y: "years", yr: "years", yrs: "years", year: "years", years: "years",
};
/** Units from smallest to largest; a compound duration writes them largest first. */
const DURATION_UNIT_ORDER: readonly DurationUnit[] = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"];
/** Units with an exact size. Months and years only convert to each other. */
const SECONDS_IN: Partial<Record<DurationUnit, number>> = { seconds: 1, minutes: 60, hours: 3_600, days: 86_400, weeks: 604_800 };
const MONTHS_IN: Partial<Record<DurationUnit, number>> = { months: 1, years: 12 };
const DURATION = /(?<![\d.,])(\d+(?:\.\d+)?)\s?-?\s?(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?|[shdwy])(?![\p{L}\p{N}])/giu;

/** An amount in `unit` expressed in `wanted`, or undefined when the two do not convert exactly. */
function convertDuration(amount: number, unit: DurationUnit, wanted: DurationUnit): number | undefined {
  for (const table of [SECONDS_IN, MONTHS_IN]) {
    const from = table[unit];
    const to = table[wanted];
    if (from !== undefined && to !== undefined) return (amount * from) / to;
  }
  return undefined;
}

/**
 * A duration the page writes with its unit ("2 weeks", "14-day", "1 hour 30
 * minutes") that equals the value in the requested unit. A bare number is
 * never a duration, and days never convert to months.
 *
 * Amounts written together in falling units ("1 hour 30 minutes", "2 days and
 * 4 hours") are one duration, so only their total counts, never one part of
 * it. Amounts in the same or a rising unit ("7 days, 14 days") stand alone.
 */
function locateDuration(value: number, unit: DurationUnit, page: WebExtractPage): Located | undefined {
  for (const line of page.lines) {
    const groups: { start: number; end: number; total: number | undefined; smallest: number }[] = [];
    DURATION.lastIndex = 0;
    for (let match = DURATION.exec(line); match; match = DURATION.exec(line)) {
      const written = DURATION_UNIT_ALIASES[match[2]!.toLowerCase()]!;
      const rank = DURATION_UNIT_ORDER.indexOf(written);
      const amount = convertDuration(Number(match[1]), written, unit);
      const end = match.index + match[0].length;
      const previous = groups[groups.length - 1];
      if (previous && rank < previous.smallest && /^\s*(?:,|and)?\s*$/iu.test(line.slice(previous.end, match.index))) {
        previous.end = end;
        previous.smallest = rank;
        previous.total = previous.total === undefined || amount === undefined ? undefined : previous.total + amount;
      } else {
        groups.push({ start: match.index, end, total: amount, smallest: rank });
      }
    }
    for (const group of groups) {
      if (group.total !== undefined && sameNumber(group.total, value)) return { line, start: group.start, end: group.end };
    }
  }
  return undefined;
}

function locateItem(type: WebExtractItemType, value: unknown, page: WebExtractPage): Located | undefined {
  if (type === "number") return typeof value === "number" ? locateNumber(value, page) : undefined;
  if (type === "date") return typeof value === "string" ? locateDate(value, page) : undefined;
  return typeof value === "string" ? locateText(value, page) : undefined;
}

/** Where on the page a well-typed value is, or undefined when it is not there. */
function locateTyped(spec: WebExtractFieldSpec, value: unknown, page: WebExtractPage): Located | undefined {
  switch (spec.type) {
    case "text":
      return locateItem("text", value, page);
    case "number":
      return locateItem("number", value, page);
    case "duration":
      return typeof value === "number" ? locateDuration(value, spec.unit ?? "seconds", page) : undefined;
    case "date":
      return locateItem("date", value, page);
    case "time":
      return typeof value === "string" ? locateTime(value, page) : undefined;
    case "datetime":
      return typeof value === "string" ? locateDateTime(value, page) : undefined;
    case "list": {
      if (!Array.isArray(value) || value.length === 0) return undefined;
      let first: Located | undefined;
      for (const item of value) {
        const located = locateItem(spec.items ?? "text", item, page);
        if (!located) return undefined;
        first ??= located;
      }
      return first;
    }
  }
}

/**
 * Apply the page check to the model's verdict. An extracted value must be on
 * the page; one that is not becomes an uncertain guess marked `notFound`.
 */
function checkedAgainstPage(spec: WebExtractFieldSpec, verdict: Verdict, page: WebExtractPage): WebExtractFieldResult {
  if (verdict.status === "null") return { status: "null", value: null };
  const value = verdict.status === "extracted" ? verdict.value : verdict.guess;
  const located = matchesType(spec, value)
    ? locateTyped(spec, value, page)
    : // A guess of the wrong type may still be on the page as written ("Oct 27").
      typeof value === "string" || typeof value === "number"
      ? locateText(String(value), page)
      : undefined;
  const sourceLine = cited(located);
  if (verdict.status === "extracted" && sourceLine) {
    return { status: "extracted", value, confidence: verdict.confidence, sourceLine };
  }
  return {
    status: "uncertain",
    guess: value,
    ...(verdict.confidence === undefined ? {} : { confidence: verdict.confidence }),
    ...(sourceLine ? { sourceLine } : { notFound: true as const }),
  };
}

/** The page cut to `max` UTF-16 units without splitting a surrogate pair. */
function cutPage(page: string, max: number): string {
  if (page.length <= max) return page;
  const end = /[\udc00-\udfff]/u.test(page[max] ?? "") ? max - 1 : max;
  return page.slice(0, end);
}

function localIsoDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Read the fields off one page. Model failures become `{ error }` so the
 * caller can still return the page; a caller abort is rethrown.
 */
export async function extractWebPageFields(input: {
  readonly page: string;
  readonly fields: WebExtractFieldSpecs;
  readonly model: WebExtractModel;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}): Promise<WebPageExtraction> {
  const state = cutPage(input.page, input.model.maxPageChars);
  const timeout = AbortSignal.timeout(input.timeoutMs ?? WEB_EXTRACT_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    const response = await input.model.run({
      page: state,
      fields: input.fields,
      referenceDate: localIsoDate((input.now ?? (() => new Date()))()),
      signal,
    });
    input.signal?.throwIfAborted();
    const answers = response.answers;
    if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
      throw new WebExtractError("invalid-response");
    }
    const page = new WebExtractPage(state);
    const fields: Record<string, WebExtractFieldResult> = {};
    for (const [name, spec] of Object.entries(input.fields)) {
      const answer = Object.prototype.hasOwnProperty.call(answers, name) ? answers[name] : undefined;
      fields[name] = checkedAgainstPage(spec, verdictFor(spec, answer), page);
    }
    return { fields, cut: state.length < input.page.length || response.truncated === true };
  } catch (error) {
    input.signal?.throwIfAborted();
    if (timeout.aborted) return { error: "timeout" };
    return { error: error instanceof WebExtractError ? error.kind : "unavailable" };
  }
}

// ── Text the model reads ─────────────────────────────────────────────────

const MAX_SHOWN_VALUE_CHARS = 1_000;

function shown(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_SHOWN_VALUE_CHARS
    ? `${text.slice(0, MAX_SHOWN_VALUE_CHARS)}… [${text.length} characters]`
    : text;
}

/** One line per field, as the model sees it. Scripts get the typed results. */
export function formatWebPageExtraction(extraction: WebPageExtraction): string {
  if ("error" in extraction) return `Extraction failed: ${WEB_EXTRACT_ERROR_MESSAGES[extraction.error]}.`;
  const lines = Object.entries(extraction.fields).map(([name, result]) => {
    if (result.status === "null") return `${name}: not on the page`;
    const from = result.sourceLine ? ` from "${result.sourceLine}"` : "";
    if (result.status === "extracted") {
      return `${name}: ${shown(result.value)} (${result.confidence.toFixed(2)})${from}`;
    }
    const confidence = result.confidence === undefined ? "" : `, ${result.confidence.toFixed(2)}`;
    return `${name}: uncertain (guess ${shown(result.guess)}${confidence}${result.notFound ? "; not found on the page" : ""})${from}`;
  });
  if (extraction.cut) lines.push("(Only the first part of the page was read.)");
  if (Object.values(extraction.fields).some(({ status }) => status === "uncertain")) {
    lines.push("Uncertain values are guesses, not read from the page; check them before relying on them.");
  }
  return lines.join("\n");
}
