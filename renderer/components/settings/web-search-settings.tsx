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
  ChevronLeft,
  ChevronRight,
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
  InlineMetadata,
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
import { useAppCapabilities } from "../../lib/app-capabilities";

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
type WebSearchSettingsView = "overview" | "providers";

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

function ProviderOptionLabel({ provider }: { provider: WebSearchProvider }) {
  const isUsagePriced = provider.costClass === "quota" || provider.costClass === "paid";

  return (
    <>
      {provider.label}{" "}
      {isUsagePriced ? (
        <InlineMetadata>· {COST_LABELS[provider.costClass]}</InlineMetadata>
      ) : (
        <span>· {COST_LABELS[provider.costClass]}</span>
      )}
    </>
  );
}

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

const OPENAI_EXISTING_AUTH_CONSENT_COPY =
  "Allow Web Search to use the saved OpenAI API key. Searches use your OpenAI API quota and billing; the key stays encrypted on this device and is never copied into Web Search settings.";

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

function ProviderListGroup({
  id,
  title,
  providers,
  route,
  fixedProviderId,
  onSelect,
}: {
  id?: string;
  title: string;
  providers: readonly WebSearchProvider[];
  route: readonly WebSearchRouteEntry[];
  fixedProviderId?: WebSearchProviderId;
  onSelect: (provider: WebSearchProvider, trigger: HTMLButtonElement) => void;
}) {
  if (providers.length === 0) return id ? <div id={id} hidden /> : null;
  const headingId = `web-search-group-${title.toLocaleLowerCase().replace(/ /g, "-")}`;
  return (
    <section id={id} aria-labelledby={headingId}>
      <div className="mb-2 flex items-center gap-2 px-1">
        <Text id={headingId} variant="small-strong" color="secondary">
          {title}
        </Text>
        <Badge>{providers.length}</Badge>
      </div>
      <div className="overflow-hidden rounded-card border border-separator bg-popover shadow-control">
        {providers.map((provider) => (
          <ProviderListRow
            key={provider.id}
            provider={provider}
            route={route}
            fixedProviderId={fixedProviderId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderListRow({
  provider,
  route,
  fixedProviderId,
  onSelect,
}: {
  provider: WebSearchProvider;
  route: readonly WebSearchRouteEntry[];
  fixedProviderId?: WebSearchProviderId;
  onSelect: (provider: WebSearchProvider, trigger: HTMLButtonElement) => void;
}) {
  const inRoute = route.some((entry) => entry.providerId === provider.id);
  const isFixed = fixedProviderId === provider.id;
  const status = providerStatus(provider);
  const connection =
    provider.costClass === "built-in-free"
      ? "Built in"
      : provider.configurationStatus === "configured"
        ? "Connected"
        : "Setup required";
  return (
    <button
      type="button"
      data-web-search-provider-row
      data-provider-id={provider.id}
      onClick={(event) => onSelect(provider, event.currentTarget)}
      className="group flex w-full min-w-0 items-center gap-3 border-b border-separator px-3.5 py-3 text-left outline-none transition-colors duration-150 last:border-b-0 hover:bg-list-hover focus-visible:bg-list-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring motion-reduce:transition-none"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
        <ProviderIcon
          providerId={provider.id}
          providerLabel={provider.label}
          className="size-4.5"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Text as="span" variant="small-strong" truncate>
            {provider.label}
          </Text>
          {isFixed ? <Badge color="blue">Active</Badge> : inRoute ? <Badge>In route</Badge> : null}
        </span>
        <Text as="span" variant="small" color="secondary" className="mt-0.5 block truncate">
          {connection} · {COST_LABELS[provider.costClass]}
        </Text>
      </span>
      <Badge color={status.color}>{status.label}</Badge>
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-tertiary transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
      />
    </button>
  );
}

function ProviderCard({
  provider,
  route,
  fixedProviderId,
  onConfigure,
  onAddToRoute,
  onUseForSearch,
  disabled,
}: {
  provider: WebSearchProvider;
  route: readonly WebSearchRouteEntry[];
  fixedProviderId?: WebSearchProviderId;
  onConfigure: (provider: WebSearchProvider, trigger: HTMLButtonElement) => void;
  onAddToRoute: (provider: WebSearchProvider) => void;
  onUseForSearch: (provider: WebSearchProvider) => void;
  disabled?: boolean;
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
          disabled={disabled}
          onClick={(event) => onConfigure(provider, event.currentTarget)}
        >
          {provider.configurationStatus === "configured" ? "Manage" : "Configure"}
        </Button>
        {fixedProviderId !== undefined ? (
          <Button
            variant={isFixed ? "muted" : "filled"}
            size="small"
            disabled={isFixed || disabled}
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
          <Button
            variant="filled"
            size="small"
            disabled={disabled}
            onClick={() => onAddToRoute(provider)}
          >
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
  disabled,
}: {
  entry: WebSearchRouteEntry;
  index: number;
  total: number;
  provider: WebSearchProvider | undefined;
  readiness: WebSearchRendererSnapshot["routeReadiness"][number] | undefined;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
  disabled?: boolean;
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
        if (disabled) return;
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
          disabled={disabled || index === 0}
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
          disabled={disabled || index === total - 1}
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
          disabled={disabled || total === 1}
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
}: {
  provider: WebSearchProvider;
  snapshot: WebSearchRendererSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnapshot: (snapshot: WebSearchRendererSnapshot) => void;
  returnFocus: () => HTMLElement | null;
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
  const [busy, setBusy] = React.useState<"credential" | "config" | "existing-auth" | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const hasCredential =
    providerNeedsApiKey(provider) && provider.configuredCredentialModes.includes("api-key");
  const supportsExistingAuth =
    provider.id === "openai" && provider.capabilities.includes("existing-provider-auth");
  const existingAuthOption = supportsExistingAuth
    ? snapshot.existingAuth.options.find((option) => option.sourceProviderId === "openai")
    : undefined;
  const existingAuthStatus = snapshot.existingAuth.status;
  const existingAuthReady =
    supportsExistingAuth &&
    existingAuthStatus.state === "ready" &&
    existingAuthStatus.sourceProviderId === "openai";
  const existingAuthAvailable =
    existingAuthOption?.available === true && existingAuthOption.models.length > 0;
  const [existingAuthModelId, setExistingAuthModelId] = React.useState(
    () => existingAuthStatus.modelId ?? existingAuthOption?.models[0]?.id ?? "",
  );
  const existingAuthSync = React.useRef<{
    option: typeof existingAuthOption;
    modelId?: string;
  }>({ option: undefined });
  React.useEffect(() => {
    const optionChanged = existingAuthSync.current.option !== existingAuthOption;
    const statusChanged = existingAuthSync.current.modelId !== existingAuthStatus.modelId;
    if (optionChanged || statusChanged) {
      const statusModelIsAvailable = existingAuthStatus.modelId
        ? existingAuthOption?.models.some((model) => model.id === existingAuthStatus.modelId)
        : false;
      setExistingAuthModelId(
        statusModelIsAvailable
          ? (existingAuthStatus.modelId ?? "")
          : (existingAuthOption?.models[0]?.id ?? ""),
      );
    }
    existingAuthSync.current = {
      option: existingAuthOption,
      modelId: existingAuthStatus.modelId,
    };
  }, [existingAuthOption, existingAuthStatus.modelId]);
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

  const consentExistingAuth = async () => {
    if (!supportsExistingAuth || !existingAuthAvailable || !existingAuthModelId || busy) {
      return;
    }
    setBusy("existing-auth");
    setMessage(null);
    setError(null);
    try {
      const next = await webSearchApi.consentExistingAuth({
        targetProviderId: "openai",
        sourceProviderId: "openai",
        modelId: existingAuthModelId,
        consent: true,
      });
      onSnapshot(next);
      setMessage("OpenAI account approved for Web Search. Route selection is unchanged.");
    } catch (caught) {
      setError(errorMessage(caught, "Couldn’t approve the saved OpenAI account."));
    } finally {
      setBusy(null);
    }
  };

  const revokeExistingAuth = async () => {
    if (!supportsExistingAuth || !existingAuthReady || busy) return;
    setBusy("existing-auth");
    setMessage(null);
    setError(null);
    try {
      const next = await webSearchApi.revokeExistingAuth();
      onSnapshot(next);
      setMessage(
        "OpenAI account approval revoked. The saved provider credential and route are unchanged.",
      );
    } catch (caught) {
      setError(errorMessage(caught, "Couldn’t revoke the saved OpenAI account."));
    } finally {
      setBusy(null);
    }
  };

  const routeModeDescription =
    routeMode === "anonymous"
      ? "No credential is needed for this provider’s free or anonymous connection."
      : routeMode === "existing-provider-auth"
        ? "Approve the saved OpenAI account below. Approval never changes the active route."
        : "Save a provider-specific API key below. Saving it never activates or selects this provider.";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      title={`Set up ${provider.label}`}
      description="Review what leaves this device, then save only the provider details you choose. Setup performs no network request."
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

        {provider.credentialKind === "optional-api-key" || supportsExistingAuth ? (
          <Field
            label="Connection method"
            description={routeModeDescription}
            orientation="vertical"
          >
            <RadioGroup
              value={routeMode}
              onValueChange={(value) => setRouteMode(value as CredentialMode)}
              aria-label={`${provider.label} connection method`}
              className="grid gap-2"
            >
              {provider.credentialKind === "optional-api-key" ? (
                <label
                  htmlFor={`web-search-${provider.id}-anonymous`}
                  className="flex cursor-default items-start gap-2.5 rounded-control bg-well px-3 py-2.5 transition-colors duration-150 hover:bg-list-hover has-[[data-state=checked]]:bg-accent/5 motion-reduce:transition-none"
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
              ) : null}
              {provider.credentialKind === "optional-api-key" || providerNeedsApiKey(provider) ? (
                <label
                  htmlFor={`web-search-${provider.id}-api-key`}
                  className="flex cursor-default items-start gap-2.5 rounded-control bg-well px-3 py-2.5 transition-colors duration-150 hover:bg-list-hover has-[[data-state=checked]]:bg-accent/5 motion-reduce:transition-none"
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
                      Store a provider-specific key encrypted on this device.
                    </Text>
                  </span>
                </label>
              ) : null}
              {supportsExistingAuth ? (
                <label
                  htmlFor={`web-search-${provider.id}-existing-auth`}
                  className="flex cursor-default items-start gap-2.5 rounded-control bg-well px-3 py-2.5 transition-[background-color,opacity] duration-150 hover:bg-list-hover has-[[data-state=checked]]:bg-accent/5 motion-reduce:transition-none"
                >
                  <RadioGroupItem
                    id={`web-search-${provider.id}-existing-auth`}
                    value="existing-provider-auth"
                    disabled={!existingAuthAvailable}
                    className="mt-0.5 shrink-0"
                  />
                  <span className="min-w-0">
                    <Text as="span" variant="small-strong" className="block">
                      Use approved OpenAI account
                    </Text>
                    <Text as="span" variant="small" color="secondary" className="mt-0.5 block">
                      Approve the saved account below; OpenAI quota and billing apply.
                    </Text>
                  </span>
                </label>
              ) : null}
            </RadioGroup>
          </Field>
        ) : null}

        {providerNeedsApiKey(provider) &&
        (!supportsExistingAuth || routeMode === "api-key") &&
        (provider.credentialKind !== "optional-api-key" || routeMode === "api-key") ? (
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

        {supportsExistingAuth && (routeMode === "existing-provider-auth" || existingAuthReady) ? (
          <Field
            label="Saved OpenAI account"
            description="Approval is provider-scoped and separate from route selection. It reads local encrypted state only; it does not send a request."
            orientation="vertical"
          >
            <Callout>
              <div className="flex items-start gap-2.5">
                <LockKeyhole className="mt-0.5 size-4 shrink-0 text-tertiary" />
                <div className="min-w-0">
                  <Text variant="small-strong">
                    {existingAuthReady ? "OpenAI account approved" : "Approve this saved account"}
                  </Text>
                  <Text as="p" variant="small" color="secondary" className="mt-1 leading-relaxed">
                    {OPENAI_EXISTING_AUTH_CONSENT_COPY}
                  </Text>
                </div>
              </div>
              {existingAuthAvailable ? (
                <div className="mt-3 flex flex-col gap-2 min-[540px]:flex-row min-[540px]:items-center">
                  <Select
                    value={existingAuthModelId}
                    onValueChange={setExistingAuthModelId}
                    disabled={Boolean(busy)}
                  >
                    <SelectTrigger
                      size="small"
                      aria-label="OpenAI Web Search model"
                      className="min-[540px]:max-w-sm"
                    >
                      <SelectValue placeholder="Choose a Web Search model" />
                    </SelectTrigger>
                    <SelectContent>
                      {existingAuthOption?.models.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="accent"
                    size="small"
                    disabled={!existingAuthModelId || Boolean(busy)}
                    onClick={() => void consentExistingAuth()}
                  >
                    <ShieldCheck className="size-3.5" />
                    {existingAuthReady ? "Approve again" : "Approve for Web Search"}
                  </Button>
                </div>
              ) : (
                <Text as="p" variant="small" color="tertiary" className="mt-2">
                  No saved OpenAI API key is available to approve. Configure OpenAI in Provider
                  Settings first; this panel will not contact OpenAI to check.
                </Text>
              )}
              {existingAuthReady ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge color="green">Approved</Badge>
                  <Text variant="small" color="secondary">
                    Model: {existingAuthStatus.modelId}
                  </Text>
                  <Button
                    variant="transparent"
                    size="small"
                    disabled={Boolean(busy)}
                    onClick={() => void revokeExistingAuth()}
                  >
                    Revoke approval
                  </Button>
                </div>
              ) : existingAuthStatus.state !== "not-consented" ? (
                <Text as="p" variant="small" color="red" className="mt-2" role="alert">
                  This saved-account approval is unavailable ({existingAuthStatus.state}). Approve
                  it again after checking the OpenAI credential above.
                </Text>
              ) : null}
            </Callout>
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
  const capabilities = useAppCapabilities();
  const webSearch = useWebSearch();
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<WebSearchFilter>("all");
  const [showMoreProviders, setShowMoreProviders] = React.useState(false);
  const [view, setView] = React.useState<WebSearchSettingsView>("overview");
  const [routingExpanded, setRoutingExpanded] = React.useState(false);
  const [browserProviderId, setBrowserProviderId] = React.useState<WebSearchProviderId | null>(
    null,
  );
  const [editingProvider, setEditingProvider] = React.useState<WebSearchProvider | null>(null);
  const setupTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const browseProvidersTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const browserHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
  const providerDetailHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
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
        if (name === "selection" || name === "route") setRoutingExpanded(true);
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
  const primaryProviderIds = new Set(
    [...builtinProviders, ...connectedProviders].map((provider) => provider.id),
  );
  const moreProviders = filteredProviders.filter(
    (provider) => !primaryProviderIds.has(provider.id),
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
  const routeProviders = activeRoute
    .map((entry) => shippedProviders.find((provider) => provider.id === entry.providerId))
    .filter((provider): provider is WebSearchProvider => provider !== undefined);
  const routeProviderLabels = routeProviders.map((provider) => provider.label);
  const routeRecipientSummary =
    routeProviderLabels.length === 0
      ? "No ready destination is selected."
      : routeProviderLabels.length === 1
        ? `A derived query may be sent to ${routeProviderLabels[0]} only when search is used.`
        : `After an eligible failure, the same derived query may be sent sequentially to ${routeProviderLabels.join(", ")}; Aiden never fans out.`;
  const routeMayUseBilling = routeProviders.some(
    (provider) => provider.costClass === "paid" || provider.costClass === "quota",
  );
  const routeUsesOnlyFreeProviders =
    routeProviders.length > 0 &&
    routeProviders.every(
      (provider) =>
        provider.costClass === "built-in-free" || provider.costClass === "provider-free",
    );
  const routeCostSummary = routeMayUseBilling
    ? "May use provider quota or paid usage"
    : routeUsesOnlyFreeProviders
      ? "Free route"
      : routeProviders.some((provider) => provider.costClass === "self-hosted")
        ? "Uses your self-hosted service"
        : "Review provider cost before use";
  const routeModeSummary =
    currentSelection.mode === "automatic"
      ? `Automatic · ${activeRoute.length} destination${activeRoute.length === 1 ? "" : "s"}`
      : `Fixed · ${routeProviderLabels[0] ?? "Unavailable provider"}`;
  const routeStatusColor =
    routeReadyCount === activeRoute.length && activeRoute.length > 0
      ? "green"
      : routeReadyCount === 0
        ? "red"
        : undefined;
  const configuredProviders = shippedProviders.filter(
    (provider) =>
      provider.costClass !== "built-in-free" && provider.configurationStatus === "configured",
  );
  const browserProvider = browserProviderId
    ? shippedProviders.find((provider) => provider.id === browserProviderId)
    : undefined;

  const openSetup = (provider: WebSearchProvider, trigger: HTMLButtonElement) => {
    setupTriggerRef.current = trigger;
    setEditingProvider(provider);
  };

  const openProviderBrowser = () => {
    setView("providers");
    setBrowserProviderId(null);
    requestAnimationFrame(() => browserHeadingRef.current?.focus());
  };

  const closeProviderBrowser = () => {
    setView("overview");
    setBrowserProviderId(null);
    requestAnimationFrame(() => browseProvidersTriggerRef.current?.focus());
  };

  const openProviderDetail = (provider: WebSearchProvider, _trigger: HTMLButtonElement) => {
    setBrowserProviderId(provider.id);
    requestAnimationFrame(() => providerDetailHeadingRef.current?.focus());
  };

  const closeProviderDetail = () => {
    const providerId = browserProviderId;
    setBrowserProviderId(null);
    requestAnimationFrame(() => {
      if (!providerId) return;
      document
        .querySelector<HTMLButtonElement>(
          `[data-web-search-provider-row][data-provider-id="${providerId}"]`,
        )
        ?.focus();
    });
  };

  const setEnabled = (enabled: boolean) => {
    if (mutation) return;
    void performMutation(
      "enabled",
      () => webSearchApi.setEnabled(enabled),
      enabled
        ? "Web Search is on. No request is made until an eligible chat uses search."
        : "Web Search is off. Your route and credentials are preserved.",
    );
  };

  const setAutomatic = () => {
    if (mutation) return;
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
    if (mutation) return;
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

  const addToRoute = (provider: WebSearchProvider, requestedMode?: CredentialMode) => {
    if (mutation) return;
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
    if (mutation) return;
    if (currentSelection.mode !== "automatic") return;
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= activeRoute.length) return;
    const route = [...activeRoute];
    const [entry] = route.splice(index, 1);
    route.splice(nextIndex, 0, entry);
    void performMutation("route", () => webSearchApi.setAutomaticRoute(route));
  };

  const removeRouteEntry = (index: number) => {
    if (mutation) return;
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

  if (view === "providers") {
    if (browserProvider) {
      return (
        <div className="flex flex-col gap-5 pb-8">
          <Button
            variant="transparent"
            size="small"
            className="self-start"
            onClick={closeProviderDetail}
          >
            <ChevronLeft className="size-4" />
            All providers
          </Button>
          <header className="px-1">
            <h1
              ref={providerDetailHeadingRef}
              tabIndex={-1}
              className="text-heading1 font-semibold text-primary outline-none"
            >
              {browserProvider.label}
            </h1>
            <Text as="p" variant="regular" color="secondary" className="mt-1 max-w-xl">
              Review connection, cost, and privacy details. Configuration never sends a search or
              changes the active route by itself.
            </Text>
          </header>
          <ProviderCard
            provider={browserProvider}
            route={activeRoute}
            fixedProviderId={fixedProviderId}
            onConfigure={openSetup}
            onAddToRoute={addToRoute}
            onUseForSearch={(provider) => setFixedProvider(provider.id)}
            disabled={Boolean(mutation)}
          />
          <Callout>
            <Text variant="small-strong">Setup is request-free</Text>
            <Text as="p" variant="small" color="secondary">
              Saving provider details stores them on this device. It does not test the connection,
              enable Web Search, or select this provider.
            </Text>
          </Callout>
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
            />
          ) : null}
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-5 pb-8">
        <Button
          variant="transparent"
          size="small"
          className="self-start"
          onClick={closeProviderBrowser}
        >
          <ChevronLeft className="size-4" />
          Back to Web Search
        </Button>
        <header className="px-1">
          <h1
            ref={browserHeadingRef}
            tabIndex={-1}
            className="text-heading1 font-semibold text-primary outline-none"
          >
            Browse providers
          </h1>
          <Text as="p" variant="regular" color="secondary" className="mt-1 max-w-xl">
            Compare reviewed search services, then open one to configure it. Saving credentials
            never selects a provider or makes a network request.
          </Text>
        </header>

        <section
          aria-label="Current Web Search route"
          className="rounded-card border border-separator bg-well px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Text variant="small-strong">Current route</Text>
            <Badge color={routeStatusColor}>{routeModeSummary}</Badge>
            <Text variant="small" color="secondary">
              {routeReadyCount}/{activeRoute.length} ready · {routeCostSummary}
            </Text>
          </div>
          <Text as="p" variant="small" color="secondary" className="mt-1.5">
            {routeRecipientSummary}
          </Text>
        </section>

        <section aria-labelledby="web-search-provider-browser-heading">
          <Text id="web-search-provider-browser-heading" as="h2" variant="strong">
            Provider catalog
          </Text>
          <div className="mt-3 flex flex-col gap-2">
            <label className="flex h-10 items-center gap-2 rounded-control border border-field bg-input px-3 transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:border-primary/30 focus-within:bg-popover motion-reduce:transition-none">
              <Search aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  if (search) setSearch("");
                  else closeProviderBrowser();
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
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter providers">
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
              {filteredProviders.length} shipped provider
              {filteredProviders.length === 1 ? "" : "s"} · select one for details
            </Text>
          </div>

          <div className="mt-4 flex flex-col gap-5">
            <ProviderListGroup
              title="Built in"
              providers={builtinProviders}
              route={activeRoute}
              fixedProviderId={fixedProviderId}
              onSelect={openProviderDetail}
            />
            <ProviderListGroup
              title="Connected"
              providers={connectedProviders}
              route={activeRoute}
              fixedProviderId={fixedProviderId}
              onSelect={openProviderDetail}
            />
            <ProviderListGroup
              id="web-search-more-providers"
              title="More providers"
              providers={visibleMoreProviders}
              route={activeRoute}
              fixedProviderId={fixedProviderId}
              onSelect={openProviderDetail}
            />
            {moreProviders.length > 0 && !filtering ? (
              <Button
                variant="transparent"
                className="self-start"
                aria-expanded={showMoreProviders}
                aria-controls="web-search-more-providers"
                onClick={() => setShowMoreProviders((value) => !value)}
              >
                <ChevronDown
                  className={`size-4 transition-transform duration-150 motion-reduce:transition-none ${showMoreProviders ? "rotate-180" : ""}`}
                />
                {showMoreProviders
                  ? "Show fewer providers"
                  : `Show ${moreProviders.length} more providers`}
              </Button>
            ) : null}
            {filteredProviders.length === 0 ? (
              <EmptyState
                placement="inline"
                title="No shipped providers match"
                description="Clear the search and filters to browse every reviewed provider."
              />
            ) : null}
            {filteredProviders.length === 0 ? (
              <Button
                variant="transparent"
                className="self-center"
                onClick={() => {
                  setSearch("");
                  setFilter("all");
                }}
              >
                Clear search and filters
              </Button>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pb-8">
      <header className="flex items-start justify-between gap-4 px-1">
        <div className="min-w-0">
          <Text as="h1" variant="heading1">
            Web Search
          </Text>
          <Text
            id="web-search-master-description"
            as="p"
            variant="regular"
            color="secondary"
            className="mt-1 max-w-xl leading-relaxed"
          >
            Search current information in attended conversations. No startup or background search
            occurs.
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Text variant="small-strong" color={snapshot.settings.enabled ? "primary" : "secondary"}>
            {snapshot.settings.enabled ? "On" : "Off"}
          </Text>
          <Switch
            checked={snapshot.settings.enabled}
            onCheckedChange={setEnabled}
            disabled={Boolean(mutation)}
            aria-label="Allow Web Search"
            aria-describedby="web-search-master-description"
          />
        </div>
      </header>

      <section
        aria-labelledby="web-search-current-setup"
        className="overflow-hidden rounded-card border border-separator bg-popover shadow-control"
      >
        <div className="p-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent/10 text-accent">
              <Globe2 aria-hidden="true" className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <Text id="web-search-current-setup" variant="strong">
                Current search setup
              </Text>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge color={snapshot.settings.enabled ? "green" : undefined}>
                  {snapshot.settings.enabled ? "Available" : "Turned off"}
                </Badge>
                <Badge color={routeStatusColor}>
                  {routeReadyCount}/{activeRoute.length} ready
                </Badge>
                <Badge>{routeCostSummary}</Badge>
              </div>
            </div>
          </div>
          <div className="mt-4 rounded-control bg-well px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Text variant="small-strong">{routeModeSummary}</Text>
              {routeProviderLabels.length > 0 ? (
                <Text variant="small" color="secondary">
                  {routeProviderLabels.join(" → ")}
                </Text>
              ) : null}
            </div>
            <Text as="p" variant="small" color="secondary" className="mt-1.5 leading-relaxed">
              {routeRecipientSummary}
            </Text>
          </div>
          {routeReadyCount === 0 ? (
            <Callout color="red" className="mt-3" role="alert">
              <Text variant="small-strong" color="red">
                No listed provider is ready
              </Text>
              <Text as="p" variant="small" color="secondary">
                Open Routing options or browse providers to finish setup. Searches fail closed until
                a destination is ready.
              </Text>
            </Callout>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              ref={browseProvidersTriggerRef}
              variant="filled"
              size="small"
              onClick={openProviderBrowser}
            >
              Browse providers
              <ChevronRight className="size-4" />
            </Button>
            <Button
              variant="transparent"
              size="small"
              aria-expanded={routingExpanded}
              aria-controls="web-search-routing-options"
              onClick={() => setRoutingExpanded((value) => !value)}
            >
              <ChevronDown
                className={`size-4 transition-transform duration-150 motion-reduce:transition-none ${routingExpanded ? "rotate-180" : ""}`}
              />
              Routing options
              <Text as="span" variant="small" color="tertiary">
                {routeModeSummary} · {routeReadyCount}/{activeRoute.length} ready
              </Text>
            </Button>
            {mutation ? (
              <Text role="status" aria-live="polite" variant="small" color="tertiary">
                Saving…
              </Text>
            ) : null}
          </div>
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

      {routingExpanded ? (
        <div id="web-search-routing-options">
          <FieldSet title="Routing options">
            <Field
              label="Choose a routing policy"
              description="Automatic follows your ordered route and may continue only for the disclosed fallback categories. Fixed uses exactly one provider and never falls back."
              orientation="vertical"
            >
              <RadioGroup
                value={currentSelection.mode}
                disabled={Boolean(mutation)}
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
                  className="flex cursor-default items-start gap-2.5 rounded-control bg-well px-3 py-3 transition-colors duration-150 hover:bg-list-hover has-[[data-state=checked]]:bg-accent/5 motion-reduce:transition-none"
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
                  className="flex cursor-default items-start gap-2.5 rounded-control bg-well px-3 py-3 transition-colors duration-150 hover:bg-list-hover has-[[data-state=checked]]:bg-accent/5 motion-reduce:transition-none"
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
                      disabled={Boolean(mutation)}
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
                          <ProviderOptionLabel provider={provider} />
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
                  onValueChange={(providerId) =>
                    setFixedProvider(providerId as WebSearchProviderId)
                  }
                  disabled={Boolean(mutation)}
                >
                  <SelectTrigger aria-label="Fixed Web Search provider">
                    <SelectValue>{fixedProvider?.label ?? "Unavailable provider"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {shippedProviders.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        <ProviderOptionLabel provider={provider} />
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
        </div>
      ) : null}

      {configuredProviders.length > 0 ? (
        <section aria-labelledby="web-search-connected-providers">
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <div className="flex items-center gap-2">
              <Text id="web-search-connected-providers" variant="small-strong" color="secondary">
                Connected providers
              </Text>
              <Badge>{configuredProviders.length}</Badge>
            </div>
            <Button variant="transparent" size="small" onClick={openProviderBrowser}>
              Manage
              <ChevronRight className="size-4" />
            </Button>
          </div>
          <div className="overflow-hidden rounded-card border border-separator bg-popover">
            {configuredProviders.slice(0, 3).map((provider) => (
              <div
                key={provider.id}
                className="flex items-center gap-3 border-b border-separator px-3.5 py-2.5 last:border-b-0"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
                  <ProviderIcon
                    providerId={provider.id}
                    providerLabel={provider.label}
                    className="size-4"
                  />
                </span>
                <Text variant="small-strong" className="min-w-0 flex-1" truncate>
                  {provider.label}
                </Text>
                <Text variant="small" color="secondary">
                  {COST_LABELS[provider.costClass]}
                </Text>
                <Badge color={provider.ready ? "green" : undefined}>
                  {provider.ready ? "Ready" : "Connected"}
                </Badge>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section
        aria-labelledby="web-search-privacy"
        className="rounded-card border border-separator bg-well p-4"
      >
        <div className="flex items-start gap-3">
          <LockKeyhole aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-secondary" />
          <div className="min-w-0">
            <Text id="web-search-privacy" variant="strong">
              Privacy and access
            </Text>
            <Text as="p" variant="small" color="secondary" className="mt-1.5 leading-relaxed">
              {routeRecipientSummary} Avoid private information. Provider keys remain encrypted on
              this device and are never passed to the model.
            </Text>
            <Text as="p" variant="small" color="secondary" className="mt-1.5 leading-relaxed">
              Turning Web Search off preserves routes and credentials. {capabilities.bots ? "Bots and schedules" : "Schedules"} still
              require their own explicit Web Search grant.
            </Text>
            <div className="mt-3 flex flex-wrap gap-2">
              {capabilities.bots ? (
                <Button
                  variant="transparent"
                  size="small"
                  onClick={() => void navigate({ to: "/bots" })}
                >
                  Manage Bot grants
                </Button>
              ) : null}
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
        />
      ) : null}
    </div>
  );
}
