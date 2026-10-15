import manifest from "../../resources/aiden-help/manifest.json";

export const AIDEN_APP_SKILL = Object.freeze(manifest.skill);
export function readAidenHelp(query: unknown): {
  version: number;
  topics: { id: string; text: string }[];
} {
  if (typeof query !== "string" || query.length > 256 || /[\\/]/u.test(query))
    throw new Error("Use a product topic or a short search query.");
  const entries = Object.entries(manifest.topics);
  const exact = entries.find(([id]) => id === query);
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const found = exact
    ? [exact]
    : entries
        .filter(([id, text]) => words.every((word) => `${id} ${text}`.toLowerCase().includes(word)))
        .slice(0, 3);
  return { version: manifest.version, topics: found.map(([id, text]) => ({ id, text })) };
}
export const AIDEN_APP_GUIDANCE =
  "You can answer questions about Aiden using aiden_help and read current capabilities/preferences with aiden_get_state. Use aiden_show_controls to show relevant real settings in chat. Only use aiden_set_preference for explicit supported changes; respect scope, app policy and trusted confirmation. Aiden is the product; Pi is its agent engine. Never invent current settings or shipped features.";
