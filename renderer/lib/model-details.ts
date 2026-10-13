// Display helpers for the model detail card and the benchmark connection.
// Everything here is display-only: list prices and dates never change limits,
// routing, or which models can be chosen.

import { catalogProviderSlug } from "../shared/model-catalog-provider";
import type { ModelCost } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Benchmark snapshots older than this are flagged as stale. */
export const BENCHMARK_STALE_DAYS = 60;

/** Signed in with a ChatGPT plan rather than billed per token. */
const SUBSCRIPTION_PROVIDER_IDS = new Set(["openai-codex"]);

/** Whether an ISO date lies more than `days` days before `now`; false when missing or invalid. */
export function isOlderThanDays(
  iso: string | undefined,
  days: number,
  now: number = Date.now(),
): boolean {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) && now - time > days * DAY_MS;
}

/**
 * "$0.004" below a cent (three significant digits), "$0.15" under a dollar,
 * otherwise at most two decimals, trimmed ("$3", "$2.5").
 */
function formatDollars(value: number): string {
  if (value > 0 && value < 0.01) return `$${Number(value.toPrecision(3))}`;
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${Number(value.toFixed(2))}`;
}

/**
 * models.dev list price per 1M tokens: "$3 / $15 per 1M", "Free", one side with
 * "in"/"out", or "Free in / $5 out per 1M" when only one side is free.
 */
export function formatListPrice(cost: ModelCost | undefined): string | undefined {
  const input = cost?.input;
  const output = cost?.output;
  if (input === undefined && output === undefined) return undefined;
  if (input === 0 && output === 0) return "Free";
  if (input !== undefined && output !== undefined) {
    if (input === 0 || output === 0) {
      const side = (value: number, name: string) =>
        value === 0 ? `Free ${name}` : `${formatDollars(value)} ${name}`;
      return `${side(input, "in")} / ${side(output, "out")} per 1M`;
    }
    return `${formatDollars(input)} / ${formatDollars(output)} per 1M`;
  }
  const [side, value] = input !== undefined ? ["in", input] : ["out", output as number];
  return value === 0 ? `Free ${side}` : `${formatDollars(value)} ${side} per 1M`;
}

/**
 * A list price applies only to hosted, per-token providers that models.dev
 * lists. Local deployments and custom or private endpoints can inherit a public
 * row's price through the catalog fallback, and subscription sign-ins aren't
 * billed per token, so the price isn't what they cost.
 */
export function showsListPrice(entry: { providerId: string; isLocal: boolean }): boolean {
  return (
    !entry.isLocal &&
    !SUBSCRIPTION_PROVIDER_IDS.has(entry.providerId) &&
    catalogProviderSlug(entry.providerId) !== undefined
  );
}
