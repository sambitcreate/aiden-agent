// Which rule classes a pending Bot tool call belongs to (plan §6.2).
//
// One classifier for every surface a Bot acts through: Computer Use on the
// Mac, a Bot computer, the Bot browser and mutating connection (MCP) tools.
// Each surface turns its pending call into a `BotClassifiableAction` and this
// file decides, from structured signals first and words second, which action
// classes it belongs to and which of the person's own rules it matches.
//
// Inputs never carry typed text, field values or secrets: a `type` action has
// no text, and an element is only its role and label.
//
// Precision rules, so a hand-off never fires on every click:
//
// - Locked classes (credentials, money) take structured signals (a secure text
//   field, password or one-time-code autocomplete, card autocomplete, a
//   payment host) and their precise words wherever a label is known. Nothing
//   negates them.
// - The other classes take words only from what the action presses: a button
//   or link's label, a menu leaf, a tool's name, title or first description
//   sentence. Typing into a field labelled "Reply" is not sending.
// - Window titles, URL hosts and app names never make a class by word; they
//   only feed custom-rule matching.

import {
  BOT_ACTION_CLASSES,
  type BotActionClass,
  type BotRule,
} from "../../../renderer/shared/bot-rules.js";
import { parseComputerUseKeyChord } from "../computer-use/safety.js";
import {
  actionStems,
  COMMUNICATION_APPS,
  contentStems,
  INSTALL_LEAVES,
  isPaymentHost,
  LOCKED_CLASSES,
  MCP_NAME_VERBS,
  MCP_POST_MESSAGE_WORDS,
  phraseMatches,
  phraseStems,
  stem,
  tokenize,
} from "./words.js";

export interface BotUiElement {
  role?: string;
  label?: string;
}

export type BotClassifiableAction =
  | {
      surface: "computer_use";
      /** The Computer Use action: click, type, key, set_value, menu, … */
      action: string;
      app?: string;
      windowTitle?: string;
      /** The element the action targets, from the latest capture. */
      element?: BotUiElement;
      /** For type and key: the element last focused in this window. */
      focusedElement?: BotUiElement;
      /** The window's latest capture had a secure text field. */
      secureFieldInCapture?: boolean;
      menuPath?: readonly string[];
      keys?: string;
    }
  | {
      surface: "computer";
      action: string;
      /** The Bot's own words for what it is doing. */
      intent?: string;
      app?: string;
      windowTitle?: string;
      element?: BotUiElement;
    }
  | {
      surface: "browser";
      tool: "browser_click" | "browser_type" | "browser_press";
      url?: string;
      locator?: string;
      selector?: string;
      key?: string;
      field?: {
        tag?: string;
        type?: string;
        autocomplete?: string;
        role?: string;
        accessibleName?: string;
        formActionHost?: string;
      };
    }
  | {
      surface: "mcp";
      /** The model-facing tool name (`<server>__<tool>`). */
      modelName: string;
      serverId: string;
      /** The server's own tool name. */
      remoteName: string;
      summary: string;
      description?: string;
      annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
      destructive: "destructive" | "additive" | "unknown";
    };

export interface BotActionEvidence {
  actionClass?: BotActionClass;
  ruleId?: string;
  kind: "strong" | "word";
  /** What matched, in Aiden's words (never the field's value). */
  source: string;
}

export interface BotActionClassification {
  classes: ReadonlySet<BotActionClass>;
  customRuleIds: ReadonlySet<string>;
  evidence: readonly BotActionEvidence[];
}

const ALL: ReadonlySet<BotActionClass> = new Set(BOT_ACTION_CLASSES);
const NOT_LOCKED: ReadonlySet<BotActionClass> = new Set(BOT_ACTION_CLASSES.filter((entry) => !LOCKED_CLASSES.has(entry)));
const WITHOUT_DELETE: ReadonlySet<BotActionClass> = new Set(BOT_ACTION_CLASSES.filter((entry) => entry !== "delete"));
const MONEY_ONLY: ReadonlySet<BotActionClass> = new Set(["money"]);
const NOT_LOCKED_WITHOUT_DELETE: ReadonlySet<BotActionClass> = new Set(
  [...NOT_LOCKED].filter((entry) => entry !== "delete"),
);

