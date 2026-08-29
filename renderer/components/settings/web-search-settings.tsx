// Web Search settings — a provider zoo with explicit, user-owned routing.
//
// The main process owns provider adapters, endpoints, and credentials. This
// surface only consumes the redacted snapshot and sends deliberately scoped
// mutations through the generic Web Search IPC seam.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ExternalLink,
  Globe2,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  Field,
  FieldSet,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
} from "../ui";
import { ProviderIcon } from "../provider-icon";
import { webSearchApi } from "../../lib/ipc";
import { queryKeys, useWebSearch } from "../../lib/queries";
import type {
  BoundedNonSecretProviderConfig,
  WebSearchProviderId,
  WebSearchProviderRendererMetadata,
  WebSearchRendererSnapshot,
  WebSearchRouteEntry,
  WebSearchSelection,
} from "../../lib/types";

type WebSearchProvider = WebSearchProviderRendererMetadata;
type CredentialMode = WebSearchRouteEntry["credentialMode"];
type AutomaticSelection = Extract<WebSearchSelection, { mode: "automatic" }>;
type WebSearchFilter =
  | "all"
  | "free"
  | "connected"
  | "api-key"
  | "existing-account"
  | "self-hosted";

const DEFAULT_FALLBACK_ON: AutomaticSelection["fallbackOn"] = [
  "transient",
  "quota",
  "network",
  "invalid-response",
  "unsupported",
];

const FILTERS: ReadonlyArray<{ id: WebSearchFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "free", label: "Free" },
  { id: "connected", label: "Connected" },
  { id: "api-key", label: "API key" },
  { id: "existing-account", label: "Existing account" },
  { id: "self-hosted", label: "Self-hosted" },
];

const COST_LABELS: Record<WebSearchProvider["costClass"], string> = {
  "built-in-free": "Built-in free",
  "provider-free": "Provider free",
  quota: "Quota-based",
  paid: "Paid usage",
  "self-hosted": "Self-hosted",
};

const CREDENTIAL_LABELS: Record<WebSearchProvider["credentialKind"], string> = {
  none: "No credentials",
  "optional-api-key": "Optional API key",
  "api-key": "API key",
  "existing-provider-auth": "Existing provider account",
  endpoint: "Endpoint",
  "endpoint-and-api-key": "Endpoint + API key",
  "api-key-and-zone": "API key + zone",
};

const CREDENTIAL_MODE_LABELS: Record<CredentialMode, string> = {
  anonymous: "Anonymous route",
  "api-key": "API key",
  "existing-provider-auth": "Existing account",
  endpoint: "Configured endpoint",
};

const FALLBACK_LABELS: Record<AutomaticSelection["fallbackOn"][number], string> = {
  timeout: "Timeout",
  network: "Network error",
  quota: "Quota or rate limit",
  transient: "Temporary provider error",
  unsupported: "Unsupported capability",
  "invalid-response": "Invalid response",
};

function defaultCredentialMode(provider: WebSearchProvider): CredentialMode {
  switch (provider.credentialKind) {
    case "none":
    case "optional-api-key":
      return "anonymous";
    case "existing-provider-auth":
      return "existing-provider-auth";
    case "endpoint":
      return "endpoint";
    case "api-key":
    case "endpoint-and-api-key":
    case "api-key-and-zone":
      return "api-key";
  }
}

function providerNeedsApiKey(provider: WebSearchProvider): boolean {
  return (
    provider.credentialKind === "optional-api-key" ||
    provider.credentialKind === "api-key" ||
    provider.credentialKind === "endpoint-and-api-key" ||
    provider.credentialKind === "api-key-and-zone"
  );
}

function providerNeedsEndpoint(provider: WebSearchProvider): boolean {
  return (
    provider.credentialKind === "endpoint" || provider.credentialKind === "endpoint-and-api-key"
  );
}

function providerNeedsZone(provider: WebSearchProvider): boolean {
  return provider.credentialKind === "api-key-and-zone";
}

function providerStatus(provider: WebSearchProvider): {
  label: string;
  color?: "green" | "red" | "blue";
} {
  if (provider.configurationStatus === "invalid") {
    return { label: "Needs attention", color: "red" };
  }
  if (provider.configurationStatus === "needs-setup") {
    return { label: "Needs setup" };
  }
  if (provider.configurationStatus === "configured") {
    return {
      label: provider.ready ? "Configured" : "Unavailable",
      color: provider.ready ? "green" : "red",
    };
  }
  if (provider.ready) return { label: "Built-in ready", color: "blue" };
  return { label: "Unavailable" };
}

function routeStatusLabel(
  provider: WebSearchProvider | undefined,
  readiness: WebSearchRendererSnapshot["routeReadiness"][number] | undefined,
): { label: string; color?: "green" | "red" | "blue" } {
  if (!provider) return { label: "Unavailable" };
  if (readiness?.configurationStatus === "needs-setup") return { label: "Needs setup" };
  if (readiness?.configurationStatus === "invalid" || !readiness?.ready) {
    return { label: "Needs attention", color: "red" };
  }
  if (readiness?.configurationStatus === "configured") return { label: "Ready", color: "green" };
  return { label: "Ready", color: "blue" };
}

function providerMatchesFilter(provider: WebSearchProvider, filter: WebSearchFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "free":
      return provider.costClass === "built-in-free" || provider.costClass === "provider-free";
    case "connected":
      return provider.configurationStatus === "configured";
    case "api-key":
      return providerNeedsApiKey(provider);
    case "existing-account":
      return (
        provider.credentialKind === "existing-provider-auth" ||
        provider.capabilities.includes("existing-provider-auth")
      );
    case "self-hosted":
      return (
        provider.costClass === "self-hosted" ||
        provider.credentialKind === "endpoint" ||
        provider.credentialKind === "endpoint-and-api-key"
      );
  }
}

function providerMatchesSearch(provider: WebSearchProvider, search: string): boolean {
  if (!search) return true;
  return `${provider.label} ${provider.description} ${provider.id}`
    .toLocaleLowerCase()
    .includes(search);
}

