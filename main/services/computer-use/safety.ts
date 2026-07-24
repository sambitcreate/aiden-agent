import { createHash } from "node:crypto";
import type { ComputerUseAction, ComputerUseArgs } from "./schema.js";

export const COMPUTER_USE_READ_ONLY_ACTIONS: ReadonlySet<ComputerUseAction> = new Set([
  "capture",
  "wait",
  "list_apps",
  "list_windows",
]);

const KEY_ALIASES: Readonly<Record<string, string>> = {
  command: "cmd",
  control: "ctrl",
  alt: "option",
  windows: "win",
  super: "win",
  meta: "win",
  "⌘": "cmd",
  "⌥": "option",
};
const MODIFIERS = new Set(["cmd", "ctrl", "option", "shift", "fn", "win"]);
const MODIFIER_ORDER = ["ctrl", "option", "shift", "cmd", "fn", "win"];
const BLOCKED_KEY_COMBOS = [
  ["cmd", "q"],
  ["cmd", "shift", "backspace"],
  ["cmd", "shift", "delete"],
  ["cmd", "option", "backspace"],
  ["cmd", "ctrl", "q"],
  ["cmd", "shift", "q"],
  ["cmd", "option", "shift", "q"],
  ["win", "l"],
  ["ctrl", "option", "delete"],
  ["ctrl", "option", "del"],
  ["option", "f4"],
] as const;
const APPROVAL_PAYLOAD_MAX_CHARS = 4_000;

const BLOCKED_TYPE_PATTERNS = [
  /\b(?:curl|wget)\b[^|]{0,8192}\|\s*(?:(?:\/(?:usr\/)?bin\/)?(?:env|command|exec|sudo)\s+)*(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh\b/iu,
  /:\s*\(\)\s*\{\s*:\|:\s*&\s*\}/iu,
];

const GLOBAL_KEYS = new Set(["action"]);
const ACTION_KEYS: Readonly<Record<ComputerUseAction, ReadonlySet<string>>> = {
  capture: new Set(["mode", "app", "pid", "window_id", "max_elements"]),
  click: new Set([
    "element",
    "coordinate",
    "button",
    "modifiers",
    "delivery_mode",
    "bring_to_front",
    "capture_after",
  ]),
  double_click: new Set([
    "element",
    "coordinate",
    "button",
    "delivery_mode",
    "bring_to_front",
    "capture_after",
  ]),
  right_click: new Set([
    "element",
    "coordinate",
    "button",
    "modifiers",
    "delivery_mode",
    "bring_to_front",
    "capture_after",
  ]),
  middle_click: new Set([
    "element",
    "coordinate",
    "button",
    "modifiers",
    "delivery_mode",
    "bring_to_front",
    "capture_after",
  ]),
  drag: new Set([
    "from_element",
    "to_element",
    "from_coordinate",
    "to_coordinate",
    "button",
    "modifiers",
    "delivery_mode",
    "bring_to_front",
    "capture_after",
  ]),
  scroll: new Set([
    "direction",
    "amount",
    "element",
    "coordinate",
    "delivery_mode",
    "bring_to_front",
    "capture_after",
  ]),
  type: new Set(["text", "delivery_mode", "bring_to_front", "capture_after"]),
  key: new Set(["keys", "delivery_mode", "bring_to_front", "capture_after"]),
  set_value: new Set(["element", "value", "capture_after"]),
  wait: new Set(["seconds"]),
  list_apps: new Set(),
  list_windows: new Set(),
  focus_app: new Set(["app", "raise_window", "capture_after"]),
};

export class ComputerUseSafetyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ComputerUseSafetyError";
  }
}

function fail(code: string, message: string): never {
  throw new ComputerUseSafetyError(code, message);
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function finiteCoordinate(value: unknown, name: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)
  ) {
    fail("invalid_coordinate", `${name} must be a two-number non-negative coordinate.`);
  }
  return [value[0] as number, value[1] as number];
}

function nonNegativeIndex(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("invalid_element", `${name} must be a zero-based non-negative integer.`);
  }
  return value as number;
}