/** Actions that put text or keys into whatever has focus. */
const TYPE_ACTIONS = new Set(["type", "type_text", "key", "press_key", "hotkey", "set_value"]);
/** Actions that change nothing a rule covers. */
const PASSIVE_ACTIONS = new Set([
  "scroll", "move", "mouse_move", "hover", "wait", "capture", "screenshot", "zoom", "list_apps", "list_windows",
  "verify", "set_window_frame", "focus_app", "cursor_position",
]);

/** The longest text a single signal is read from. */
const MAX_TEXT = 1_000;

class Collector {
  readonly classes = new Set<BotActionClass>();
  readonly evidence: BotActionEvidence[] = [];
  /** Words and phrases every custom rule is matched against. */
  readonly ruleText: string[] = [];

  strong(actionClass: BotActionClass, source: string): void {
    this.classes.add(actionClass);
    this.evidence.push({ actionClass, kind: "strong", source });
  }

  /**
   * Class phrases in `text`. Locked classes match every form of a word
   * ("Paid"); the others skip past tenses ("Posted by Ada" is not Post).
   */
  words(text: string | undefined, source: string, classes: ReadonlySet<BotActionClass>): void {
    if (text === undefined || text.length === 0) return;
    const bounded = text.slice(0, MAX_TEXT);
    const locked = new Set([...classes].filter((entry) => LOCKED_CLASSES.has(entry)));
    const others = new Set([...classes].filter((entry) => !LOCKED_CLASSES.has(entry)));
    const found = [
      ...(locked.size > 0 ? phraseMatches(phraseStems(bounded), locked) : []),
      ...(others.size > 0 ? phraseMatches(phraseStems(bounded, { keepPastTense: true }), others) : []),
    ];
    // A longer phrase wins over a shorter one inside it: "Post a message"
    // is a message ("post message"), not a public post ("post").
    const matches = found.filter(
      (match) =>
        !found.some(
          (other) =>
            other.length > match.length &&
            other.actionClass !== match.actionClass &&
            other.index <= match.index &&
            match.index + match.length <= other.index + other.length,
        ),
    );
    for (const match of matches) {
      this.classes.add(match.actionClass);
      this.evidence.push({ actionClass: match.actionClass, kind: "word", source: `${source}: “${match.phrase}”` });
    }
  }

  text(...values: ReadonlyArray<string | undefined>): void {
    for (const value of values) if (value !== undefined && value.length > 0) this.ruleText.push(value.slice(0, MAX_TEXT));
  }
}

function lower(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("en-US");
}

/** `AXSecureTextField`, a secure text field subrole, or a web password input role. */
function isSecureRole(role: string | undefined): boolean {
  const value = lower(role).replace(/[^a-z]/gu, "");
  return value.includes("securetextfield") || value === "secure" || value === "password" || value === "passwordfield";
}

function isCommunicationApp(app: string | undefined): boolean {
  return COMMUNICATION_APPS.has(lower(app));
}

function isFinder(app: string | undefined): boolean {
  const value = lower(app);
  return value === "finder" || value === "com.apple.finder";
}

function chordOf(keys: string | undefined): { key: string; modifiers: readonly string[] } | undefined {
  if (keys === undefined) return undefined;
  try {
    return parseComputerUseKeyChord(keys);
  } catch {
    return undefined;
  }
}

const SUBMIT_KEYS = new Set(["return", "enter", "kp_enter", "keypadenter"]);
const ERASE_KEYS = new Set(["delete", "backspace", "del", "forwarddelete"]);

/** A single printable character (with at most Shift): typing, one key at a time. */
function isPrintableChord(chord: { key: string; modifiers: readonly string[] }): boolean {
  return [...chord.key].length === 1 && chord.modifiers.every((modifier) => modifier === "shift");
}

/**
 * Keys that send in a messaging app: Return (Messages, Slack, WhatsApp) and
 * Command-Return or Shift-Command-D (Mail).
 */
function sendsInMessagingApp(chord: { key: string; modifiers: readonly string[] }): boolean {
  if (SUBMIT_KEYS.has(chord.key)) return chord.modifiers.every((modifier) => modifier === "cmd");
  return chord.key === "d" && chord.modifiers.includes("cmd") && chord.modifiers.includes("shift");
}

/** Command-Delete in Finder moves the selection to the Trash. */
function erasesInFinder(chord: { key: string; modifiers: readonly string[] }): boolean {
  return ERASE_KEYS.has(chord.key) && chord.modifiers.includes("cmd");
}

