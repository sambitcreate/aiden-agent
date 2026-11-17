// Bot Templates (plan §4.3): the four starter Bots, versioned. The desktop
// shows them in the Create menu's Templates dialog, and Remote serves them so
// the phones show the same list. Also the silent first Bot (§4.1): "Chief",
// with a random look and the starter instructions.

import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  DEFAULT_BOT_AVATAR,
  type BotAvatarAppearance,
  type BotAvatarColor,
  type BotAvatarShape,
  type BotCreateInput,
  type BotDefinition,
} from "./bots.js";
import type { BotRoutineSchedule } from "./bot-routine-schedule.js";

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
  /**
   * Bumped whenever what the template adds changes (name, instructions,
   * routine). A preview of an older version refuses to create.
   */
  version: number;
  name: string;
  subtitle: string;
  avatar: BotPresetCharacter;
  instructions: string;
  /** Catalog plugin ids, resolvable with `connectionSuggestionFor`. */
  suggestedConnections: readonly string[];
  suggestedRoutine?: BotPresetRoutine;
  /** A short made-up sample of what this Bot writes, shown faded on its card. */
  sample: readonly string[];
}

export const BOT_PRESETS: readonly BotPreset[] = Object.freeze([
  {
    id: "chief-of-staff",
    version: 1,
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
    sample: [
      "Today: design review at 10, Priya’s draft is due at 3.",
      "Two emails still need a reply: the venue and the invoice.",
      "Want me to block an hour for the deck?",
    ],
    suggestedRoutine: {
      name: "Morning brief",
      schedule: { frequency: "weekdays", time: "8:00" },
      prompt:
        "Give me a short brief for today: meetings, deadlines, and anything I should reply to.",
    },
  },
  {
    id: "meal-planner",
    version: 1,
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
    sample: [
      "Mon: lemon chicken with rice. Tue: leftovers in wraps.",
      "Shopping, produce: lemons, spinach, 2 onions.",
      "Cook the rice once on Monday for both nights.",
    ],
    suggestedRoutine: {
      name: "Weekly meal plan",
      schedule: { frequency: "weekly", days: [0], time: "9:00" },
      prompt: "Plan this week's meals and the shopping list.",
    },
  },
  {
    id: "inbox-helper",
    version: 1,
    name: "Inbox Helper",
    subtitle: "Sorts email and drafts replies",
    avatar: { shape: "cloud", color: "sky" },
    instructions: [
      "You help me get through my email.",
      "Sort messages into: needs a reply, worth reading, and can wait.",
      "Draft short, friendly replies in my voice, and never send anything without asking me first.",
    ].join("\n"),
    suggestedConnections: ["gmail", "outlook-email"],
    sample: [
      "Needs a reply (3): the landlord, Sam, the dentist.",
      "Draft to Sam: “Thursday works, see you at 6.”",
      "Can wait: 12 newsletters and receipts.",
    ],
    suggestedRoutine: {
      name: "Inbox wrap-up",
      schedule: { frequency: "weekdays", time: "17:00" },
      prompt: "Tell me which emails from today still need a reply, with a draft for each.",
    },
  },
  {
    id: "researcher",
    version: 1,
    name: "Researcher",
    subtitle: "Digs into topics and sums them up",
    avatar: { shape: "orb", color: "mint" },
    instructions: [
      "You research topics for me.",
      "Look things up, compare sources, and say how sure you are.",
      "Start with a short answer, then the details, then links to where you found them.",
    ].join("\n"),
    suggestedConnections: ["notion", "composio"],
    sample: [
      "Short answer: yes, heat pumps save money in mild winters.",
      "Fairly sure. Three of four sources agree.",
      "Details and links below.",
    ],
  },
]);

const PRESETS_BY_ID: ReadonlyMap<string, BotPreset> = new Map(
  BOT_PRESETS.map((preset) => [preset.id, preset]),
);

export function getBotPreset(id: string): BotPreset | null {
  return PRESETS_BY_ID.get(id) ?? null;
}

