/**
 * The DESIGN.md sentence of the design-canvas status note (spec S34, R5) and
 * the draft offer (R6). Pure. The sentence holds only checked, quoted paths,
 * counts and fixed words, never file content, so a turn whose counts haven't
 * changed adds no new note and the prompt cache holds.
 */
import { isSafeWorkspaceRelativePath } from "../canvas-config.js";
import type { DesignMdState } from "./reader.js";

const MAX_NAMED_ROOTS = 3;

const REASONS: Record<Exclude<DesignMdState["status"], "ok" | "missing">, string> = {
  invalid: "outside the workspace or not a safe path",
  "too-large": "too large",
  unreadable: "unreadable",
  "timed-out": "took too long",
  "lint-failed": "the linter failed",
  "linter-unavailable": "the linter isn't available",
  busy: "the linter is busy",
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function part(appRoot: string, state: DesignMdState): string | null {
  if (state.status === "ok") {
    if (!isSafeWorkspaceRelativePath(state.path, { extension: ".md" })) return null;
    const { errors, warnings } = state.summary;
    return `DESIGN.md: ${JSON.stringify(state.path)} (${plural(errors, "error", "errors")}, ${plural(warnings, "warning", "warnings")})`;
  }
  if (state.status === "missing") return `No DESIGN.md for ${JSON.stringify(appRoot)}`;
  return `DESIGN.md for ${JSON.stringify(appRoot)} can't be checked (${REASONS[state.status]})`;
}

/** R5: one sentence for the described roots; at most three are named and the rest counted. */
export function designMdStatusSentence(
  entries: ReadonlyArray<{ appRoot: string; state: DesignMdState }>,
  options: { more: number; offer?: string },
): string {
  const parts: string[] = [];
  let more = options.more;
  for (const entry of entries) {
    const text = isSafeWorkspaceRelativePath(entry.appRoot) && parts.length < MAX_NAMED_ROOTS ? part(entry.appRoot, entry.state) : null;
    if (text) parts.push(text);
    else more++;
  }
  const sentences: string[] = [];
  if (parts.length > 0) sentences.push(`${parts.join("; ")}.`);
  if (more > 0) sentences.push(`…and ${plural(more, "more app", "more apps")}.`);
  if (options.offer) sentences.push(options.offer);
  return sentences.join(" ");
}

/** R6: the once-per-app offer to draft a DESIGN.md, for a checked app root. */
export function designMdOfferSentence(appRoot: string): string {
  return (
    `There's no DESIGN.md for ${JSON.stringify(appRoot)} yet. Before you design in it, ask the person once with ask_user_question: ` +
    `"No DESIGN.md yet. Draft one from the app's current styles?" On yes, call design_system with action draft, fill only the sections you have evidence for, list the rest under omitted, check it with design_system lint and content, then write it with write_file. ` +
    "On no, carry on without it and don't ask again."
  );
}
