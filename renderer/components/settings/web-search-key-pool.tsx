// Web Search API-key pool editor.
//
// Keys are write-only: the renderer sends a new key once and afterwards sees
// only an opaque entry ID, the user's label, its position, and redacted
// cooldown state. Rotation, failover, and cooldowns run in the main process.

import * as React from "react";
import { ArrowDown, ArrowUp, KeyRound, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Badge, Button, Field, Input, RadioGroup, RadioGroupItem, Text } from "../ui";
import { webSearchApi } from "../../lib/ipc";
import {
  formatWebSearchKeyPoolCooldown,
  moveWebSearchKeyPoolEntry,
  type WebSearchKeyPoolProviderId,
  type WebSearchKeyPoolRendererEntry,
  type WebSearchKeyPoolRendererState,
  type WebSearchKeyPoolStrategy,
} from "../../shared/web-search-key-pool";

const STRATEGY_OPTIONS: ReadonlyArray<{
  value: WebSearchKeyPoolStrategy;
  title: string;
  description: string;
}> = [
  {
    value: "ordered",
    title: "In order",
    description:
      "Always start with the first key. Later keys are used only when earlier ones fail.",
  },
  {
    value: "round-robin",
    title: "Round robin",
    description: "Start each search on the next key to spread usage evenly across the pool.",
  },
];

/** Status label for one pooled key; exported for rendering tests. */
export function webSearchKeyPoolEntryStatus(
  entry: WebSearchKeyPoolRendererEntry,
  now: number,
): { label: string; color: "green" | "warning" | "red" } {
  if (!entry.cooldown || entry.cooldown.until <= now) return { label: "Active", color: "green" };
  const remaining = formatWebSearchKeyPoolCooldown(entry.cooldown.until, now);
  return entry.cooldown.reason === "auth"
    ? { label: `Rejected · retry in ${remaining}`, color: "red" }
    : { label: `Rate limited · retry in ${remaining}`, color: "warning" };
}

export interface WebSearchKeyPoolListProps {
  readonly providerLabel: string;
  readonly state: WebSearchKeyPoolRendererState;
  readonly now: number;
  readonly disabled?: boolean;
  readonly onMove: (index: number, direction: -1 | 1) => void;
  readonly onRemove: (entry: WebSearchKeyPoolRendererEntry) => void;
  readonly onResetCooldown: (entry: WebSearchKeyPoolRendererEntry) => void;
}

