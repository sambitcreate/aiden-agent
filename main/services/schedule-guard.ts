const STRICT_THREAT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+(?:\w+\s+)*instructions/iu,
    "instruction override",
  ],
  [/do\s+not\s+tell\s+the\s+user/iu, "hidden action"],
  [/system\s+prompt\s+override/iu, "system prompt override"],
  [/disregard\s+(?:your|all|any)\s+(?:instructions|rules|guidelines)/iu, "instruction override"],
  [/\bcat\s+[^\n]*(?:\.env|credentials|\.netrc|\.pgpass)\b/iu, "secret access"],
  [/\bauthorized_keys\b/iu, "SSH key modification"],
  [/\/etc\/sudoers|\bvisudo\b/iu, "privilege escalation"],
  [/\brm\s+-rf\s+\/(?:\s|$)/iu, "destructive root command"],
];

const EXFILTRATION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:curl|wget)\s+[^\n]*https?:\/\/[^\s"']*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\w*\}?/iu,
    "secret exfiltration",
  ],
  [
    /\bcurl\s+[^\n]*(?:--data(?:-raw|-binary|-urlencode)?|-d|--form|-F)\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\w*\}?/iu,
    "secret exfiltration",
  ],
  [
    /\bwget\s+[^\n]*--post-(?:data|file)=[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\w*\}?/iu,
    "secret exfiltration",
  ],
];

const INVISIBLE_UNICODE_POINTS = new Set([
  0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xfeff, 0xffa0,
]);
const ZWJ = "\u200d";
const VARIATION_SELECTOR = "\ufe0f";

function isEmojiCodePoint(value: string | undefined): boolean {
  if (value === undefined) return false;
  const codePoint = value.codePointAt(0) as number;
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1ffff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2300 && codePoint <= 0x23ff) ||
    (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) ||
    codePoint === 0x20e3
  );
}

function previousCodePoint(text: string, index: number): string | undefined {
  const prefix = text.slice(0, index).replace(new RegExp(`${VARIATION_SELECTOR}+$`, "u"), "");
  const codePoints = [...prefix];
  return codePoints[codePoints.length - 1];
}

function nextCodePoint(text: string, index: number): string | undefined {
  return [...text.slice(index + ZWJ.length).replace(new RegExp(`^${VARIATION_SELECTOR}+`, "u"), "")][0];
}

function hasSuspiciousInvisibleUnicode(prompt: string): boolean {
  for (let index = 0; index < prompt.length; index += 1) {
    const character = prompt[index];
    const codePoint = character.codePointAt(0) as number;
    const invisible =
      INVISIBLE_UNICODE_POINTS.has(codePoint) ||
      (codePoint >= 0x180b && codePoint <= 0x180f) ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x206f);
    if (!invisible) continue;
    if (
      character === ZWJ &&
      isEmojiCodePoint(previousCodePoint(prompt, index)) &&
      isEmojiCodePoint(nextCodePoint(prompt, index))
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function assertSafeScheduledPrompt(prompt: string): void {
  if (hasSuspiciousInvisibleUnicode(prompt)) {
    throw new Error("Scheduled task prompt contains hidden Unicode characters.");
  }
  for (const [pattern, label] of [...STRICT_THREAT_PATTERNS, ...EXFILTRATION_PATTERNS]) {
    if (pattern.test(prompt)) {
      throw new Error(`Scheduled task prompt was blocked for possible ${label}.`);
    }
  }
}

export function recommendedScheduledPermission(prompt: string): "read-only" | "full" {
  return /\b(?:edit|modify|rename|move|delete|remove|commit|push|install|deploy|publish)\b|\b(?:write|create)\s+(?:a\s+|the\s+)?(?:file|folder|directory|code|script|commit|branch)\b|\b(?:run|execute)\s+(?:a\s+|the\s+)?(?:command|script|test|build|program)\b/iu.test(prompt)
    ? "full"
    : "read-only";
}
