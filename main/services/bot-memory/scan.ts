// Threat and secret scan for Bot memory (spec 2026-10-09 §6.4).
//
// Original Aiden code. The categories follow the strict scope of Hermes
// Agent's threat patterns (MIT): memory is replayed into every future
// prompt, so text that reads like an instruction to the model, a way to send
// data out, a foothold on the Mac or a stored secret is refused on write and
// dropped on read. Only behaviour is adapted; the patterns are Aiden's own.
//
// Invisible and bidirectional characters are checked on the raw text (NFKC
// would hide some of them); everything else runs on the NFKC-normalized,
// lower-cased text so full-width or styled look-alikes cannot slip through.

export type MemoryThreat =
  | "invisible_unicode"
  | "instruction_override"
  | "role_hijack"
  | "exfiltration"
  | "persistence"
  | "secret"
  | "card_number";

export type MemoryScanResult = { ok: true } | { ok: false; threat: MemoryThreat };

/** What the person sees when an entry is refused. */
export const BOT_MEMORY_BLOCKED_MESSAGE =
  "This can't be saved because it looks like a password or an instruction to the Bot.";

/** Scanning is bounded; entries are far shorter than this. */
export const MEMORY_SCAN_MAX_CHARS = 64 * 1024;

/**
 * Invisible formatting and bidirectional controls, as inclusive code point
 * ranges. Emoji joiners (U+200D) and variation selectors stay allowed so
 * "❤️" or a family emoji can still be saved.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200c], // zero-width space, non-joiner
  [0x200e, 0x200f], // left-to-right and right-to-left marks
  [0x202a, 0x202e], // bidirectional embeddings and overrides
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x206f], // bidirectional isolates, deprecated format characters
  [0x3164, 0x3164], // Hangul filler
  [0xfeff, 0xfeff], // byte order mark
  [0xffa0, 0xffa0], // half-width Hangul filler
  [0xe0000, 0xe007f], // tag characters
];

function hasInvisible(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (INVISIBLE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)) return true;
  }
  return false;
}

const PATTERNS: ReadonlyArray<readonly [MemoryThreat, RegExp]> = [
  // Instruction override.
  ["instruction_override", /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|your|the)\b[^.\n]{0,24}\b(?:instructions?|rules|directions|prompts?|guidelines|guardrails|polic(?:y|ies))\b/u],
  ["instruction_override", /\bsystem[ _-]?prompt\b[^.\n]{0,24}\b(?:override|overridden|replace[ds]?|ignore[ds]?|reveal|leak|disregard)/u],
  ["instruction_override", /\b(?:new|updated|real|override|hidden)\s+system\s+(?:prompt|instructions?|message)\b/u],
  ["instruction_override", /\b(?:do\s+not|don't|dont|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to|let|alert|warn)\s+(?:the\s+)?(?:user|person|human|owner)\b/u],
  // Role hijack.
  ["role_hijack", /\byou\s+are\s+(?:now|no\s+longer)\s+(?:a|an|the|my|in|acting|unrestricted|unfiltered|jailbroken|free|dan)\b/u],
  ["role_hijack", /\b(?:act|behave|respond|roleplay)\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|dan)\b/u],
  ["role_hijack", /\bpretend\s+(?:to\s+be|you\s+are)\s+(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken|different\s+(?:ai|assistant|model|bot)|the\s+(?:system|developer|admin))\b/u],
  ["role_hijack", /\b(?:developer|god|admin|jailbreak|dan|sudo)\s+mode\b/u],
  ["role_hijack", /(?:^|\n)\s*(?:system|assistant|developer)\s*:/u],
  ["role_hijack", /<\s*\/?\s*(?:system|assistant|developer|instructions?|bot_memory_snapshot|about_person|notes)\b[^>]*>/u],
  // Exfiltration.
  ["exfiltration", /\b(?:curl|wget|invoke-webrequest|iwr|nc|netcat)\b[^\n]{0,120}(?:\$\{?[a-z_]*(?:key|token|secret|pass(?:word|wd)?|credential|auth)[a-z_]*|\bprintenv\b|\benv\b|\/etc\/passwd|\.ssh)/u],
  ["exfiltration", /\b(?:send|post|upload|forward|exfiltrate|transmit|leak|email)\b[^\n]{0,60}\bto\s+(?:https?|ftp):\/\//u],
  ["exfiltration", /\b(?:output|print|reveal|dump|leak|disclose)\b[^.\n]{0,20}\b(?:the\s+|this\s+|your\s+)?(?:entire\s+|whole\s+|full\s+)?(?:conversation|chat\s+history|system\s+prompt|transcript|memory\s+files?)\b/u],
  // Persistence.
  ["persistence", /authorized_keys/u],
  ["persistence", /(?:>>?|\btee\b|\becho\b|\bwrite\b|\bappend\b|\bcp\b|\bmv\b|\bcat\b)[^\n]{0,60}(?:~|\$home|\/users\/[^/\s]+)\/\.ssh\b/u],
  ["persistence", /\b(?:edit|modify|change|overwrite|rewrite|write\s+to|append\s+to|update)\b[^\n]{0,40}(?:\bagents\.md\b|\bclaude\.md\b|\bsoul\.md\b|\bmemory\.md\b|\buser\.md\b|\.bashrc\b|\.zshrc\b|\.zprofile\b|\.bash_profile\b|\bcrontab\b|\blaunchagents?\b|\blaunchdaemons?\b)/u],
  // Hardcoded secrets.
  ["secret", /\b(?:api[\s_-]?key|access[\s_-]?key|secret[\s_-]?key|access[\s_-]?token|auth[\s_-]?token|bearer|token|secret|password|passwd|passcode|pwd)\b["'`]?\s*(?:is|was|=|:|->|=>)?\s*["'`]?[a-z0-9_\-+/=.~]{20,}/u],
  ["secret", /\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{20,}|xox[abprs]-[a-z0-9-]{10,}|akia[0-9a-z]{16}|aiza[0-9a-z_-]{35}|glpat-[a-z0-9_-]{20})\b/u],
  ["secret", /-----begin [a-z ]*private key-----/u],
];

const CARD_CANDIDATE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/gu;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/[ -]/gu, "");
    if (digits.length < 13 || digits.length > 19) continue;
    // A run of one repeated digit (0000 0000 …) is a placeholder, not a card.
    if (/^(\d)\1+$/u.test(digits)) continue;
    if (luhnValid(digits)) return true;
  }
  return false;
}

/** Scan one entry. The result names the first threat found. */
export function scanMemoryText(input: string): MemoryScanResult {
  const raw = input.length > MEMORY_SCAN_MAX_CHARS ? input.slice(0, MEMORY_SCAN_MAX_CHARS) : input;
  if (hasInvisible(raw)) return { ok: false, threat: "invisible_unicode" };
  const text = raw.normalize("NFKC").toLowerCase();
  for (const [threat, pattern] of PATTERNS) {
    if (pattern.test(text)) return { ok: false, threat };
  }
  if (hasCardNumber(text)) return { ok: false, threat: "card_number" };
  return { ok: true };
}
