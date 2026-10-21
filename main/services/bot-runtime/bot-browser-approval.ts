// The approval of a Bot's browser call, and what it does for the Bot rules
// classifier (plan §5.1.5, §6.2).
//
// Clicks, typing and key presses ask the person first; navigation and reads
// don't. Each approval binds the exact tab, page revision, control revision
// and arguments (`browser/approval.ts`), so a page that navigated, a person
// who took over, or changed arguments expire it before the effect. The
// classifier input comes from a probe of the targeted element in Aiden's
// isolated world: its tag, type, autocomplete, role, accessible name and form
// action host. Typed text and field values never reach the classifier, and
// the card leaves typed text out when the field is a password, code or card
// field (or couldn't be read), because a rule's hand-off quotes the card's
// text, also on the person's phone. When a rule hands the call to the
// person, its card opens the page the Bot was on, in the Bot's own tab.

import { isBotHandoffOpenUrl } from "../../../renderer/shared/bot-handoffs.js";
import type { BrowserHoldReason } from "../../../renderer/shared/browser.js";
import {
  assertBrowserToolApproval,
  prepareBrowserToolApproval,
  type BrowserApprovalTarget,
  type BrowserToolApproval,
} from "../browser/approval.js";
import { assertBoundarySelector, BROWSER_HELD_TAB_REFUSED } from "../browser/credential-boundary.js";
import type { BrowserFieldProbe, BrowserProbeTarget } from "../browser/service.js";
import { classifyBotAction, type BotClassifiableAction } from "../bot-rules/classify.js";
import { LOCKED_CLASSES } from "../bot-rules/words.js";
import type { BotToolCallCheck } from "./bot-extension.js";
import type { BotLiveApproval } from "./bot-tool-assembly.js";

/** The Bot browser tools that ask the person before they run. */
export const BOT_BROWSER_ASKING_TOOLS: ReadonlySet<string> = new Set(["browser_click", "browser_type", "browser_press"]);

export interface BotBrowserApprovalPort {
  /** The tab a call without `tabId` acts on: the Bot's current tab. */
  currentTabId(): string | undefined;
  /** Why the person holds `tabId`, if they do. */
  heldReason(tabId: string): BrowserHoldReason | undefined;
  approvalTarget(tabId: string): BrowserApprovalTarget;
  probe(tabId: string, target: BrowserProbeTarget, signal: AbortSignal | undefined): Promise<BrowserFieldProbe | undefined>;
  /** Bind the approved call to its execution. */
  authorize(callId: string, approval: BrowserToolApproval, args: Record<string, unknown>): void;
}

type AskingTool = "browser_click" | "browser_type" | "browser_press";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function bounded(text: string, maximum: number): string {
  const characters = [...text];
  return characters.length <= maximum ? text : `${characters.slice(0, maximum - 1).join("")}…`;
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The key as one chord, `Control+Enter`, for the classifier and the card. */
function keyChord(args: Record<string, unknown>): string | undefined {
  const key = stringField(args, "key");
  if (key === undefined) return undefined;
  const modifiers = Array.isArray(args.modifiers) ? args.modifiers.filter((value): value is string => typeof value === "string") : [];
  return [...modifiers, key].join("+");
}

/** What the call targets, as the Bot named it. */
function described(args: Record<string, unknown>): string | undefined {
  const named = stringField(args, "locator") ?? stringField(args, "selector");
  if (named !== undefined) return bounded(named, 120);
  if (typeof args.x === "number" && typeof args.y === "number") return `the point ${Math.round(args.x)}, ${Math.round(args.y)}`;
  return undefined;
}

/**
 * The card's text: what the Bot is about to do, in its own browser, on which
 * page. `hideText` leaves out what it would type.
 */
export function botBrowserApprovalSummary(
  toolName: AskingTool,
  args: Record<string, unknown>,
  url: string,
  options: { hideText?: boolean } = {},
): string {
  const target = described(args);
  let action: string;
  switch (toolName) {
    case "browser_click":
      action = target === undefined ? "Click in its browser" : `Click ${target} in its browser`;
      break;
    case "browser_type": {
      const text = typeof args.text === "string" ? args.text : "";
      const typed =
        text.length === 0 ? "Clear" : options.hideText ? "Type into" : `Type “${bounded(text.replace(/\s+/gu, " "), 160)}” into`;
      action = `${typed} ${target ?? "the focused field"} in its browser`;
      break;
    }
    case "browser_press":
      action = `Press ${keyChord(args) ?? "a key"} in its browser`;
      break;
  }
  return `${action}\n${url}`;
}

function probeTarget(toolName: AskingTool, args: Record<string, unknown>): BrowserProbeTarget {
  const locator = stringField(args, "locator");
  const selector = stringField(args, "selector");
  if (toolName === "browser_press") return { focused: true };
  if (toolName === "browser_type") {
    return locator !== undefined ? { locator } : selector !== undefined ? { selector } : { focused: true };
  }
  if (locator !== undefined) return { locator, click: true };
  if (selector !== undefined) return { selector, click: true };
  if (typeof args.x === "number" && typeof args.y === "number") return { x: args.x, y: args.y, click: true };
  return { click: true };
}

/**
 * The live approval of a Bot browser call. Calls that don't ask need no
 * approval and aren't classified. Throws (and so blocks the call) when there
 * is no tab, the person holds it, the page can't be identified, or a selector
 * tests what a field holds.
 */
export async function botBrowserApproval(
  toolName: string,
  call: BotToolCallCheck,
  port: BotBrowserApprovalPort,
): Promise<BotLiveApproval> {
  if (!BOT_BROWSER_ASKING_TOOLS.has(toolName)) return { approval: null };
  const tool = toolName as AskingTool;
  const args = record(call.args);
  // A selector that tests `value` is refused before the probe runs it in the
  // page, so its match can't say anything about what a field holds.
  assertBoundarySelector(stringField(args, "locator"));
  assertBoundarySelector(stringField(args, "selector"));
  const tabId = stringField(args, "tabId") ?? port.currentTabId();
  if (tabId === undefined) throw new Error("No current browser tab is available. Call browser_open first.");
  if (port.heldReason(tabId) !== undefined) throw new Error(BROWSER_HELD_TAB_REFUSED);
  const pinned = { ...args, tabId };
  const approval = prepareBrowserToolApproval(tool, pinned, port.approvalTarget(tabId));
  const field = await port.probe(tabId, probeTarget(tool, args), call.signal);
  const locator = stringField(args, "locator");
  const selector = stringField(args, "selector");
  const key = tool === "browser_press" ? keyChord(args) : undefined;
  const action: BotClassifiableAction = {
    surface: "browser",
    tool,
    url: approval.target.url,
    ...(locator === undefined ? {} : { locator }),
    ...(selector === undefined ? {} : { selector }),
    ...(key === undefined ? {} : { key }),
    ...(field === undefined ? {} : { field: { ...field } }),
  };
  const secret = field === undefined || [...classifyBotAction(action, []).classes].some((entry) => LOCKED_CLASSES.has(entry));
  // A rule that hands this to the person opens the same page for them, in this tab.
  const page = approval.target.url;
  return {
    ...(isBotHandoffOpenUrl(page) ? { open: { url: page } } : {}),
    approval: {
      summary: botBrowserApprovalSummary(tool, args, approval.target.url, { hideText: secret }),
      // The person answered: the page, tab and control must still be the ones
      // they saw. The execution then pins this tab and checks again.
      onAllow: () => {
        assertBrowserToolApproval(approval, tool, pinned, port.approvalTarget(tabId));
        port.authorize(call.callId, approval, pinned);
      },
    },
    action,
  };
}