function canonicalModifiers(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4) {
    fail("invalid_modifiers", "modifiers must be an array containing at most four keys.");
  }
  const result = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") fail("invalid_modifiers", "Every modifier must be a string.");
    const modifier = KEY_ALIASES[raw.trim().toLowerCase()] ?? raw.trim().toLowerCase();
    if (!MODIFIERS.has(modifier)) fail("invalid_modifiers", `Unsupported modifier ${raw}.`);
    result.add(modifier);
  }
  return [...result].sort(
    (left, right) => MODIFIER_ORDER.indexOf(left) - MODIFIER_ORDER.indexOf(right),
  );
}

export interface ParsedKeyChord {
  key: string;
  modifiers: string[];
}

export function parseComputerUseKeyChord(value: unknown): ParsedKeyChord {
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid_keys", "key requires a non-empty keys chord.");
  }
  const parts = value
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => KEY_ALIASES[part] ?? part);
  const keys = parts.filter((part) => !MODIFIERS.has(part));
  if (keys.length !== 1) {
    fail("invalid_keys", "keys must contain exactly one non-modifier key.");
  }
  const combo = new Set(parts);
  for (const blocked of BLOCKED_KEY_COMBOS) {
    if (blocked.every((part) => combo.has(part))) {
      fail("blocked_key_combo", "That destructive system shortcut is blocked by Aiden.");
    }
  }
  const modifiers = [...new Set(parts.filter((part) => MODIFIERS.has(part)))].sort(
    (left, right) => MODIFIER_ORDER.indexOf(left) - MODIFIER_ORDER.indexOf(right),
  );
  return { key: keys[0], modifiers };
}

