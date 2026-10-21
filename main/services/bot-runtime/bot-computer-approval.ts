// What a `computer` call does, for the Bot rules (plan §8.7).
//
// Inside the Bot's own computer the baseline is allowed: nothing asks per
// click. Rules still read the call through the `computer` classifier
// surface. VNC-lane clicks are only coordinates, so the classifier reads the
// Bot's required intent ("Click Place order"). On the guest driver lane an
// element click also gives the element's role and label and its app and
// window, and typing gives the element the last element click focused, so a
// secure text field reads as credentials. Typed text never reaches the
// classifier.
//
// A key chord that types a character is typing. A plain Backspace or Delete
// is typing too while the guest driver lane has the Bot in a text field (it
// clicked one, and only typed or erased since), so an intent such as "Delete
// the extra letter" never reads as deleting something. Anywhere else (the VNC
// lane, a selected message in Mail) the same key can delete what is selected,
// so it presses something, like every other chord (Return, Command-S,
// Command-Delete): its intent can make any class a click's can, and pressing
// Return to send a message is sending.

import type { BotComputerDriverFacts, BotComputerElement } from "../bot-computers/computer-elements.js";
import { BOT_COMPUTER_MUTATING_ACTIONS, botComputerIntentOf, isBotComputerAction } from "../bot-computers/computer-schema.js";
import { botComputerChordEditsText, botComputerChordErases } from "../bot-computers/computer-keystrokes.js";
import type { BotToolCallCheck } from "./bot-extension.js";
import type { BotLiveApproval } from "./bot-tool-assembly.js";

const ELEMENT_CLICKS = new Set(["click", "double_click", "right_click"]);
/** Roles that take typed text: text fields and areas (secure and search fields among them) and combo boxes. */
const TEXT_ENTRY_ROLES = ["textfield", "textarea", "searchfield", "combobox", "textbox", "searchbox"];

function takesText(element: BotComputerElement | undefined): boolean {
  const role = (element?.role ?? "").toLowerCase().replace(/[^a-z]/gu, "");
  return TEXT_ENTRY_ROLES.some((kind) => role.includes(kind));
}

/** Whether a `key` chord edits text: a character anywhere, Backspace or Delete only in a text field the Bot is in. */
function editsText(keys: string, facts: BotComputerDriverFacts | undefined): boolean {
  if (!botComputerChordEditsText(keys)) return false;
  return !botComputerChordErases(keys) || takesText(facts?.focused);
}

/** The element a guest-driver-lane call acts on, with its app and window, as far as Aiden knows. */
function elementFacts(
  action: string,
  args: { element?: unknown },
  facts: BotComputerDriverFacts | undefined,
): { app?: string; windowTitle?: string; element?: BotComputerElement } {
  if (!facts) return {};
  let element: BotComputerElement | undefined;
  if (ELEMENT_CLICKS.has(action)) {
    element = typeof args.element === "number" ? facts.elements?.get(args.element) : undefined;
  } else if (action === "type" || action === "key") {
    element = facts.focused;
  }
  if (!element || (element.role === undefined && element.label === undefined)) return {};
  return {
    ...(facts.app ? { app: facts.app } : {}),
    ...(facts.windowTitle ? { windowTitle: facts.windowTitle } : {}),
    element: { ...element },
  };
}

/**
 * `facts`: the Bot's newest capture with app on the guest driver lane
 * (`BotComputerToolState.driverFacts`), or `undefined` on the VNC lane.
 */
export function botComputerAction(call: Pick<BotToolCallCheck, "args">, facts?: BotComputerDriverFacts): BotLiveApproval {
  const args = (call.args ?? {}) as { action?: unknown; keys?: unknown; element?: unknown };
  const action = args.action;
  // Looking, waiting and invalid calls change nothing a rule covers; the tool refuses invalid ones.
  if (!isBotComputerAction(action) || !BOT_COMPUTER_MUTATING_ACTIONS.has(action)) return { approval: null };
  const intent = botComputerIntentOf(args);
  // A mutating call without an intent never runs: the tool refuses it before acting.
  if (intent === undefined) return { approval: null };
  const classified = action === "key" && typeof args.keys === "string" && !editsText(args.keys, facts) ? "press" : action;
  return {
    approval: null,
    action: { surface: "computer", action: classified, intent, ...elementFacts(action, args, facts) },
    summary: intent,
  };
}
