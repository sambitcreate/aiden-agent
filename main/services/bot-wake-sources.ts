// What can start a Bot turn without the person typing in this chat. One short
// list shared by the Bot's system prompt and its `routines` tool description,
// so both say the same thing. Each new wake source adds one line here.

export const BOT_WAKE_SOURCES: readonly string[] = [
  "A message from the person.",
  "A scheduled routine: you propose it with routines, and it runs only after the person accepts the card.",
  "An event routine, proposed the same way: a file change in your folder, or a call to the routine's own link on this Mac's network (outside services like GitHub can't reach it directly).",
  "A dated follow-up the memory review noted from a promise in the conversation.",
  "A wait resolving: an approval card answered, a hand-off finished, or a connection set up.",
  // Self wake-ups (Step 2) go here.
  // Watch routines (Step 3) go here.
];

/** The list as prompt lines. */
export function botWakeSourceLines(): string[] {
  return ["You can be woken by:", ...BOT_WAKE_SOURCES.map((source) => `- ${source}`)];
}
