// Starter Bots for "Meet Your First Bot". Shared by the desktop empty state and
// onboarding step, and served over Remote so the phones show the same carousel.

import {
  DEFAULT_BOT_AVATAR,
  type BotAvatarAppearance,
  type BotAvatarColor,
  type BotAvatarShape,
  type BotCreateInput,
  type BotDefinition,
} from "./bots.js";

/** A starter character: one recipe colour and one recipe shape. */
export interface BotPresetCharacter {
  shape: BotAvatarShape;
  color: BotAvatarColor;
}

/** 0 = Sunday … 6 = Saturday. */
export type BotPresetWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Friendly schedule; the routines backend turns it into its own schedule shape. */
export type BotPresetRoutineSchedule =
  | { frequency: "daily" | "weekdays"; time: `${number}:${number}` }
  | { frequency: "weekly"; days: readonly BotPresetWeekday[]; time: `${number}:${number}` };

export interface BotPresetRoutine {
  name: string;
  schedule: BotPresetRoutineSchedule;
  prompt: string;
}

export interface BotPreset {
  id: string;
  name: string;
  subtitle: string;
  avatar: BotPresetCharacter;
  instructions: string;
  /** Catalog plugin ids, resolvable with `connectionSuggestionFor`. */
  suggestedConnections: readonly string[];
  suggestedRoutine?: BotPresetRoutine;
}

export const BOT_PRESETS: readonly BotPreset[] = Object.freeze([
  {
    id: "chief-of-staff",
    name: "Chief of Staff",
    subtitle: "Keeps your week on track",
    avatar: { shape: "hex", color: "periwinkle" },
    instructions: [
      "You help me stay on top of my week.",
      "Keep track of what I've promised, what's coming up, and what needs a reply.",
      "Be brief. Lead with what matters most today, then the rest.",
      "When you need a decision from me, offer a few clear choices.",
    ].join("\n"),
    suggestedConnections: ["gmail", "google-calendar", "notion"],
    suggestedRoutine: {
      name: "Morning brief",
      schedule: { frequency: "weekdays", time: "8:00" },
      prompt:
        "Give me a short brief for today: meetings, deadlines, and anything I should reply to.",
    },
  },
  {
    id: "meal-planner",
    name: "Meal Planner",
    subtitle: "Plans meals and shopping lists",
    avatar: { shape: "drop", color: "peach" },
    instructions: [
      "You plan meals for me for the week.",
      "Ask about tastes, allergies, and how much time I have to cook before you plan.",
      "Give a simple plan, a cooking order, and one shopping list grouped by aisle.",
      "Reuse ingredients so little goes to waste.",
    ].join("\n"),
    suggestedConnections: ["notion"],
    suggestedRoutine: {
      name: "Weekly meal plan",
      schedule: { frequency: "weekly", days: [0], time: "9:00" },
      prompt: "Plan this week's meals and the shopping list.",
    },
  },
  {
    id: "inbox-helper",
    name: "Inbox Helper",
    subtitle: "Sorts email and drafts replies",
    avatar: { shape: "cloud", color: "sky" },
    instructions: [
      "You help me get through my email.",
      "Sort messages into: needs a reply, worth reading, and can wait.",
      "Draft short, friendly replies in my voice, and never send anything without asking me first.",
    ].join("\n"),
    suggestedConnections: ["gmail", "outlook-email"],
    suggestedRoutine: {
      name: "Inbox wrap-up",
      schedule: { frequency: "weekdays", time: "17:00" },
      prompt: "Tell me which emails from today still need a reply, with a draft for each.",
    },
  },
  {
    id: "researcher",
    name: "Researcher",
    subtitle: "Digs into topics and sums them up",
    avatar: { shape: "orb", color: "mint" },
    instructions: [
      "You research topics for me.",
      "Look things up, compare sources, and say how sure you are.",
      "Start with a short answer, then the details, then links to where you found them.",
    ].join("\n"),
    suggestedConnections: ["notion", "composio"],
  },
]);

const PRESETS_BY_ID: ReadonlyMap<string, BotPreset> = new Map(
  BOT_PRESETS.map((preset) => [preset.id, preset]),
);

export function getBotPreset(id: string): BotPreset | null {
  return PRESETS_BY_ID.get(id) ?? null;
}

export function botPresetIdempotencyKey(presetId: string): `preset:${string}` {
  return `preset:${presetId}`;
}

/** The full avatar recipe for a preset: the default recipe with the preset's shape and colour. */
export function botPresetAvatar(preset: BotPreset): BotAvatarAppearance {
  return { ...DEFAULT_BOT_AVATAR, shape: preset.avatar.shape, color: preset.avatar.color };
}

export function botPresetCreateInput(preset: BotPreset): BotCreateInput {
  return {
    name: preset.name,
    description: preset.subtitle,
    instructions: preset.instructions,
    avatar: botPresetAvatar(preset),
  };
}

/** Persistence port for `bots:createFromPreset`. `createBot` must store the creation key. */
export interface BotPresetStore {
  findBotByCreationKey(key: string): Promise<BotDefinition | null>;
  createBot(input: BotCreateInput, creationKey: string): Promise<BotDefinition>;
}

export interface BotPresetCreateResult {
  bot: BotDefinition;
  /** True only for the call that made the Bot; run the one-time self-intro only then. */
  created: boolean;
}

export type CreateBotFromPreset = (presetId: string) => Promise<BotPresetCreateResult>;

/**
 * Main-process handler logic for Start Chat. Keyed `preset:<id>`: repeat and
 * concurrent calls for one preset return the same Bot, and only one reports `created`.
 */
export function createBotPresetCreator(store: BotPresetStore): CreateBotFromPreset {
  const inFlight = new Map<string, Promise<BotPresetCreateResult>>();
  return async (presetId) => {
    const preset = getBotPreset(presetId);
    if (!preset) throw new Error("That starter Bot isn't available.");
    const key = botPresetIdempotencyKey(preset.id);
    const pending = inFlight.get(key);
    if (pending) return { bot: (await pending).bot, created: false };

    // Registered synchronously so a concurrent tap joins this lookup-and-create.
    const run = (async (): Promise<BotPresetCreateResult> => {
      const existing = await store.findBotByCreationKey(key);
      if (existing) return { bot: existing, created: false };
      return { bot: await store.createBot(botPresetCreateInput(preset), key), created: true };
    })();
    inFlight.set(key, run);
    try {
      return await run;
    } finally {
      inFlight.delete(key);
    }
  };
}