/** A template routine's friendly schedule in the routines backend's shape. */
export function botPresetRoutineSchedule(schedule: BotPresetRoutineSchedule): BotRoutineSchedule {
  const [hour, minute] = schedule.time.split(":");
  const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
  return schedule.frequency === "weekly"
    ? { kind: "weekly", days: [...schedule.days], time }
    : { kind: schedule.frequency, time };
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

/**
 * What a Bot with no job yet is told (§4.1, §4.2). Stored instructions can't be
 * empty (the Remote wire and the phones require text), so this fixed text
 * stands for "none": while a Bot's instructions are exactly this, it asks for
 * its job and then writes its own description and instructions with
 * `update_bot`.
 */
export const BOT_STARTER_INSTRUCTIONS = [
  "You don't have a job yet.",
  "Ask me what I'd like you to help with.",
  "Once I tell you, write yourself a short description and first instructions with update_bot, then get started.",
].join("\n");

/** Whether a Bot still has no job of its own: its instructions are the starter text. */
export function botHasNoJobYet(instructions: string): boolean {
  return instructions.trim() === BOT_STARTER_INSTRUCTIONS;
}

/** The first Bot's name (§4.1). */
export const BOT_FIRST_BOT_NAME = "Chief";
/** The creation key of the one first Bot onboarding makes. */
export const BOT_FIRST_BOT_KEY = "first-bot";

/** A random colour and shape. `random` returns [0, 1). */
export function randomBotAvatar(random: () => number = Math.random): BotAvatarAppearance {
  const pick = <Value,>(values: readonly Value[]) => values[Math.min(values.length - 1, Math.floor(random() * values.length))]!;
  return { ...DEFAULT_BOT_AVATAR, color: pick(BOT_AVATAR_COLORS), shape: pick(BOT_AVATAR_SHAPES) };
}

/** The silent first Bot: "Chief", a random look, no job yet. */
export function botFirstCreateInput(random: () => number = Math.random): BotCreateInput {
  return { name: BOT_FIRST_BOT_NAME, instructions: BOT_STARTER_INSTRUCTIONS, avatar: randomBotAvatar(random) };
}

/** Persistence port for keyed creation. `createBot` must store the creation key. */
export interface BotPresetStore {
  findBotByCreationKey(key: string): Promise<BotDefinition | null>;
  createBot(input: BotCreateInput, creationKey: string): Promise<BotDefinition>;
}

export interface BotPresetCreateResult {
  bot: BotDefinition;
  /** True only for the call that made the Bot; run the one-time self-intro only then. */
  created: boolean;
}

/** `version` is the template version the person was shown; another refuses. */
export type CreateBotFromPreset = (presetId: string, version?: number) => Promise<BotPresetCreateResult>;

/** The message a stale template preview gets. */
export const BOT_TEMPLATE_STALE_MESSAGE = "This template changed. Close it and open it again.";

/**
 * Keyed, idempotent creation: repeat and concurrent calls for one key return
 * the same Bot, and only one reports `created`.
 */
export function createKeyedBotCreator(store: BotPresetStore) {
  const inFlight = new Map<string, Promise<BotPresetCreateResult>>();
  return async (key: string, input: () => BotCreateInput): Promise<BotPresetCreateResult> => {
    const pending = inFlight.get(key);
    if (pending) return { bot: (await pending).bot, created: false };
    // Registered synchronously so a concurrent tap joins this lookup-and-create.
    const run = (async (): Promise<BotPresetCreateResult> => {
      const existing = await store.findBotByCreationKey(key);
      if (existing) return { bot: existing, created: false };
      return { bot: await store.createBot(input(), key), created: true };
    })();
    inFlight.set(key, run);
    try {
      return await run;
    } finally {
      inFlight.delete(key);
    }
  };
}

/**
 * Main-process handler logic for a Template's Create bot. Keyed `preset:<id>`:
 * repeat and concurrent calls for one template return the same Bot, and only
 * one reports `created`. A `version` that isn't the template's current one is
 * refused before anything is looked up or made.
 */
export function createBotPresetCreator(store: BotPresetStore): CreateBotFromPreset {
  const create = createKeyedBotCreator(store);
  return async (presetId, version) => {
    const preset = getBotPreset(presetId);
    if (!preset) throw new Error("That starter Bot isn't available.");
    if (version !== undefined && version !== preset.version) throw new Error(BOT_TEMPLATE_STALE_MESSAGE);
    return create(botPresetIdempotencyKey(preset.id), () => botPresetCreateInput(preset));
  };
}
