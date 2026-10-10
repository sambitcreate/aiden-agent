// Display helpers for the model detail card and the benchmark connection.
// Everything here is display-only: list prices and dates never change limits,
// routing, or which models can be chosen.

import { catalogProviderSlug } from "../shared/model-catalog-provider";
import type { ModelCost } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

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

/** "$0.15" under a dollar; otherwise at most two decimals, trimmed ("$3", "$2.5"). */
function formatDollars(value: number): string {
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${Number(value.toFixed(2))}`;
}

/** models.dev list price per 1M tokens: "$3 / $15 per 1M", "Free", or one side with "in"/"out". */
export function formatListPrice(cost: ModelCost | undefined): string | undefined {
  const input = cost?.input;
  const output = cost?.output;
  if (input === undefined && output === undefined) return undefined;
  if (input === 0 && output === 0) return "Free";
  if (input !== undefined && output !== undefined) {
    return `${formatDollars(input)} / ${formatDollars(output)} per 1M`;
  }
  return input !== undefined
    ? `${formatDollars(input)} in per 1M`
    : `${formatDollars(output as number)} out per 1M`;
}

/**
 * A list price applies only to hosted providers that models.dev lists. Local
 * deployments and custom or private endpoints can inherit a public row's price
 * through the catalog fallback, and that price isn't what they cost.
 */
export function showsListPrice(entry: { providerId: string; isLocal: boolean }): boolean {
  return !entry.isLocal && catalogProviderSlug(entry.providerId) !== undefined;
}
