// Which store a fact belongs in, shared by the tool, the prompt guidance and
// the background review so all three route the same way. USER.md is the
// person's profile; MEMORY.md is the Bot's own working notes, which hold the
// longer tail (the person's projects and people, background the Bot looked
// up, commitments and lessons) instead of crowding the profile.

export const BOT_MEMORY_USER_ROUTE =
  "the person's profile: who they are, how they like to be helped and spoken to, standing preferences, daily rhythm";

export const BOT_MEMORY_NOTES_ROUTE =
  "your working notes: their projects, work and the people and places in their life, background you looked up for them, " +
  "promises and follow-ups you made, and what you learned about helping them well";
