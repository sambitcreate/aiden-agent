// Checks a skill before its card is shown (spec §7 L2). Every refusal names
// the problem and what it would cause, so the Bot can fix its proposal.

import { BOT_SKILL_PROPOSAL_LIMITS } from "../../../renderer/shared/bot-skill-proposals.js";
import { scanMemoryText } from "../bot-memory/scan.js";
import { parseSkillMd } from "../skills-discovery.js";

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;

export interface BotSkillDraft { name: string; description: string; instructions: string }

/** YAML-safe one-line scalar. */
function quoted(text: string): string {
  return JSON.stringify(text.replace(/\s+/gu, " ").trim());
}

/** The SKILL.md Aiden writes for a skill. */
export function botSkillFile(draft: BotSkillDraft): string {
  return `---\nname: ${draft.name}\ndescription: ${quoted(draft.description)}\n---\n\n${draft.instructions.trim()}\n`;
}

/** A minimal unified diff: every old line removed, every new line added, unchanged lines kept. */
export function wholeFileDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = ["--- current", "+++ proposed"];
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    if (a[index] === b[index]) lines.push(` ${a[index] ?? ""}`);
    else {
      if (a[index] !== undefined) lines.push(`-${a[index]}`);
      if (b[index] !== undefined) lines.push(`+${b[index]}`);
    }
  }
  return lines.join("\n");
}

export function validateBotSkillProposal(
  input: BotSkillDraft,
  context: {
    /** Names already in use, and where: configured, global or this Bot's folder. */
    existingSources: ReadonlyMap<string, "configured" | "workspace" | "global">;
    /** The Bot's own current file for this name, when it updates one. */
    current?: string;
  },
): { ok: true; file: string; preview: string; update: boolean } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const name = input.name.trim();
  const description = input.description.trim();
  const instructions = input.instructions.trim();
  if (!NAME.test(name)) errors.push(`Name must be lowercase letters, numbers and dashes (got “${name}”).`);
  const source = context.existingSources.get(name);
  if (source && !(source === "workspace" && context.current !== undefined)) {
    errors.push(`A ${source} skill is already named “${name}”, so this one would be hidden.`);
  }
  if (!description) errors.push("The description must say when to use this skill; an unused skill does nothing.");
  else if ([...description].length > BOT_SKILL_PROPOSAL_LIMITS.descriptionChars) {
    errors.push(`The description is at most ${BOT_SKILL_PROPOSAL_LIMITS.descriptionChars} characters.`);
  }
  const bytes = new TextEncoder().encode(instructions).byteLength;
  if (!instructions) errors.push("The instructions are empty, so the skill would never load.");
  else if (bytes > BOT_SKILL_PROPOSAL_LIMITS.instructionsBytes) {
    errors.push(`Instructions are ${Math.ceil(bytes / 1024)} KB; the limit is 16 KB.`);
  }
  for (const text of [description, instructions]) {
    const scan = scanMemoryText(text);
    if (!scan.ok) {
      errors.push(`This text was blocked: ${scan.threat}.`);
      break;
    }
  }
  if (errors.length) return { ok: false, errors };
  const file = botSkillFile({ name, description, instructions });
  const parsed = parseSkillMd(file);
  if (!parsed || parsed.frontmatter.name !== name || (parsed.frontmatter.description ?? "") !== description.replace(/\s+/gu, " ") || parsed.body !== instructions) {
    return { ok: false, errors: ["The skill would not read back as written; remove unusual characters from its name or description."] };
  }
  return { ok: true, file, preview: context.current !== undefined ? wholeFileDiff(context.current, file) : file, update: context.current !== undefined };
}