function validateTypedText(value: unknown): string {
  if (typeof value !== "string") fail("invalid_text", "type requires text.");
  if (value.length > APPROVAL_PAYLOAD_MAX_CHARS) {
    fail(
      "payload_too_large",
      "type and set_value payloads are limited to 4,000 characters for approval safety.",
    );
  }
  // Normalize compatibility characters, quoted executable names, escaped
  // newlines, and whitespace before matching. Approval is not a substitute
  // for a hard block on obvious shell bootstrap/destruction payloads.
  const policyText = value
    .normalize("NFKC")
    .replace(/\\\r?\n/gu, "")
    .replace(/(["'`])([\w./-]+)\1/gu, "$2")
    .replace(/\s+/gu, " ")
    .trim();
  for (const pattern of BLOCKED_TYPE_PATTERNS) {
    if (pattern.test(policyText)) {
      fail("blocked_text", "Dangerous shell-like text cannot be typed through Computer Use.");
    }
  }
  const shellTokens = policyText.toLowerCase().match(/[^\s;&|()]+/gu) ?? [];
  for (let index = 0; index < shellTokens.length; index += 1) {
    const executable = shellTokens[index].replace(/^.*\//u, "");
    if (executable !== "rm") continue;
    let recursive = false;
    let forced = false;
    let targetsRoot = false;
    for (const token of shellTokens.slice(index + 1)) {
      if (token === "--") continue;
      if (token === "--recursive") recursive = true;
      else if (token === "--force") forced = true;
      else if (/^-[^-]/u.test(token)) {
        recursive ||= token.slice(1).includes("r") || token.slice(1).includes("R");
        forced ||= token.slice(1).includes("f");
      } else if (token === "/" || token === "/*") {
        targetsRoot = true;
      }
    }
    if (recursive && forced && targetsRoot) {
      fail("blocked_text", "Dangerous shell-like text cannot be typed through Computer Use.");
    }
  }
  return value;
}

function requireExclusiveTarget(args: Record<string, unknown>): void {
  const hasElement = own(args, "element");
  const hasCoordinate = own(args, "coordinate");
  if (hasElement === hasCoordinate) {
    fail("invalid_target", "Provide exactly one of element or coordinate.");
  }
}

function applyDelivery(source: Record<string, unknown>, target: Record<string, unknown>): void {
  const delivery = source.delivery_mode ?? "background";
  if (delivery !== "background" && delivery !== "foreground") {
    fail("invalid_delivery", "delivery_mode must be background or foreground.");
  }
  target.delivery_mode = delivery;
  const bringToFront = source.bring_to_front === true;
  if (bringToFront && delivery !== "foreground") {
    fail("invalid_delivery", "bring_to_front requires foreground delivery.");
  }
  if (bringToFront) target.bring_to_front = true;
}

function copyCaptureAfter(source: Record<string, unknown>, target: Record<string, unknown>): void {
  if (source.capture_after === true) target.capture_after = true;
}

/** Validate action-specific combinations and produce the semantic approval fingerprint shape. */
export function normalizeComputerUseArgs(input: ComputerUseArgs): ComputerUseArgs {
  if (!input || typeof input !== "object" || typeof input.action !== "string") {
    fail("invalid_action", "Computer Use requires an action.");
  }
  const source = input as Record<string, unknown>;
  const action = input.action;
  const actionKeys = ACTION_KEYS[action];
  if (!actionKeys) fail("invalid_action", `Unsupported Computer Use action ${String(action)}.`);
  for (const key of Object.keys(source)) {
    if (!GLOBAL_KEYS.has(key) && !actionKeys.has(key)) {
      fail("irrelevant_argument", `${key} is not valid for ${action}.`);
    }
  }

  const result: Record<string, unknown> = { action };
  switch (action) {
    case "capture": {
      const mode = source.mode ?? "som";
      if (mode !== "som" && mode !== "vision" && mode !== "ax") {
        fail("invalid_mode", "capture mode must be som, vision, or ax.");
      }
      result.mode = mode;
      if (source.app !== undefined) {
        if (typeof source.app !== "string" || !source.app.trim())
          fail("invalid_app", "app must be a non-empty string.");
        result.app = source.app.trim();
      }
      const hasPid = own(source, "pid");
      const hasWindow = own(source, "window_id");
      if (hasPid !== hasWindow) {
        fail("invalid_target", "pid and window_id must be supplied together.");
      }
      if (hasPid) {
        if (!Number.isSafeInteger(source.pid) || (source.pid as number) <= 0)
          fail("invalid_target", "pid must be a positive integer.");
        if (!Number.isSafeInteger(source.window_id) || (source.window_id as number) <= 0)
          fail("invalid_target", "window_id must be a positive integer.");
        result.pid = source.pid;
        result.window_id = source.window_id;
      }
      const maxElements = source.max_elements ?? 100;
      if (
        !Number.isSafeInteger(maxElements) ||
        (maxElements as number) < 1 ||
        (maxElements as number) > 1000
      ) {
        fail("invalid_max_elements", "max_elements must be an integer from 1 through 1000.");
      }
      result.max_elements = maxElements;
      break;
    }
    case "click":
    case "double_click":
    case "right_click":
    case "middle_click": {
      requireExclusiveTarget(source);
      if (own(source, "element")) result.element = nonNegativeIndex(source.element, "element");
      else result.coordinate = finiteCoordinate(source.coordinate, "coordinate");
      const forcedButton =
        action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
      const button = source.button ?? forcedButton;
      if (button !== forcedButton && action !== "click") {
        fail("invalid_button", `${action} only supports the ${forcedButton} button.`);
      }
      if (button !== "left" && button !== "right" && button !== "middle") {
        fail("invalid_button", "button must be left, right, or middle.");
      }
      result.button = button;
      const modifiers = canonicalModifiers(source.modifiers);
      if (action === "double_click" && modifiers?.length) {
        fail(
          "unsupported_modifiers",
          "The pinned double_click contract does not accept modifiers.",
        );
      }
      if (modifiers?.length) result.modifiers = modifiers;
      applyDelivery(source, result);
      copyCaptureAfter(source, result);
      break;
    }
    case "drag": {
      const hasFromElement = own(source, "from_element");
      const hasFromCoordinate = own(source, "from_coordinate");
      const hasToElement = own(source, "to_element");
      const hasToCoordinate = own(source, "to_coordinate");
      if (hasFromElement === hasFromCoordinate || hasToElement === hasToCoordinate) {
        fail(
          "invalid_drag",
          "drag requires exactly one source and target, using element or coordinate for each.",
        );
      }
      if (hasFromElement)
        result.from_element = nonNegativeIndex(source.from_element, "from_element");
      else result.from_coordinate = finiteCoordinate(source.from_coordinate, "from_coordinate");
      if (hasToElement) result.to_element = nonNegativeIndex(source.to_element, "to_element");
      else result.to_coordinate = finiteCoordinate(source.to_coordinate, "to_coordinate");
      const button = source.button ?? "left";
      if (button !== "left" && button !== "right" && button !== "middle")
        fail("invalid_button", "button must be left, right, or middle.");
      result.button = button;
      const modifiers = canonicalModifiers(source.modifiers);
      if (modifiers?.length) result.modifiers = modifiers;
      applyDelivery(source, result);
      copyCaptureAfter(source, result);
      break;
    }
    case "scroll": {
      if (!["up", "down", "left", "right"].includes(String(source.direction))) {
        fail("invalid_scroll", "scroll requires direction up, down, left, or right.");
      }
      result.direction = source.direction;
      const amount = source.amount ?? 3;
      if (!Number.isSafeInteger(amount) || (amount as number) < 1 || (amount as number) > 50)
        fail("invalid_scroll", "scroll amount must be an integer from 1 through 50.");
      result.amount = amount;
      if (own(source, "element") && own(source, "coordinate"))
        fail("invalid_target", "scroll accepts either element or coordinate, not both.");
      if (own(source, "element")) result.element = nonNegativeIndex(source.element, "element");
      if (own(source, "coordinate"))
        result.coordinate = finiteCoordinate(source.coordinate, "coordinate");
      applyDelivery(source, result);
      copyCaptureAfter(source, result);
      break;
    }
    case "type":
      result.text = validateTypedText(source.text);
      applyDelivery(source, result);
      copyCaptureAfter(source, result);
      break;
    case "key": {
      const chord = parseComputerUseKeyChord(source.keys);
      result.keys = [...chord.modifiers, chord.key].join("+");
      applyDelivery(source, result);
      copyCaptureAfter(source, result);
      break;
    }
    case "set_value":
      result.element = nonNegativeIndex(source.element, "element");
      if (typeof source.value !== "string") fail("invalid_value", "set_value requires value.");
      result.value = validateTypedText(source.value);
      copyCaptureAfter(source, result);
      break;
    case "wait": {
      const seconds = source.seconds ?? 1;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 30)
        fail("invalid_wait", "wait seconds must be between 0 and 30.");
      result.seconds = seconds;
      break;
    }
    case "list_apps":
    case "list_windows":
      break;
    case "focus_app":
      if (typeof source.app !== "string" || !source.app.trim())
        fail("invalid_app", "focus_app requires a non-empty app name or bundle id.");
      result.app = source.app.trim();
      if (source.raise_window === true) result.raise_window = true;
      copyCaptureAfter(source, result);
      break;
  }
  return result as ComputerUseArgs;
}

export function computerUseNeedsApproval(args: ComputerUseArgs): boolean {
  return !COMPUTER_USE_READ_ONLY_ACTIONS.has(args.action);
}

/** Approval summaries show the full JSON-encoded payload the user is authorizing. */
export function summarizeTypedApprovalPayload(value: string): string {
  return JSON.stringify(value);
}

export function summarizeComputerUseApproval(args: ComputerUseArgs): string {
  const normalized = normalizeComputerUseArgs(args) as Record<string, unknown>;
  const foreground = normalized.delivery_mode === "foreground" ? " [VISIBLE FOREGROUND]" : "";
  const after = normalized.capture_after === true ? " then capture" : "";
  switch (normalized.action) {
    case "click":
    case "double_click":
    case "right_click":
    case "middle_click":
      return `${normalized.action} ${own(normalized, "element") ? `element ${normalized.element}` : `at ${JSON.stringify(normalized.coordinate)}`}${foreground}${after}`;
    case "drag":
      return `drag ${String(normalized.from_element ?? JSON.stringify(normalized.from_coordinate))} to ${String(normalized.to_element ?? JSON.stringify(normalized.to_coordinate))}${foreground}${after}`;
    case "scroll":
      return `scroll ${String(normalized.direction)} x${String(normalized.amount)}${foreground}${after}`;
    case "type":
      return `type ${summarizeTypedApprovalPayload(String(normalized.text))}${foreground}${after}`;
    case "key":
      return `press ${JSON.stringify(normalized.keys)}${foreground}${after}`;
    case "set_value":
      return `set element ${String(normalized.element)} to ${summarizeTypedApprovalPayload(String(normalized.value))}${after}`;
    case "focus_app":
      return `target ${JSON.stringify(normalized.app)}${normalized.raise_window === true ? " and bring it to front [VISIBLE FOREGROUND]" : " in the background"}${after}`;
    default:
      return String(normalized.action);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export interface ComputerUseBoundTarget {
  pid: number;
  windowId: number;
}

export interface ComputerUseGrantPrepared {
  targetRevision: number;
  fingerprint: string;
  boundTarget?: ComputerUseBoundTarget;
}

export interface ComputerUseGrantConsumed {
  boundTarget?: ComputerUseBoundTarget;
}

interface StoredGrant {
  fingerprint: string;
  boundTarget?: ComputerUseBoundTarget;
}

/** Per-generation, one-use approval capabilities for privileged Computer Use calls. */
export class ComputerUseGrantLedger {
  private readonly grants = new Map<string, StoredGrant>();

  constructor(
    private readonly generationId: string,
    private readonly targetRevision: () => number,
  ) {}

  prepare(args: ComputerUseArgs, boundTarget?: ComputerUseBoundTarget): ComputerUseGrantPrepared {
    const normalized = normalizeComputerUseArgs(args);
    if (!computerUseNeedsApproval(normalized)) {
      fail("approval_invalid", "A read-only Computer Use action does not need approval.");
    }
    const targetRevision = this.targetRevision();
    return {
      targetRevision,
      fingerprint: this.fingerprint(normalized, targetRevision, boundTarget),
      ...(boundTarget ? { boundTarget } : {}),
    };
  }

  authorize(toolCallId: string, args: ComputerUseArgs, prepared: ComputerUseGrantPrepared): void {
    const normalized = normalizeComputerUseArgs(args);
    if (!computerUseNeedsApproval(normalized)) return;
    if (!toolCallId || this.grants.has(toolCallId)) {
      fail("approval_invalid", "Computer Use approval could not be issued safely.");
    }
    if (
      prepared.targetRevision !== this.targetRevision() ||
      prepared.fingerprint !==
        this.fingerprint(normalized, prepared.targetRevision, prepared.boundTarget)
    ) {
      fail(
        "approval_expired",
        "The Computer Use target or action changed after the approval prompt. Capture and approve it again.",
      );
    }
    this.grants.set(toolCallId, {
      fingerprint: prepared.fingerprint,
      ...(prepared.boundTarget ? { boundTarget: prepared.boundTarget } : {}),
    });
  }

  consume(toolCallId: string, args: ComputerUseArgs): ComputerUseGrantConsumed {
    const normalized = normalizeComputerUseArgs(args);
    if (!computerUseNeedsApproval(normalized)) return {};
    const expected = this.grants.get(toolCallId);
    this.grants.delete(toolCallId);
    if (
      !expected ||
      expected.fingerprint !==
        this.fingerprint(normalized, this.targetRevision(), expected.boundTarget)
    ) {
      fail(
        "approval_required",
        "This Computer Use action was not approved, changed after approval, or was already used.",
      );
    }
    return expected.boundTarget ? { boundTarget: expected.boundTarget } : {};
  }

  clear(): void {
    this.grants.clear();
  }

  get size(): number {
    return this.grants.size;
  }

  private fingerprint(
    args: ComputerUseArgs,
    targetRevision: number,
    boundTarget?: ComputerUseBoundTarget,
  ): string {
    return createHash("sha256")
      .update(
        canonicalJson({
          generation: this.generationId,
          targetRevision,
          ...(boundTarget ? { boundTarget } : {}),
          args,
        }),
      )
      .digest("hex");
  }
}