/** A whole label that installs software, such as the App Store's "Get". */
function isInstallLeaf(label: string | undefined): boolean {
  return INSTALL_LEAVES.has(lower(label).replace(/\s+/gu, " "));
}

/** HTML autocomplete tokens, the section and address-group prefixes dropped. */
function autocompleteTokens(value: string | undefined): string[] {
  return lower(value)
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    .filter((token) => !token.startsWith("section-"))
    .filter((token) => !["shipping", "billing", "home", "work", "mobile", "fax", "pager", "webauthn"].includes(token));
}

const CREDENTIAL_AUTOCOMPLETE = new Set(["current-password", "new-password", "one-time-code"]);

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function classifyComputerUse(action: Extract<BotClassifiableAction, { surface: "computer_use" }>, out: Collector): void {
  const name = lower(action.action);
  out.text(action.app, action.windowTitle, action.element?.label, action.focusedElement?.label, ...(action.menuPath ?? []));
  if (PASSIVE_ACTIONS.has(name)) return;
  const typing = TYPE_ACTIONS.has(name);
  const chord = name === "key" ? chordOf(action.keys) : undefined;

  if (isSecureRole(action.element?.role)) out.strong("credentials", "the targeted element is a secure text field");
  if (typing && isSecureRole(action.focusedElement?.role)) out.strong("credentials", "the focused element is a secure text field");
  if (action.secureFieldInCapture === true && (name === "type" || (chord !== undefined && isPrintableChord(chord)))) {
    out.strong("credentials", "typing while the window shows a secure text field");
  }

  if (name === "menu") {
    const leaf = action.menuPath?.[action.menuPath.length - 1];
    if (isInstallLeaf(leaf)) out.strong("install", "menu item Install");
    out.words(leaf, "menu item", ALL);
  } else if (name === "set_value") {
    out.words(action.element?.label, "field label", LOCKED_CLASSES);
  } else if (typing) {
    out.words(action.focusedElement?.label, "focused field label", LOCKED_CLASSES);
  } else {
    if (isInstallLeaf(action.element?.label)) out.strong("install", "button Get or Install");
    out.words(action.element?.label, "element label", ALL);
  }

  if (chord !== undefined && isCommunicationApp(action.app) && sendsInMessagingApp(chord)) {
    out.strong("communicate", "a send key in a messaging app");
  }
  if (chord !== undefined && isFinder(action.app) && erasesInFinder(chord)) {
    out.strong("delete", "Command-Delete in Finder");
  }
}

function classifyComputer(action: Extract<BotClassifiableAction, { surface: "computer" }>, out: Collector): void {
  const name = lower(action.action);
  out.text(action.app, action.windowTitle, action.element?.label, action.intent);
  if (PASSIVE_ACTIONS.has(name)) return;
  const typing = TYPE_ACTIONS.has(name);
  if (isSecureRole(action.element?.role)) out.strong("credentials", "the targeted element is a secure text field");
  const classes = typing ? LOCKED_CLASSES : ALL;
  if (!typing && isInstallLeaf(action.element?.label)) out.strong("install", "button Get or Install");
  out.words(action.element?.label, typing ? "field label" : "element label", classes);
  out.words(action.intent, "the Bot's stated intent", classes);
}

function classifyBrowser(action: Extract<BotClassifiableAction, { surface: "browser" }>, out: Collector): void {
  const field = action.field;
  const host = hostOf(action.url);
  out.text(field?.accessibleName, action.locator, action.selector, host?.split(".").join(" "));
  const typing = action.tool !== "browser_click";

  if (lower(field?.type) === "password") out.strong("credentials", "a password field");
  if (isSecureRole(field?.role)) out.strong("credentials", "a password field");
  let cardField = false;
  for (const token of autocompleteTokens(field?.autocomplete)) {
    if (CREDENTIAL_AUTOCOMPLETE.has(token)) out.strong("credentials", `autocomplete ${token}`);
    if (token.startsWith("cc-")) {
      cardField = true;
      out.strong("money", "a payment card field");
    }
  }
  if (field?.formActionHost !== undefined && isPaymentHost(field.formActionHost)) {
    out.strong("money", "a form that posts to a payment provider");
    out.strong("purchase", "a form that posts to a payment provider");
  }
  // Anything typed on a payment provider's own page is payment or account
  // details. Clicking around it (Activity, Help) is not.
  if (typing && host !== undefined && isPaymentHost(host)) out.strong("money", "typing on a payment provider's page");

  // A card field's "Security code" is the card's CVC, not a sign-in code.
  const classes = typing ? (cardField ? MONEY_ONLY : LOCKED_CLASSES) : ALL;
  out.words(field?.accessibleName, typing ? "field name" : "button or link name", classes);
  out.words(action.locator, "locator", classes);
  out.words(action.selector, "selector", classes);
}