function routeSummary(snapshot: WebSearchRendererSnapshot): string {
  const labels = snapshot.route.map((entry) => {
    const provider = snapshot.providers.find(
      (candidate) => candidate.id === entry.providerId && candidate.releaseState === "shipped",
    );
    return provider?.label ?? "Unavailable provider";
  });
  if (snapshot.selection.mode === "fixed") {
    return `Fixed · ${labels[0] ?? "Unavailable provider"}`;
  }
  return labels.length > 0 ? `Automatic · ${labels.join(" → ")}` : "Automatic · No destination";
}

function routeEntryFor(
  snapshot: WebSearchRendererSnapshot,
  providerId: WebSearchProviderId,
): WebSearchRouteEntry | undefined {
  return snapshot.route.find((entry) => entry.providerId === providerId);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function LinkIcon() {
  return <ExternalLink aria-hidden="true" className="size-3.5" />;
}

function ProviderGroup({
  title,
  providers,
  route,
  fixedProviderId,
  onConfigure,
  onAddToRoute,
  onUseForSearch,
}: {
  title: string;
  providers: readonly WebSearchProvider[];
  route: readonly WebSearchRouteEntry[];
  fixedProviderId?: WebSearchProviderId;
  onConfigure: (provider: WebSearchProvider, trigger: HTMLButtonElement) => void;
  onAddToRoute: (provider: WebSearchProvider) => void;
  onUseForSearch: (provider: WebSearchProvider) => void;
}) {
  if (providers.length === 0) return null;
  const headingId = `web-search-group-${title.toLocaleLowerCase().replace(/ /g, "-")}`;
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex items-center gap-2 px-1">
        <Text id={headingId} variant="small-strong" color="secondary">
          {title}
        </Text>
        <Badge>{providers.length}</Badge>
      </div>
      <div className="grid grid-cols-1 gap-3 min-[680px]:grid-cols-2">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            route={route}
            fixedProviderId={fixedProviderId}
            onConfigure={onConfigure}
            onAddToRoute={onAddToRoute}
            onUseForSearch={onUseForSearch}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({
  provider,
  route,
  fixedProviderId,
  onConfigure,
  onAddToRoute,
  onUseForSearch,
}: {
  provider: WebSearchProvider;
  route: readonly WebSearchRouteEntry[];
  fixedProviderId?: WebSearchProviderId;
  onConfigure: (provider: WebSearchProvider, trigger: HTMLButtonElement) => void;
  onAddToRoute: (provider: WebSearchProvider) => void;
  onUseForSearch: (provider: WebSearchProvider) => void;
}) {
  const inRoute = route.some((entry) => entry.providerId === provider.id);
  const isFixed = fixedProviderId === provider.id;
  const status = providerStatus(provider);
  return (
    <article
      data-web-search-provider-card
      data-provider-id={provider.id}
      data-in-route={inRoute ? "true" : "false"}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-separator bg-popover p-4 shadow-control transition-[border-color,box-shadow,transform] duration-150 ease-out hover:border-primary/20 hover:shadow-control-hover motion-reduce:transition-none"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
          <ProviderIcon
            providerId={provider.id}
            providerLabel={provider.label}
            className="size-5"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Text as="h3" variant="strong" truncate>
              {provider.label}
            </Text>
            <Badge color={status.color}>{status.label}</Badge>
            {inRoute ? <Badge color="blue">In route</Badge> : null}
          </div>
          <Text as="p" variant="small" color="secondary" className="mt-1 leading-relaxed">
            {provider.description}
          </Text>
        </div>
      </div>

      <dl className="grid gap-1.5 border-t border-separator pt-3 text-small">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-tertiary">Cost</dt>
          <dd className="text-right text-secondary">{COST_LABELS[provider.costClass]}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-tertiary">Setup</dt>
          <dd className="text-right text-secondary">
            {CREDENTIAL_LABELS[provider.credentialKind]}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-tertiary">Data recipient</dt>
          <dd className="min-w-0 truncate text-right text-secondary">{provider.label}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
        <a
          href={provider.privacyUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-secondary underline decoration-primary/20 underline-offset-2 outline-none hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          Privacy <LinkIcon />
        </a>
        <a
          href={provider.termsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-secondary underline decoration-primary/20 underline-offset-2 outline-none hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          Terms <LinkIcon />
        </a>
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-separator pt-3">
        <Button
          variant="transparent"
          size="small"
          onClick={(event) => onConfigure(provider, event.currentTarget)}
        >
          {provider.configurationStatus === "configured" ? "Manage" : "Configure"}
        </Button>
        {fixedProviderId !== undefined ? (
          <Button
            variant={isFixed ? "muted" : "filled"}
            size="small"
            disabled={isFixed}
            aria-pressed={isFixed}
            onClick={() => onUseForSearch(provider)}
          >
            {isFixed ? "Fixed provider" : "Use for search"}
          </Button>
        ) : inRoute ? (
          <Button variant="muted" size="small" disabled aria-pressed="true">
            <Check className="size-4" />
            In route
          </Button>
        ) : (
          <Button variant="filled" size="small" onClick={() => onAddToRoute(provider)}>
            <Plus className="size-4" />
            Add to route
          </Button>
        )}
      </div>
    </article>
  );
}

function RouteEntryRow({
  entry,
  index,
  total,
  provider,
  readiness,
  onMove,
  onRemove,
}: {
  entry: WebSearchRouteEntry;
  index: number;
  total: number;
  provider: WebSearchProvider | undefined;
  readiness: WebSearchRendererSnapshot["routeReadiness"][number] | undefined;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
}) {
  const status = routeStatusLabel(provider, readiness);
  const providerLabel = provider?.label ?? "Unavailable provider";
  return (
    <li
      data-web-search-route-entry
      data-provider-id={entry.providerId}
      tabIndex={0}
      aria-posinset={index + 1}
      aria-setsize={total}
      onKeyDown={(event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        onMove(index, event.key === "ArrowUp" ? -1 : 1);
      }}
      className="group flex min-w-0 items-center gap-2 rounded-control border border-separator bg-popover px-2.5 py-2 outline-none transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:bg-list-hover focus-visible:border-focus-ring focus-visible:bg-input focus-visible:shadow-control motion-reduce:transition-none"
    >
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-pill bg-well text-small-strong text-tertiary"
      >
        {index + 1}
      </span>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
        <ProviderIcon
          providerId={provider?.id ?? "unavailable"}
          providerLabel={providerLabel}
          className="size-4"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Text as="span" variant="small-strong" truncate>
            {providerLabel}
          </Text>
          <Badge color={status.color}>{status.label}</Badge>
        </span>
        <Text as="span" variant="small" color="tertiary" className="mt-0.5 block truncate">
          {CREDENTIAL_MODE_LABELS[entry.credentialMode]}
        </Text>
      </span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-75 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
        <Button
          iconOnly
          size="small"
          variant="transparent"
          className="size-7"
          disabled={index === 0}
          aria-label={`Move ${providerLabel} up`}
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
          disabled={index === total - 1}
          aria-label={`Move ${providerLabel} down`}
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
          disabled={total === 1}
          aria-label={`Remove ${providerLabel} from automatic route`}
          title={total === 1 ? "At least one destination is required" : "Remove from route"}
          onClick={() => onRemove(index)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

function ProviderSetupDialog({
  provider,
  snapshot,
  open,
  onOpenChange,
  onSnapshot,
  returnFocus,
  onApplyRouteMode,
}: {
  provider: WebSearchProvider;
  snapshot: WebSearchRendererSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnapshot: (snapshot: WebSearchRendererSnapshot) => void;
  returnFocus: () => HTMLElement | null;
  onApplyRouteMode: (
    providerId: WebSearchProviderId,
    credentialMode: CredentialMode,
  ) => Promise<WebSearchRendererSnapshot | undefined>;
}) {
  const routeEntry = routeEntryFor(snapshot, provider.id);
  const [keyDraft, setKeyDraft] = React.useState("");
  const [endpointDraft, setEndpointDraft] = React.useState(
    () => snapshot.settings.providerConfig[provider.id]?.endpoint ?? "",
  );
  const [zoneDraft, setZoneDraft] = React.useState(
    () => snapshot.settings.providerConfig[provider.id]?.zone ?? "",
  );
  const [routeMode, setRouteMode] = React.useState<CredentialMode>(
    routeEntry?.credentialMode ?? defaultCredentialMode(provider),
  );
  const [busy, setBusy] = React.useState<"credential" | "config" | "route" | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const hasCredential =
    providerNeedsApiKey(provider) && provider.configurationStatus === "configured";
  const hasConfigFields = providerNeedsEndpoint(provider) || providerNeedsZone(provider);
  const configValid =
    (!providerNeedsEndpoint(provider) || endpointDraft.trim().length > 0) &&
    (!providerNeedsZone(provider) || zoneDraft.trim().length > 0);

  const saveConfig = async () => {
    if (!hasConfigFields || !configValid || busy) return;
    setBusy("config");
    setMessage(null);
    setError(null);
    try {
      const nextConfig: BoundedNonSecretProviderConfig = {};
      if (providerNeedsEndpoint(provider)) nextConfig.endpoint = endpointDraft.trim();
      if (providerNeedsZone(provider)) nextConfig.zone = zoneDraft.trim();
      const next = await webSearchApi.setProviderConfig(provider.id, nextConfig);
      onSnapshot(next);
      setMessage("Provider settings saved. Setup does not send a test request.");
    } catch (caught) {
      setError(errorMessage(caught, "Couldn’t save provider settings."));
    } finally {
      setBusy(null);
    }
  };

  const saveCredential = async () => {
    const value = keyDraft.trim();
    if (!value || !providerNeedsApiKey(provider) || busy) return;
    setBusy("credential");
    setMessage(null);
    setError(null);
    try {
      const next = await webSearchApi.setCredential(provider.id, value);
      onSnapshot(next);
      setKeyDraft("");
      setMessage("API key saved. This does not select the provider or send a test request.");
    } catch (caught) {
      setError(errorMessage(caught, "Couldn’t save the API key."));
    } finally {
      setBusy(null);
    }
  };

  const removeCredential = async () => {
    if (!hasCredential || busy) return;
    setBusy("credential");
    setMessage(null);
    setError(null);
    try {
      const next = await webSearchApi.removeCredential(provider.id);
      onSnapshot(next);
      setKeyDraft("");
      setMessage(
        "API key removed. The provider’s route membership and Web Search switch are unchanged.",
      );
    } catch (caught) {
      setError(errorMessage(caught, "Couldn’t remove the API key."));
    } finally {
      setBusy(null);
    }
  };

  const applyRouteMode = async () => {
    if (busy) return;
    setBusy("route");
    setMessage(null);
    setError(null);
    try {
      const next = await onApplyRouteMode(provider.id, routeMode);
      if (next) setMessage("Route mode updated. Saving credentials never changes this choice.");
    } catch (caught) {
      setError(errorMessage(caught, "Couldn’t update the route mode."));
    } finally {
      setBusy(null);
    }
  };

  const routeModeDescription =
    routeMode === "anonymous"
      ? "Uses the provider’s free or anonymous route when available."
      : "Uses the saved credential for this provider. Saving a key alone never activates this mode.";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      title={`Set up ${provider.label}`}
      description="Review what leaves this Mac, then save only the provider details you choose. Setup performs no network request."
      size="large"
      confirmLabel={busy === "config" ? "Saving…" : "Save provider settings"}
      confirmHidden={!hasConfigFields}
      confirmDisabled={!configValid || Boolean(busy)}
      busy={Boolean(busy)}
      onConfirm={() => void saveConfig()}
    >
      <div className="grid gap-4">
        <section
          className="rounded-card bg-well p-3.5"
          aria-labelledby="web-search-provider-details"
        >
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-control bg-popover text-secondary">
              <ProviderIcon
                providerId={provider.id}
                providerLabel={provider.label}
                className="size-4.5"
              />
            </div>
            <div className="min-w-0">
              <Text id="web-search-provider-details" variant="small-strong">
                {provider.label}
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-1 leading-relaxed">
                {provider.description}
              </Text>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge color={providerStatus(provider).color}>
                  {COST_LABELS[provider.costClass]}
                </Badge>
                <Badge>{CREDENTIAL_LABELS[provider.credentialKind]}</Badge>
                {provider.ready ? <Badge color="green">Ready</Badge> : <Badge>Not ready</Badge>}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-separator pt-3 text-small">
            <span className="inline-flex items-center gap-1.5 text-secondary">
              <ShieldCheck aria-hidden="true" className="size-3.5 text-tertiary" />
              Queries go to {provider.label}
            </span>
            <a
              href={provider.privacyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-secondary underline decoration-primary/20 underline-offset-2 outline-none hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Privacy <LinkIcon />
            </a>
            <a
              href={provider.termsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-secondary underline decoration-primary/20 underline-offset-2 outline-none hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Terms <LinkIcon />
            </a>
          </div>
        </section>

        {provider.credentialKind === "optional-api-key" ? (
          <Field
            label="Route mode"
            description={`${routeModeDescription} Route membership is a separate choice from credential saving.`}
            orientation="vertical"
          >
            <RadioGroup
              value={routeMode}
              onValueChange={(value) => setRouteMode(value as CredentialMode)}
              aria-label={`${provider.label} route mode`}
              className="grid gap-2"
            >
              <label
                htmlFor={`web-search-${provider.id}-anonymous`}
                className="flex cursor-default items-start gap-2.5 rounded-control border border-separator bg-well px-3 py-2.5 transition-[background-color,border-color] duration-150 hover:bg-list-hover has-[[data-state=checked]]:border-accent has-[[data-state=checked]]:bg-accent/5 motion-reduce:transition-none"
              >
                <RadioGroupItem
                  id={`web-search-${provider.id}-anonymous`}
                  value="anonymous"
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0">
                  <Text as="span" variant="small-strong" className="block">
                    Built-in free route
                  </Text>
                  <Text as="span" variant="small" color="secondary" className="mt-0.5 block">
                    Use anonymous access where this provider supports it; provider rate limits may
                    apply.
                  </Text>
                </span>
              </label>
              <label
                htmlFor={`web-search-${provider.id}-api-key`}
                className="flex cursor-default items-start gap-2.5 rounded-control border border-separator bg-well px-3 py-2.5 transition-[background-color,border-color] duration-150 hover:bg-list-hover has-[[data-state=checked]]:border-accent has-[[data-state=checked]]:bg-accent/5 motion-reduce:transition-none"
              >
                <RadioGroupItem
                  id={`web-search-${provider.id}-api-key`}
                  value="api-key"
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0">
                  <Text as="span" variant="small-strong" className="block">
                    Use my API key
                  </Text>
                  <Text as="span" variant="small" color="secondary" className="mt-0.5 block">
                    Use your saved key for this route; your key remains encrypted on this device.
                  </Text>
                </span>
              </label>
            </RadioGroup>
            <Button
              variant="transparent"
              size="small"
              className="mt-2 justify-self-start"
              disabled={!routeEntry || Boolean(busy)}
              onClick={() => void applyRouteMode()}
            >
              Apply mode to current route
            </Button>
            {!routeEntry ? (
              <Text variant="small" color="tertiary">
                Add this provider to the route before applying a mode.
              </Text>
            ) : null}
          </Field>
        ) : null}

        {providerNeedsApiKey(provider) ? (
          <Field
            label={provider.credentialKind === "optional-api-key" ? "Optional API key" : "API key"}
            description={
              hasCredential
                ? "A key is saved. Enter a new value to replace it, or remove it below. Keys are write-only."
                : "Stored encrypted on this device. Saving does not select the provider or verify the key."
            }
            orientation="vertical"
          >
            <Input
              type="password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder={
                hasCredential
                  ? "Enter a new API key to replace the saved key"
                  : "Paste your API key"
              }
              autoComplete="new-password"
              spellCheck={false}
              aria-label={`${provider.label} API key`}
              disabled={Boolean(busy)}
              className="h-10 w-full"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                variant="accent"
                size="small"
                disabled={!keyDraft.trim() || Boolean(busy)}
                onClick={() => void saveCredential()}
              >
                <KeyRound className="size-3.5" />
                {hasCredential ? "Replace key" : "Save key"}
              </Button>
              <Button
                variant="transparent"
                size="small"
                disabled={!hasCredential || Boolean(busy)}
                onClick={() => void removeCredential()}
              >
                <Trash2 className="size-3.5" />
                Remove saved key
              </Button>
            </div>
          </Field>
        ) : null}

        {providerNeedsEndpoint(provider) ? (
          <Field
            label="Provider endpoint"
            description="Non-secret endpoint configuration is stored locally. Aiden accepts only the reviewed endpoint shape for this provider."
            orientation="vertical"
          >
            <Input
              value={endpointDraft}
              onChange={(event) => setEndpointDraft(event.target.value)}
              placeholder="https://search.example"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${provider.label} endpoint`}
              disabled={Boolean(busy)}
              className="h-10 w-full"
            />
          </Field>
        ) : null}

        {providerNeedsZone(provider) ? (
          <Field
            label="SERP zone"
            description="The zone is non-secret provider configuration. Keep billing and quota implications in mind before adding this destination to an automatic route."
            orientation="vertical"
          >
            <Input
              value={zoneDraft}
              onChange={(event) => setZoneDraft(event.target.value)}
              placeholder="serp_api"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${provider.label} zone`}
              disabled={Boolean(busy)}
              className="h-10 w-full"
            />
          </Field>
        ) : null}

        {provider.credentialKind === "none" ? (
          <Callout>
            <Text variant="small-strong">No credential required</Text>
            <Text as="p" variant="small" color="secondary">
              This provider is anonymous. Add it to an explicit route before it can receive a query.
            </Text>
          </Callout>
        ) : null}

        {provider.credentialKind === "existing-provider-auth" ? (
          <Callout>
            <Text variant="small-strong">Existing account setup</Text>
            <Text as="p" variant="small" color="secondary">
              This release does not silently reuse an inference-provider login. Any account binding
              must be explicit and provider-scoped.
            </Text>
          </Callout>
        ) : null}

        {error ? (
          <Callout color="red" role="alert" aria-live="assertive">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red" />
              <Text variant="small" color="red">
                {error}
              </Text>
            </div>
          </Callout>
        ) : null}
        {message ? (
          <Text role="status" aria-live="polite" variant="small" color="secondary" className="px-1">
            {message}
          </Text>
        ) : null}
      </div>
    </Dialog>
  );
}

function SettingsSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-5">
      <div className="h-28 animate-pulse rounded-card bg-well motion-reduce:animate-none" />
      <div className="h-48 animate-pulse rounded-card bg-well motion-reduce:animate-none" />
      <Text variant="small" color="tertiary" className="text-center">
        Loading local Web Search settings…
      </Text>
    </div>
  );
}

export function WebSearchSettings() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const webSearch = useWebSearch();
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<WebSearchFilter>("all");
  const [showMoreProviders, setShowMoreProviders] = React.useState(false);
  const [editingProvider, setEditingProvider] = React.useState<WebSearchProvider | null>(null);
  const setupTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const [mutation, setMutation] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const snapshot = webSearch.data;
  const applySnapshot = React.useCallback(
    (next: WebSearchRendererSnapshot) => {
      queryClient.setQueryData(queryKeys.webSearch, next);
    },
    [queryClient],
  );

  const performMutation = React.useCallback(
    async (
      name: string,
      action: () => Promise<WebSearchRendererSnapshot>,
      success?: string,
    ): Promise<WebSearchRendererSnapshot | undefined> => {
      const focusTarget =
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setMutation(name);
      setError(null);
      setNotice(null);
      try {
        const next = await action();
        applySnapshot(next);
        if (success) setNotice(success);
        return next;
      } catch (caught) {
        setError(errorMessage(caught, "Couldn’t save Web Search settings."));
        if (focusTarget?.isConnected) requestAnimationFrame(() => focusTarget.focus());
        return undefined;
      } finally {
        setMutation(null);
      }
    },
    [applySnapshot],
  );

  if (webSearch.isPending && !snapshot) return <SettingsSkeleton />;

  if (webSearch.isError && !snapshot) {
    return (
      <Callout color="red" role="alert">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red" />
          <div className="min-w-0 flex-1">
            <Text variant="small-strong">Web Search settings are unavailable</Text>
            <Text as="p" variant="small" color="secondary" className="mt-1">
              Aiden could not read the device-local provider catalog. No provider was contacted.
            </Text>
            <Button
              variant="transparent"
              size="small"
              className="mt-2"
              onClick={() => void webSearch.refetch()}
            >
              <RefreshCw className="size-3.5" />
              Try again
            </Button>
          </div>
        </div>
      </Callout>
    );
  }

  if (!snapshot) return <EmptyState title="Web Search is not configured" placement="inline" />;

  const shippedProviders = snapshot.providers.filter(
    (provider) => provider.releaseState === "shipped",
  );
  const currentSelection = snapshot.selection;
  const fixedProviderId =
    currentSelection.mode === "fixed" ? currentSelection.providerId : undefined;
  const activeRoute = snapshot.route;
  const searchQuery = search.trim().toLocaleLowerCase();
  const filtering = Boolean(searchQuery) || filter !== "all";
  const filteredProviders = shippedProviders.filter(
    (provider) =>
      providerMatchesSearch(provider, searchQuery) && providerMatchesFilter(provider, filter),
  );
  const builtinProviders = filteredProviders.filter(
    (provider) => provider.automaticByDefault || provider.costClass === "built-in-free",
  );
  const connectedProviders = filteredProviders.filter(
    (provider) =>
      !provider.automaticByDefault &&
      provider.costClass !== "built-in-free" &&
      provider.configurationStatus === "configured",
  );
  const moreProviders = filteredProviders.filter(
    (provider) => !builtinProviders.includes(provider) && !connectedProviders.includes(provider),
  );
  const visibleMoreProviders = filtering || showMoreProviders ? moreProviders : [];
  const editing = editingProvider
    ? (snapshot.providers.find((provider) => provider.id === editingProvider.id) ?? editingProvider)
    : null;
  const fixedProvider = shippedProviders.find((provider) => provider.id === fixedProviderId);
  const selectedFixedRoute = currentSelection.mode === "fixed" ? activeRoute[0] : undefined;
  const selectedReadiness =
    currentSelection.mode === "fixed"
      ? snapshot.routeReadiness.find((entry) => entry.providerId === currentSelection.providerId)
      : undefined;
  const selectedFixedStatus = routeStatusLabel(fixedProvider, selectedReadiness);
  const selectedFixedCredentialMode: CredentialMode =
    selectedFixedRoute?.credentialMode ??
    (fixedProvider ? defaultCredentialMode(fixedProvider) : "anonymous");
  const routeReadyCount = activeRoute.filter((entry) => {
    const provider = shippedProviders.find((candidate) => candidate.id === entry.providerId);
    return (
      provider !== undefined &&
      snapshot.routeReadiness.find((candidate) => candidate.providerId === entry.providerId)?.ready
    );
  }).length;

  const openSetup = (provider: WebSearchProvider, trigger: HTMLButtonElement) => {
    setupTriggerRef.current = trigger;
    setEditingProvider(provider);
  };

  const setEnabled = (enabled: boolean) => {
    void performMutation(
      "enabled",
      () => webSearchApi.setEnabled(enabled),
      enabled
        ? "Web Search is on. No request is made until an eligible chat uses search."
        : "Web Search is off. Your route and credentials are preserved.",
    );
  };

  const setAutomatic = () => {
    const route =
      currentSelection.mode === "automatic"
        ? currentSelection.route
        : activeRoute.length > 0
          ? activeRoute
          : (() => {
              const defaultProvider =
                shippedProviders.find((provider) => provider.automaticByDefault) ??
                shippedProviders[0];
              return defaultProvider
                ? [
                    {
                      providerId: defaultProvider.id,
                      credentialMode: defaultCredentialMode(defaultProvider),
                    },
                  ]
                : [];
            })();
    if (route.length === 0) return;
    void performMutation(
      "selection",
      () =>
        webSearchApi.setSelection({
          mode: "automatic",
          route: [...route],
          fallbackOn:
            currentSelection.mode === "automatic"
              ? [...currentSelection.fallbackOn]
              : [...DEFAULT_FALLBACK_ON],
        }),
      "Automatic routing selected. Aiden will try only the destinations listed below, in order.",
    );
  };

  const setFixedProvider = (providerId: WebSearchProviderId) => {
    const provider = shippedProviders.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const existing = routeEntryFor(snapshot, providerId);
    void performMutation(
      "selection",
      () =>
        webSearchApi.setSelection({
          mode: "fixed",
          providerId,
          credentialMode: existing?.credentialMode ?? defaultCredentialMode(provider),
        }),
      `Fixed provider set to ${provider.label}. Fixed mode never falls back.`,
    );
  };

  const setRouteCredentialMode = async (
    providerId: WebSearchProviderId,
    credentialMode: CredentialMode,
  ): Promise<WebSearchRendererSnapshot | undefined> => {
    if (currentSelection.mode === "fixed" && currentSelection.providerId === providerId) {
      return performMutation("route", () =>
        webSearchApi.setSelection({ ...currentSelection, credentialMode }),
      );
    }
    if (currentSelection.mode !== "automatic") return undefined;
    const route = currentSelection.route.map((entry) =>
      entry.providerId === providerId ? { ...entry, credentialMode } : entry,
    );
    if (!route.some((entry) => entry.providerId === providerId)) return undefined;
    return performMutation("route", () => webSearchApi.setAutomaticRoute(route));
  };

  const addToRoute = (provider: WebSearchProvider, requestedMode?: CredentialMode) => {
    const route = activeRoute.some((entry) => entry.providerId === provider.id)
      ? activeRoute
      : [
          ...activeRoute,
          {
            providerId: provider.id,
            credentialMode: requestedMode ?? defaultCredentialMode(provider),
          },
        ];
    void performMutation(
      "route",
      () => webSearchApi.setAutomaticRoute([...route]),
      `${provider.label} added to the automatic route.`,
    );
  };

  const moveRouteEntry = (index: number, direction: -1 | 1) => {
    if (currentSelection.mode !== "automatic") return;
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= activeRoute.length) return;
    const route = [...activeRoute];
    const [entry] = route.splice(index, 1);
    route.splice(nextIndex, 0, entry);
    void performMutation("route", () => webSearchApi.setAutomaticRoute(route));
  };

  const removeRouteEntry = (index: number) => {
    if (currentSelection.mode !== "automatic" || activeRoute.length <= 1) return;
    const provider = snapshot.providers.find(
      (candidate) =>
        candidate.id === activeRoute[index]?.providerId && candidate.releaseState === "shipped",
    );
    const route = activeRoute.filter((_entry, entryIndex) => entryIndex !== index);
    void performMutation(
      "route",
      () => webSearchApi.setAutomaticRoute(route),
      `${provider?.label ?? "Provider"} removed from the automatic route.`,
    );
  };

  const routeProviderOptions = shippedProviders.filter(
    (provider) => !activeRoute.some((entry) => entry.providerId === provider.id),
  );

  return (
    <div className="flex flex-col gap-6 pb-8">
      <header className="flex items-start gap-4 px-1">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-card bg-accent/10 text-accent">
          <Globe2 aria-hidden="true" className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Text as="h1" variant="heading1">
              Web Search
            </Text>
            <Badge color={snapshot.settings.enabled ? "green" : undefined}>
              {snapshot.settings.enabled ? "On" : "Off"}
            </Badge>
          </div>
          <Text
            as="p"
            variant="regular"
            color="secondary"
            className="mt-1 max-w-xl leading-relaxed"
          >
            Choose which reviewed service can search the web for an attended conversation. Provider,
            cost, privacy, and fallback decisions stay in Settings—not in the model prompt.
          </Text>
        </div>
      </header>

      <section className="overflow-hidden rounded-card border border-separator bg-popover shadow-control">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
            <Globe2 aria-hidden="true" className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Text variant="strong">Allow Web Search</Text>
              <Text variant="small" color="tertiary">
                {snapshot.settings.enabled
                  ? "Available in attended chats"
                  : "Unavailable until you turn it on"}
              </Text>
            </div>
            <Text
              as="p"
              variant="small"
              color="secondary"
              className="mt-1 max-w-xl leading-relaxed"
            >
              New profiles start on with Exa’s built-in free route. No background or startup
              searches occur; Aiden sends a derived query only when an eligible chat actually uses
              search.
            </Text>
          </div>
          <Switch
            checked={snapshot.settings.enabled}
            onCheckedChange={setEnabled}
            disabled={Boolean(mutation)}
            aria-label="Allow Web Search"
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-separator bg-well px-4 py-3">
          <Text variant="small-strong" color="secondary">
            Active route
          </Text>
          <Text variant="small" color="secondary">
            {routeSummary(snapshot)}
          </Text>
          <Badge color={routeReadyCount > 0 ? "green" : "red"}>
            {routeReadyCount}/{activeRoute.length} ready
          </Badge>
          {mutation ? (
            <Text role="status" aria-live="polite" variant="small" color="tertiary">
              Saving…
            </Text>
          ) : null}
        </div>
      </section>

      {error ? (
        <Callout color="red" role="alert" aria-live="assertive">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red" />
            <Text variant="small" color="red">
              {error}
            </Text>
            <Button
              variant="transparent"
              iconOnly
              size="small"
              className="ml-auto size-7"
              aria-label="Dismiss Web Search error"
              onClick={() => setError(null)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </Callout>
      ) : null}
      {notice ? (
        <Text role="status" aria-live="polite" variant="small" color="secondary" className="px-1">
          {notice}
        </Text>
      ) : null}

      <FieldSet title="Routing">
        <Field
          label="Choose a routing policy"
          description="Automatic follows your ordered route and may continue only for the disclosed fallback categories. Fixed uses exactly one provider and never falls back."
          orientation="vertical"
        >
          <RadioGroup
            value={currentSelection.mode}
            onValueChange={(value) => {
              if (value === "automatic") {
                setAutomatic();
              } else if (value === "fixed") {
                const nextProviderId = fixedProviderId ?? shippedProviders[0]?.id;
                if (nextProviderId) setFixedProvider(nextProviderId);
              }
            }}
            aria-label="Web Search routing policy"
            className="grid gap-2 min-[560px]:grid-cols-2"
          >
            <label
              htmlFor="web-search-routing-automatic"
              className="flex cursor-default items-start gap-2.5 rounded-control border border-separator bg-well px-3 py-3 transition-[background-color,border-color] duration-150 hover:bg-list-hover has-[[data-state=checked]]:border-accent has-[[data-state=checked]]:bg-accent/5 motion-reduce:transition-none"
            >
              <RadioGroupItem
                id="web-search-routing-automatic"
                value="automatic"
                className="mt-0.5 shrink-0"
              />
              <span className="min-w-0">
                <Text as="span" variant="small-strong" className="block">
                  Automatic
                </Text>
                <Text as="span" variant="small" color="secondary" className="mt-0.5 block">
                  Try listed destinations in order after an eligible failure.
                </Text>
              </span>
            </label>
            <label
              htmlFor="web-search-routing-fixed"
              className="flex cursor-default items-start gap-2.5 rounded-control border border-separator bg-well px-3 py-3 transition-[background-color,border-color] duration-150 hover:bg-list-hover has-[[data-state=checked]]:border-accent has-[[data-state=checked]]:bg-accent/5 motion-reduce:transition-none"
            >
              <RadioGroupItem
                id="web-search-routing-fixed"
                value="fixed"
                className="mt-0.5 shrink-0"
              />
              <span className="min-w-0">
                <Text as="span" variant="small-strong" className="block">
                  Fixed provider
                </Text>
                <Text as="span" variant="small" color="secondary" className="mt-0.5 block">
                  Send only to one destination; failures stay visible.
                </Text>
              </span>
            </label>
          </RadioGroup>
        </Field>

        {currentSelection.mode === "automatic" ? (
          <Field
            label="Ordered automatic route"
            description="Aiden never fans out. Each destination receives the query only if it is listed here and the previous failure is eligible for fallback."
            orientation="vertical"
          >
            <ol
              data-web-search-route-list
              aria-label="Ordered automatic Web Search route"
              className="grid gap-2"
            >
              {activeRoute.map((entry, index) => (
                <RouteEntryRow
                  key={entry.providerId}
                  entry={entry}
                  index={index}
                  total={activeRoute.length}
                  provider={snapshot.providers.find(
                    (candidate) =>
                      candidate.id === entry.providerId && candidate.releaseState === "shipped",
                  )}
                  readiness={snapshot.routeReadiness.find(
                    (candidate) => candidate.providerId === entry.providerId,
                  )}
                  onMove={moveRouteEntry}
                  onRemove={removeRouteEntry}
                />
              ))}
            </ol>
            <div className="mt-3 flex flex-col gap-2 min-[540px]:flex-row min-[540px]:items-center">
              <Select
                value=""
                onValueChange={(providerId) => {
                  const provider = shippedProviders.find(
                    (candidate) => candidate.id === providerId,
                  );
                  if (provider) addToRoute(provider);
                }}
                disabled={routeProviderOptions.length === 0 || Boolean(mutation)}
              >
                <SelectTrigger
                  aria-label="Add provider to automatic route"
                  className="min-[540px]:max-w-sm"
                >
                  <SelectValue placeholder="Add a provider to the route…" />
                </SelectTrigger>
                <SelectContent>
                  {routeProviderOptions.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.label} · {COST_LABELS[provider.costClass]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {routeProviderOptions.length === 0 ? (
                <Text variant="small" color="tertiary">
                  All shipped providers are already listed.
                </Text>
              ) : null}
            </div>
            <details className="mt-3 rounded-control bg-well px-3 py-2">
              <summary className="flex cursor-default list-none items-center gap-2 rounded-control text-small-strong text-secondary outline-none marker:hidden focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-focus-ring">
                <ChevronDown
                  aria-hidden="true"
                  className="size-3.5 transition-transform duration-150 open:rotate-180 motion-reduce:transition-none"
                />
                Fallback conditions
              </summary>
              <Text as="p" variant="small" color="secondary" className="mt-2 leading-relaxed">
                Automatic can continue after these categories. Authentication, invalid
                configuration, cancellation, and policy failures stop immediately.
              </Text>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {currentSelection.fallbackOn.map((kind) => (
                  <Badge key={kind}>{FALLBACK_LABELS[kind]}</Badge>
                ))}
              </div>
            </details>
          </Field>
        ) : (
          <Field
            label="Fixed provider"
            description="This destination receives every Web Search request while selected. Fixed mode never silently tries another provider."
            orientation="vertical"
          >
            <Select
              value={currentSelection.providerId}
              onValueChange={(providerId) => setFixedProvider(providerId as WebSearchProviderId)}
              disabled={Boolean(mutation)}
            >
              <SelectTrigger aria-label="Fixed Web Search provider">
                <SelectValue>{fixedProvider?.label ?? "Unavailable provider"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {shippedProviders.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label} · {COST_LABELS[provider.costClass]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Callout className="mt-3" aria-live="polite">
              <div className="flex items-start gap-2.5">
                {selectedFixedStatus.color === "red" ? (
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red" />
                ) : (
                  <Check className="mt-0.5 size-4 shrink-0 text-green" />
                )}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Text variant="small-strong">
                      {fixedProvider?.label ?? "Unavailable provider"}
                    </Text>
                    <Badge color={selectedFixedStatus.color}>{selectedFixedStatus.label}</Badge>
                  </div>
                  <Text as="p" variant="small" color="secondary" className="mt-1">
                    {selectedFixedStatus.color === "red"
                      ? "Finish provider setup or choose another shipped destination. Requests fail closed until this provider is ready."
                      : `Uses ${CREDENTIAL_MODE_LABELS[selectedFixedCredentialMode]}.`}
                  </Text>
                </div>
              </div>
            </Callout>
          </Field>
        )}
      </FieldSet>

      <FieldSet
        title={
          <span className="flex flex-wrap items-center gap-2">
            Provider catalog <Badge color="blue">{shippedProviders.length} shipped</Badge>
          </span>
        }
      >
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-2">
            <label className="flex h-10 items-center gap-2 rounded-control border border-field bg-input px-3 transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:border-primary/30 focus-within:border-focus-ring focus-within:bg-popover motion-reduce:transition-none">
              <Search aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSearch("");
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Search shipped providers…"
                aria-label="Search shipped Web Search providers"
                className="h-full min-w-0 flex-1 bg-transparent text-regular text-primary outline-none placeholder:text-secondary"
              />
              {search ? (
                <Button
                  iconOnly
                  size="small"
                  variant="transparent"
                  className="size-7"
                  aria-label="Clear provider search"
                  onClick={() => setSearch("")}
                >
                  <X className="size-3.5" />
                </Button>
              ) : null}
            </label>
            <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Filter providers">
              {FILTERS.map((option) => (
                <Button
                  key={option.id}
                  size="small"
                  variant={filter === option.id ? "muted" : "transparent"}
                  aria-pressed={filter === option.id}
                  className={
                    filter === option.id ? "bg-list-selection text-primary" : "text-secondary"
                  }
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <Text variant="small" color="tertiary" aria-live="polite">
              {filteredProviders.length} shipped provider{filteredProviders.length === 1 ? "" : "s"}{" "}
              · non-shipped and blocked providers are not shown
            </Text>
          </div>

          <div className="flex flex-col gap-5">
            <ProviderGroup
              title="Built in"
              providers={builtinProviders}
              route={activeRoute}
              fixedProviderId={
                currentSelection.mode === "fixed" ? currentSelection.providerId : undefined
              }
              onConfigure={openSetup}
              onAddToRoute={addToRoute}
              onUseForSearch={(provider) => setFixedProvider(provider.id)}
            />
            <ProviderGroup
              title="Connected"
              providers={connectedProviders}
              route={activeRoute}
              fixedProviderId={
                currentSelection.mode === "fixed" ? currentSelection.providerId : undefined
              }
              onConfigure={openSetup}
              onAddToRoute={addToRoute}
              onUseForSearch={(provider) => setFixedProvider(provider.id)}
            />
            <ProviderGroup
              title="More providers"
              providers={visibleMoreProviders}
              route={activeRoute}
              fixedProviderId={
                currentSelection.mode === "fixed" ? currentSelection.providerId : undefined
              }
              onConfigure={openSetup}
              onAddToRoute={addToRoute}
              onUseForSearch={(provider) => setFixedProvider(provider.id)}
            />
            {moreProviders.length > 0 && !filtering ? (
              <Button
                variant="transparent"
                className="self-start"
                aria-expanded={showMoreProviders}
                onClick={() => setShowMoreProviders((value) => !value)}
              >
                <ChevronDown
                  className={`size-4 transition-transform duration-150 motion-reduce:transition-none ${showMoreProviders ? "rotate-180" : ""}`}
                />
                {showMoreProviders ? "Show fewer providers" : "Show more providers"}
              </Button>
            ) : null}
            {filteredProviders.length === 0 ? (
              <EmptyState
                placement="inline"
                title="No shipped providers match"
                description="Try another search or filter. Aiden keeps planned and blocked providers out of the release catalog."
              />
            ) : null}
          </div>
        </div>
      </FieldSet>

      <section
        aria-labelledby="web-search-privacy"
        className="rounded-card border border-separator bg-well p-4"
      >
        <div className="flex items-start gap-3">
          <LockKeyhole aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-secondary" />
          <div className="min-w-0">
            <Text id="web-search-privacy" variant="strong">
              Privacy and authority
            </Text>
            <ul className="mt-2 grid gap-1.5 pl-4 text-small text-secondary marker:text-tertiary">
              <li>
                Aiden may derive a query from the conversation and send it to the selected provider
                only when search is used. Avoid private information.
              </li>
              <li>
                Automatic routing can send the same query sequentially to more than one listed
                destination after an eligible failure; it never fans out.
              </li>
              <li>
                Provider keys stay encrypted on this device and are never shown back, placed in
                URLs, or passed to the model. Search results are untrusted web evidence.
              </li>
              <li>
                Turning Web Search off preserves route order and credentials. Existing Bots and
                schedules need their own explicit Web Search grant.
              </li>
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="transparent"
                size="small"
                onClick={() => void navigate({ to: "/bots" })}
              >
                Manage Bot grants
              </Button>
              <Button
                variant="transparent"
                size="small"
                onClick={() => void navigate({ to: "/scheduled" })}
              >
                Manage schedule grants
              </Button>
            </div>
          </div>
        </div>
      </section>

      {editing ? (
        <ProviderSetupDialog
          provider={editing}
          snapshot={snapshot}
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditingProvider(null);
          }}
          onSnapshot={applySnapshot}
          returnFocus={() => setupTriggerRef.current}
          onApplyRouteMode={setRouteCredentialMode}
        />
      ) : null}
    </div>
  );
}
