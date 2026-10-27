import manifest from "../../resources/aiden-help/manifest.json";

export const AIDEN_APP_SKILL = Object.freeze(manifest.skill);
const TOPICS: [string, string][] = Object.entries(manifest.topics);
const KEYWORDS: Record<string, string[]> = manifest.keywords;
// Words that say nothing about which topic is meant ("how do I change my ...").
const STOP_WORDS = new Set(
  "a about am an and are aiden be can could current currently do does get has have now using for from how i in is it me my of on or please set should so that the this to turn use want what when where which why will with you your".split(
    " ",
  ),
);
const singular = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
const tokens = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean)
    .map(singular);

export function readAidenHelp(query: unknown): {
  version: number;
  topics: { id: string; text: string }[];
  /** Every topic id, so a miss can be retried with a real topic. */
  available: string[];
} {
  if (typeof query !== "string" || query.length > 256 || /[\\/]/u.test(query))
    throw new Error("Use a product topic or a short search query.");
  const available = TOPICS.map(([id]) => id);
  const exact = TOPICS.find(([id]) => id === query.trim().toLowerCase());
  if (exact) return { version: manifest.version, topics: [{ id: exact[0], text: exact[1] }], available };
  const words = [...new Set(tokens(query).filter((word) => !STOP_WORDS.has(word)))];
  // A topic matches when at least half of the meaningful words appear in its
  // id, keywords or text; keyword hits rank above passing mentions.
  const needed = Math.max(1, Math.ceil(words.length / 2));
  const found = TOPICS.map(([id, text]) => {
    const keywords = new Set(tokens(`${id} ${(KEYWORDS[id] ?? []).join(" ")}`));
    const body = new Set(tokens(text));
    let hits = 0;
    let score = 0;
    for (const word of words) {
      if (keywords.has(word)) score += 2;
      else if (body.has(word)) score += 1;
      else continue;
      hits++;
    }
    return { id, text, hits, score };
  })
    .filter((topic) => words.length > 0 && topic.hits >= needed)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return { version: manifest.version, topics: found.map(({ id, text }) => ({ id, text })), available };
}

/**
 * App guidance for the tools this conversation actually has. A phone chat
 * gets help and read-only control panels, so it must not be told it can read
 * or change settings.
 */
export function aidenAppGuidance(tools?: ReadonlySet<string>): string {
  const has = (name: string) => !tools || tools.has(name);
  const parts = ["You can answer questions about Aiden using aiden_help."];
  if (has("aiden_get_state"))
    parts.push("Read current preferences and the app control policy with aiden_get_state before stating a value.");
  if (has("aiden_show_controls"))
    parts.push("Use aiden_show_controls to show the relevant real settings in chat; showing them changes nothing.");
  if (has("aiden_set_preference")) {
    parts.push(
      "Only use aiden_set_preference for an explicit supported change, and report only its verified result. Respect scope, app policy and trusted confirmation.",
      "The only settings you can change are the rows aiden_get_state returns. You cannot change anything else from chat, for example custom theme colors, providers, API keys, connectors, tool approvals, Computer Use, Bots, voice or notifications.",
    );
  } else {
    parts.push(
      `You cannot read live values or change settings yourself in this chat${has("aiden_show_controls") ? "; show the controls so the user can" : ""}.`,
    );
  }
  parts.push(
    `When you cannot make a change, say so plainly and name the Settings page where the user can make it${has("aiden_open") ? ", opening it with aiden_open when that helps" : ""}. Never say a change happened unless a tool result confirms it.`,
    "Aiden is the product; Pi is its agent engine. Never invent current settings or shipped features.",
  );
  return parts.join(" ");
}
export const AIDEN_APP_GUIDANCE = aidenAppGuidance();
