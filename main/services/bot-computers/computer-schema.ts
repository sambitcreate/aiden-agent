import { Type, type Static } from "@earendil-works/pi-ai";

/**
 * The `computer` tool's arguments (plan §8.6): a subset of
 * `ComputerUseParameters`. Coordinates are pixels of the newest capture on
 * both lanes. A computer with element control (the guest driver lane) also
 * reads one app's elements with `capture` and `app`, and clicks them by
 * `element`; on the VNC lane those two are refused.
 */

export const BOT_COMPUTER_ACTIONS = [
  "capture",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type",
  "key",
  "wait",
  "verify",
] as const;
export type BotComputerAction = (typeof BOT_COMPUTER_ACTIONS)[number];

/** Actions that change the computer: each must say what it is doing (§8.7). */
export const BOT_COMPUTER_MUTATING_ACTIONS: ReadonlySet<BotComputerAction> = new Set<BotComputerAction>([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type",
  "key",
]);

export const BOT_COMPUTER_INTENT_MAX_CHARS = 120;
export const BOT_COMPUTER_TEXT_MAX_CHARS = 4_000;
export const BOT_COMPUTER_EXPECT_MAX_CHARS = 200;
export const BOT_COMPUTER_WAIT_MAX_SECONDS = 30;

// The same homogeneous, fixed-length array `computer_use` publishes: some
// OpenAI-compatible providers reject draft-07 tuple schemas.
const Coordinate = Type.Unsafe<[number, number]>(
  Type.Array(Type.Number({ minimum: 0 }), {
    minItems: 2,
    maxItems: 2,
    description: "[x, y] in pixels of the newest capture.",
  }),
);

const Modifier = Type.Union(
  ["cmd", "command", "shift", "option", "alt", "ctrl", "control"].map((modifier) => Type.Literal(modifier)),
);

export const BotComputerParameters = Type.Object(
  {
    action: Type.Union(
      BOT_COMPUTER_ACTIONS.map((action) => Type.Literal(action)),
      {
        description:
          "capture: a screenshot. click, double_click, right_click, drag, scroll: the pointer. type: text. key: one key chord. wait: pause. verify: a fresh screenshot to check the result against expect.",
      },
    ),
    intent: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: BOT_COMPUTER_INTENT_MAX_CHARS,
        description:
          'Required for click, double_click, right_click, drag, scroll, type and key: what this step does, in a few words, e.g. "Click Place order" or "Type the search terms". Never include typed text, passwords or codes.',
      }),
    ),
    app: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description:
          "capture only, with element control: also list this app's numbered elements (its name, such as \"Safari\", or its bundle id).",
      }),
    ),
    element: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 10_000,
        description:
          "click, double_click and right_click only, with element control: an element number from the newest capture with app, in place of coordinate.",
      }),
    ),
    coordinate: Type.Optional(Coordinate),
    from_coordinate: Type.Optional(Coordinate),
    to_coordinate: Type.Optional(Coordinate),
    modifiers: Type.Optional(
      Type.Array(Modifier, {
        maxItems: 4,
        uniqueItems: true,
        description: "Clicks and drags only: keys held during the action.",
      }),
    ),
    direction: Type.Optional(
      Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
    ),
    amount: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 50, default: 3, description: "scroll only: wheel steps." }),
    ),
    text: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: BOT_COMPUTER_TEXT_MAX_CHARS,
        description:
          "type only: the text to type. It can never contain line breaks or tabs; send Return or Tab with key as its own step.",
      }),
    ),
    keys: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description: 'key only: one key with optional modifiers joined by "+", e.g. "return", "tab" or "cmd+s".',
      }),
    ),
    seconds: Type.Optional(
      Type.Number({ minimum: 0, maximum: BOT_COMPUTER_WAIT_MAX_SECONDS, default: 1, description: "wait only." }),
    ),
    expect: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: BOT_COMPUTER_EXPECT_MAX_CHARS,
        description: "verify only: what the screen should now show.",
      }),
    ),
    capture_after: Type.Optional(
      Type.Boolean({ description: "Return a fresh screenshot after the action." }),
    ),
  },
  { additionalProperties: false },
);

export type BotComputerArgs = Static<typeof BotComputerParameters>;

/** Control and invisible format characters (bidi overrides, zero-width marks). */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/**
 * The Bot's stated intent as rules, cards and the status line read it: one
 * line, control and format characters removed, at most 120 characters.
 * `undefined` when the call states none.
 */
export function botComputerIntentOf(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const raw = (args as { intent?: unknown }).intent;
  if (typeof raw !== "string") return undefined;
  const clean = raw.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  if (!clean) return undefined;
  const points = [...clean];
  return points.length > BOT_COMPUTER_INTENT_MAX_CHARS ? points.slice(0, BOT_COMPUTER_INTENT_MAX_CHARS).join("").trimEnd() : clean;
}

export function isBotComputerAction(value: unknown): value is BotComputerAction {
  return typeof value === "string" && (BOT_COMPUTER_ACTIONS as readonly string[]).includes(value);
}
