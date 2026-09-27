// Custom dictation dictionary: user vocabulary and replacement rules applied
// to finished transcripts. Pure and Electron-free so main (global dictation)
// and the renderer (composer microphone) apply identical rules.

export interface DictationDictionaryEntry {
  /** What the recognizer produces, matched as whole words, ignoring case. */
  from: string;
  /** Replacement text. Empty means "write `from` exactly as entered". */
  to: string;
}

export const DICTATION_DICTIONARY_MAX_ENTRIES = 200;
export const DICTATION_DICTIONARY_MAX_TERM_LENGTH = 100;

function cleanTerm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length > DICTATION_DICTIONARY_MAX_TERM_LENGTH) return null;
  return collapsed;
}

function matchKey(term: string): string {
  return term.toLowerCase();
}

/**
 * Validate an untrusted dictionary. Invalid rows are dropped, later duplicates
 * of the same spoken form are ignored, and the list is bounded.
 */
export function parseDictationDictionary(value: unknown): DictationDictionaryEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: DictationDictionaryEntry[] = [];
  for (const raw of value) {
    if (entries.length >= DICTATION_DICTIONARY_MAX_ENTRIES) break;
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const from = cleanTerm(record.from);
    const to = record.to === undefined ? "" : cleanTerm(record.to);
    if (!from || to === null) continue;
    const key = matchKey(from);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ from, to });
  }
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const WORD_CHAR = "[\\p{L}\\p{N}\\p{M}_]";

/**
 * Apply every rule in one left-to-right pass. Longer phrases win over their
 * prefixes, replacements are never re-scanned, and matches must not sit inside
 * a larger word ("aid" never rewrites "aiden").
 */
export function applyDictationDictionary(
  text: string,
  entries: readonly DictationDictionaryEntry[],
): string {
  if (!text || entries.length === 0) return text;
  const replacements = new Map<string, { from: string; to: string }>();
  for (const entry of entries) {
    const key = matchKey(entry.from);
    if (!key || replacements.has(key)) continue;
    replacements.set(key, { from: entry.from, to: entry.to || entry.from });
  }
  if (replacements.size === 0) return text;
  const rules = [...replacements.values()].sort((a, b) => b.from.length - a.from.length);
  // Keep original Unicode spelling in the pattern. Captures identify the rule
  // using the regex engine's case folding instead of a different locale map.
  const alternatives = rules.map(
    ({ from }) => `(${from.split(" ").map(escapeRegExp).join("\\s+")})`,
  );
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})(?:${alternatives.join("|")})(?!${WORD_CHAR})`,
    "giu",
  );
  return text.replace(pattern, (match: string, ...captures: unknown[]) => {
    const index = rules.findIndex((_rule, index) => typeof captures[index] === "string");
    return rules[index]?.to ?? match;
  });
}

export type DictationDictionaryEdit =
  | { ok: true; entries: DictationDictionaryEntry[] }
  | { ok: false; error: string };

/**
 * Add a rule from the Settings editor. Re-adding a spoken form that already
 * exists updates its replacement in place, so the editor needs no edit mode.
 */
export function addDictationDictionaryEntry(
  entries: readonly DictationDictionaryEntry[],
  fromInput: string,
  toInput: string,
): DictationDictionaryEdit {
  const from = cleanTerm(fromInput);
  const to = cleanTerm(toInput);
  if (from === null || to === null) {
    return {
      ok: false,
      error: `Keep each word or phrase under ${DICTATION_DICTIONARY_MAX_TERM_LENGTH} characters.`,
    };
  }
  if (!from) return { ok: false, error: "Enter the word or phrase you want to correct." };
  const key = matchKey(from);
  const existing = entries.findIndex((entry) => matchKey(entry.from) === key);
  if (existing >= 0) {
    const next = [...entries];
    next[existing] = { from, to };
    return { ok: true, entries: next };
  }
  if (entries.length >= DICTATION_DICTIONARY_MAX_ENTRIES) {
    return {
      ok: false,
      error: `The dictionary holds up to ${DICTATION_DICTIONARY_MAX_ENTRIES} entries. Remove one first.`,
    };
  }
  return { ok: true, entries: [...entries, { from, to }] };
}