/** Presentational, ordered list of pooled keys. */
export function WebSearchKeyPoolList({
  providerLabel,
  state,
  now,
  disabled,
  onMove,
  onRemove,
  onResetCooldown,
}: WebSearchKeyPoolListProps) {
  if (state.entries.length === 0) {
    return (
      <Text as="p" variant="small" color="tertiary" data-web-search-key-pool-empty>
        No {providerLabel} keys saved yet. Add one below.
      </Text>
    );
  }
  const total = state.entries.length;
  return (
    <ol aria-label={`${providerLabel} API keys, in use order`} className="grid gap-1.5">
      {state.entries.map((entry, index) => {
        const status = webSearchKeyPoolEntryStatus(entry, now);
        const cooling = status.color !== "green";
        return (
          <li
            key={entry.id}
            data-web-search-key-entry
            data-entry-id={entry.id}
            data-cooling={cooling ? "true" : "false"}
            tabIndex={0}
            aria-posinset={index + 1}
            aria-setsize={total}
            onKeyDown={(event) => {
              if (disabled) return;
              if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
              event.preventDefault();
              onMove(index, event.key === "ArrowUp" ? -1 : 1);
            }}
            className="group flex min-w-0 items-center gap-2 rounded-control bg-well px-2.5 py-2 outline-none transition-colors duration-150 ease-out hover:bg-list-hover focus-visible:bg-input focus-visible:shadow-control motion-reduce:transition-none"
          >
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center rounded-pill bg-popover text-small-strong text-tertiary"
            >
              {index + 1}
            </span>
            <KeyRound aria-hidden="true" className="size-3.5 shrink-0 text-tertiary" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <Text as="span" variant="small-strong" truncate>
                  {entry.label}
                </Text>
                <Badge color={status.color} data-web-search-key-status>
                  {status.label}
                </Badge>
              </span>
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              {cooling ? (
                <Button
                  size="small"
                  variant="transparent"
                  disabled={disabled}
                  aria-label={`Retry ${entry.label} now`}
                  title="Clear the cooldown so the next search may use this key"
                  onClick={() => onResetCooldown(entry)}
                >
                  <RotateCcw className="size-3.5" />
                  Retry now
                </Button>
              ) : null}
              <Button
                iconOnly
                size="small"
                variant="transparent"
                className="size-7"
                disabled={disabled || index === 0}
                aria-label={`Move ${entry.label} up`}
                title="Move up"
                onClick={() => onMove(index, -1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                iconOnly
                size="small"
                variant="transparent"
                className="size-7"
                disabled={disabled || index === total - 1}
                aria-label={`Move ${entry.label} down`}
                title="Move down"
                onClick={() => onMove(index, 1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                iconOnly
                size="small"
                variant="transparent"
                className="size-7"
                disabled={disabled}
                aria-label={`Remove ${entry.label}`}
                title="Remove key"
                onClick={() => onRemove(entry)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  // Electron prefixes invoke failures with the channel; keep only the reason.
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "");
}

function hasActiveCooldown(state: WebSearchKeyPoolRendererState | null, now: number): boolean {
  return state?.entries.some((entry) => entry.cooldown && entry.cooldown.until > now) === true;
}

/** Stateful pool editor used by the provider setup dialog. */
export function WebSearchKeyPoolEditor({
  providerId,
  providerLabel,
  onChanged,
}: {
  providerId: WebSearchKeyPoolProviderId;
  providerLabel: string;
  /** Called after a successful change so the provider snapshot can refresh. */
  onChanged?: () => void;
}) {
  const [state, setState] = React.useState<WebSearchKeyPoolRendererState | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const [keyDraft, setKeyDraft] = React.useState("");
  const [labelDraft, setLabelDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    webSearchApi.keyPool
      .get(providerId)
      .then((next) => {
        if (!active) return;
        setState(next);
        setNow(Date.now());
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught, "Couldn’t load saved keys."));
      });
    return () => {
      active = false;
    };
  }, [providerId]);

  // Keep the remaining-cooldown labels current only while one is visible.
  const ticking = hasActiveCooldown(state, now);
  React.useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const run = async (
    operation: () => Promise<WebSearchKeyPoolRendererState>,
    success: string,
    failure: string,
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const next = await operation();
      setState(next);
      setNow(Date.now());
      setMessage(success);
      onChanged?.();
      return true;
    } catch (caught) {
      setError(errorMessage(caught, failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addKey = async () => {
    const value = keyDraft.trim();
    if (!value) return;
    const added = await run(
      () => webSearchApi.keyPool.add(providerId, value, labelDraft.trim() || undefined),
      "Key added to the pool. Saving does not select the provider or send a test request.",
      "Couldn’t add the API key.",
    );
    if (added) {
      setKeyDraft("");
      setLabelDraft("");
    }
  };

  const full = state !== null && state.entries.length >= state.maxEntries;

  return (
    <div className="grid gap-4">
      <Field
        label="API keys"
        description="Stored encrypted on this device and never shown again. When a key is rejected or hits its quota, Aiden cools it down and tries the next one."
        orientation="vertical"
      >
        {state ? (
          <WebSearchKeyPoolList
            providerLabel={providerLabel}
            state={state}
            now={now}
            disabled={busy}
            onMove={(index, direction) => {
              const order = moveWebSearchKeyPoolEntry(state.entries, index, direction);
              void run(
                () => webSearchApi.keyPool.reorder(providerId, order),
                "Key order saved.",
                "Couldn’t reorder the keys.",
              );
            }}
            onRemove={(entry) =>
              void run(
                () => webSearchApi.keyPool.remove(providerId, entry.id),
                `${entry.label} removed.`,
                "Couldn’t remove the API key.",
              )
            }
            onResetCooldown={(entry) =>
              void run(
                () => webSearchApi.keyPool.resetCooldown(providerId, entry.id),
                `${entry.label} will be tried on the next search.`,
                "Couldn’t clear the cooldown.",
              )
            }
          />
        ) : error ? null : (
          <Text as="p" variant="small" color="tertiary">
            Loading saved keys…
          </Text>
        )}
        <form
          className="mt-1 grid gap-2 min-[540px]:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void addKey();
          }}
        >
          <Input
            value={labelDraft}
            onChange={(event) => setLabelDraft(event.target.value)}
            placeholder="Label (optional)"
            autoComplete="off"
            spellCheck={false}
            maxLength={48}
            aria-label={`${providerLabel} key label`}
            disabled={busy || full}
            className="h-10 w-full"
          />
          <Input
            type="password"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            placeholder={full ? "The pool is full" : "Paste an API key"}
            autoComplete="new-password"
            spellCheck={false}
            aria-label={`${providerLabel} API key to add`}
            disabled={busy || full}
            className="h-10 w-full"
          />
          <Button
            type="submit"
            variant="accent"
            size="small"
            className="h-10"
            disabled={!keyDraft.trim() || busy || full || state === null}
          >
            <Plus className="size-3.5" />
            Add key
          </Button>
        </form>
        {state ? (
          <Text as="p" variant="small" color="tertiary">
            {state.entries.length} of {state.maxEntries} keys. Cooldowns reset when Aiden restarts.
          </Text>
        ) : null}
      </Field>

      {state && state.entries.length > 1 ? (
        <Field
          label="Rotation"
          description="Failover to the next key happens in both modes."
          orientation="vertical"
        >
          <RadioGroup
            value={state.strategy}
            onValueChange={(value) =>
              void run(
                () =>
                  webSearchApi.keyPool.setStrategy(providerId, value as WebSearchKeyPoolStrategy),
                "Rotation saved.",
                "Couldn’t change the rotation.",
              )
            }
            aria-label={`${providerLabel} key rotation`}
            className="grid gap-2"
            disabled={busy}
          >
            {STRATEGY_OPTIONS.map((option) => (
              <label
                key={option.value}
                htmlFor={`web-search-${providerId}-rotation-${option.value}`}
                className="flex cursor-default items-start gap-2.5 rounded-control bg-well px-3 py-2.5 transition-colors duration-150 hover:bg-list-hover has-[[data-state=checked]]:bg-accent/5 motion-reduce:transition-none"
              >
                <RadioGroupItem
                  id={`web-search-${providerId}-rotation-${option.value}`}
                  value={option.value}
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0">
                  <Text as="span" variant="small-strong" className="block">
                    {option.title}
                  </Text>
                  <Text as="span" variant="small" color="secondary" className="mt-0.5 block">
                    {option.description}
                  </Text>
                </span>
              </label>
            ))}
          </RadioGroup>
        </Field>
      ) : null}

      {message ? (
        <Text as="p" variant="small" color="secondary" role="status">
          {message}
        </Text>
      ) : null}
      {error ? (
        <Text as="p" variant="small" color="red" role="alert">
          {error}
        </Text>
      ) : null}
    </div>
  );
}