const POST = stem("post");
const SEND = stem("send");
/** Name words after `send` that make it a payment (`send_money`, `send_payment`). */
const MCP_SEND_MONEY_WORDS: ReadonlySet<string> = new Set(["money", "payment", "fund", "cash"].map(stem));

function classifyMcp(action: Extract<BotClassifiableAction, { surface: "mcp" }>, out: Collector): void {
  const nameStems = tokenize(action.remoteName.slice(0, MAX_TEXT)).map(stem);
  const additive = action.destructive === "additive";
  out.text(action.modelName, action.remoteName, action.summary, action.annotations?.title, action.description);

  for (const verbs of MCP_NAME_VERBS) {
    if (verbs.actionClass === "delete" && additive) continue;
    const anywhere = verbs.anywhere.map(stem);
    const leading = (verbs.leading ?? []).map(stem);
    let matched = nameStems.find((word, index) => {
      if (!anywhere.includes(word)) return false;
      const next = nameStems[index + 1] ?? "";
      // `post_message` posts into a conversation; it is not a public post.
      if (verbs.actionClass === "publish" && word === POST && MCP_POST_MESSAGE_WORDS.has(next)) return false;
      // `send_money` moves money; it is not a message.
      if (verbs.actionClass === "communicate" && word === SEND && MCP_SEND_MONEY_WORDS.has(next)) return false;
      return true;
    });
    if (matched === undefined && nameStems[0] !== undefined && leading.includes(nameStems[0])) matched = nameStems[0];
    if (matched === undefined) {
      for (const phrase of verbs.phrases ?? []) {
        const words = phraseStems(phrase);
        const found = nameStems.some((_, start) => words.every((word, offset) => nameStems[start + offset] === word));
        if (found) {
          matched = phrase;
          break;
        }
      }
    }
    if (matched !== undefined) out.strong(verbs.actionClass, `tool name: “${matched}”`);
  }
  // Credential and money words in the name or summary (`reset_password`,
  // `update_card_details`). The other classes come from the name's verbs
  // above: a noun such as `update_book` or `list_post_drafts` is not a verb.
  out.words(action.remoteName, "tool name", LOCKED_CLASSES);
  out.words(action.summary, "tool summary", LOCKED_CLASSES);
  out.words(action.annotations?.title, "tool title", additive ? WITHOUT_DELETE : ALL);
  // A description is long and mentions other tools; only its first sentence,
  // and never for a locked class.
  const firstSentence = action.description?.split(/(?<=[.!?])\s|\n/u)[0];
  out.words(firstSentence, "tool description", additive ? NOT_LOCKED_WITHOUT_DELETE : NOT_LOCKED);
}

/**
 * The classes this call belongs to and the custom rules it matches. A custom
 * rule matches when every content word of its text (stop words dropped, at
 * least one) appears in the action's labels, intent, tool name, title,
 * summary, window title, app or URL host.
 */
export function classifyBotAction(action: BotClassifiableAction, customRules: readonly BotRule[]): BotActionClassification {
  const out = new Collector();
  switch (action.surface) {
    case "computer_use":
      classifyComputerUse(action, out);
      break;
    case "computer":
      classifyComputer(action, out);
      break;
    case "browser":
      classifyBrowser(action, out);
      break;
    case "mcp":
      classifyMcp(action, out);
      break;
  }
  const customRuleIds = new Set<string>();
  const custom = customRules.filter((rule) => rule.actionClass === undefined && typeof rule.text === "string");
  if (custom.length > 0) {
    const words = new Set(out.ruleText.flatMap(actionStems));
    for (const rule of custom) {
      const needed = contentStems(rule.text!);
      if (needed.length === 0 || !needed.every((word) => words.has(word))) continue;
      customRuleIds.add(rule.id);
      out.evidence.push({ ruleId: rule.id, kind: "word", source: `your rule's words: ${needed.join(", ")}` });
    }
  }
  return { classes: out.classes, customRuleIds, evidence: out.evidence };
}
