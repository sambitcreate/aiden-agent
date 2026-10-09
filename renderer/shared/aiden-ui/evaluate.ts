import type { AidenUiExprV1 } from "./types.js";

/**
 * Pure interpreter for the Aiden UI expression AST. It never throws, never
 * runs model code, reads only own properties, never mutates its inputs, and
 * stops after a step budget. Every failure evaluates to `undefined`.
 */

export interface AidenUiScope {
  vars: Readonly<Record<string, unknown>>;
  /** BCP 47 locale for `fmt`; defaults to en-US so results are reproducible. */
  locale?: string;
  budget?: { steps: number };
}

const DEFAULT_STEPS = 20_000;
const MAX_LIST_ITEMS = 10_000;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class BudgetExceeded extends Error {}

export function truthy(value: unknown): boolean {
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  return value !== undefined && value !== null && value !== false && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readMember(base: unknown, key: unknown): unknown {
  if (Array.isArray(base)) {
    return typeof key === "number" && Number.isInteger(key) && key >= 0 && key < base.length ? base[key] : undefined;
  }
  if (!isRecord(base)) return undefined;
  const name = typeof key === "number" ? String(key) : key;
  if (typeof name !== "string" || BLOCKED_KEYS.has(name) || !Object.hasOwn(base, name)) return undefined;
  return base[name];
}

function displayString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function compare(left: unknown, right: unknown): number | undefined {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  return undefined;
}

export function formatValue(
  value: unknown,
  format: "currency" | "percent" | "number" | "date",
  locale = "en-US",
  currency = "USD",
): string {
  if (value === undefined || value === null || value === "") return "";
  try {
    if (format === "date") {
      const date =
        typeof value === "number" ? new Date(value) : typeof value === "string" ? new Date(value) : undefined;
      if (!date || Number.isNaN(date.getTime())) return displayString(value);
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date);
    }
    const number = toNumber(value);
    if (number === undefined) return displayString(value);
    if (format === "currency") {
      return new Intl.NumberFormat(locale, { style: "currency", currency }).format(number);
    }
    if (format === "percent") {
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(number);
    }
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(number);
  } catch {
    return displayString(value);
  }
}

function numbersFrom(args: unknown[]): number[] {
  const [first, field] = args;
  if (Array.isArray(first)) {
    const items = first.slice(0, MAX_LIST_ITEMS);
    const values = typeof field === "string" ? items.map((item) => readMember(item, field)) : items;
    return values.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  }
  return args.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

function callFunction(fn: string, args: unknown[], scope: AidenUiScope): unknown {
  switch (fn) {
    case "fmt": {
      const [value, format, currency] = args;
      if (format !== "currency" && format !== "percent" && format !== "number" && format !== "date") {
        return displayString(value);
      }
      const code = typeof currency === "string" && /^[A-Z]{3}$/u.test(currency) ? currency : "USD";
      return formatValue(value, format, scope.locale, code);
    }
    case "len": {
      const [value] = args;
      if (Array.isArray(value) || typeof value === "string") return value.length;
      if (isRecord(value)) return Object.keys(value).length;
      return 0;
    }
    case "sum":
      return numbersFrom(args).reduce((total, item) => total + item, 0);
    case "max":
    case "min": {
      const values = numbersFrom(args);
      if (values.length === 0) return undefined;
      return fn === "max" ? Math.max(...values) : Math.min(...values);
    }
    case "round": {
      const [value, digits] = args;
      const number = toNumber(value);
      if (number === undefined) return undefined;
      const places = typeof digits === "number" && Number.isInteger(digits) ? Math.min(Math.max(digits, 0), 6) : 0;
      const factor = 10 ** places;
      return Math.round(number * factor) / factor;
    }
    case "filter": {
      const [list, field, wanted] = args;
      if (!Array.isArray(list) || typeof field !== "string") return [];
      return list.slice(0, MAX_LIST_ITEMS).filter((item) => readMember(item, field) === wanted);
    }
    case "sort": {
      const [list, field, direction] = args;
      if (!Array.isArray(list)) return [];
      const sign = direction === "desc" ? -1 : 1;
      const pick = (item: unknown) => (typeof field === "string" && isRecord(item) ? readMember(item, field) : item);
      return list
        .slice(0, MAX_LIST_ITEMS)
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const order = compare(pick(a.item), pick(b.item));
          return order === undefined || order === 0 ? a.index - b.index : sign * order;
        })
        .map((entry) => entry.item);
    }
    default:
      return undefined;
  }
}

function run(expr: AidenUiExprV1, scope: AidenUiScope, budget: { steps: number }): unknown {
  budget.steps -= 1;
  if (budget.steps < 0) throw new BudgetExceeded();
  switch (expr.op) {
    case "lit":
      return expr.v;
    case "json":
      return expr.v;
    case "var":
      return Object.hasOwn(scope.vars, expr.name) ? scope.vars[expr.name] : undefined;
    case "get":
      return readMember(run(expr.of, scope, budget), run(expr.key, scope, budget));
    case "not":
      return !truthy(run(expr.e, scope, budget));
    case "if":
      return truthy(run(expr.test, scope, budget)) ? run(expr.then, scope, budget) : run(expr.else, scope, budget);
    case "bin": {
      if (expr.o === "&&") {
        const left = run(expr.l, scope, budget);
        return truthy(left) ? run(expr.r, scope, budget) : left;
      }
      if (expr.o === "||") {
        const left = run(expr.l, scope, budget);
        return truthy(left) ? left : run(expr.r, scope, budget);
      }
      const left = run(expr.l, scope, budget);
      const right = run(expr.r, scope, budget);
      switch (expr.o) {
        case "+":
          return typeof left === "number" && typeof right === "number"
            ? left + right
            : displayString(left) + displayString(right);
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        default: {
          const order = compare(left, right);
          if (order === undefined) return false;
          if (expr.o === "<") return order < 0;
          if (expr.o === "<=") return order <= 0;
          if (expr.o === ">") return order > 0;
          return order >= 0;
        }
      }
    }
    case "call":
      return callFunction(expr.fn, expr.a.map((arg) => run(arg, scope, budget)), scope);
    default:
      return undefined;
  }
}

export function evaluate(expr: AidenUiExprV1, scope: AidenUiScope): unknown {
  const budget = { steps: scope.budget?.steps ?? DEFAULT_STEPS };
  try {
    return run(expr, scope, budget);
  } catch {
    return undefined;
  }
}
