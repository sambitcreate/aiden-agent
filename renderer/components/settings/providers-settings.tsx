// Providers settings — list preset + custom connections, configure keys/models,
// add custom endpoints, and remove custom providers.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Separator,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "../ui";
import { ChevronDown, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ProviderIcon } from "../provider-icon";
import { ProviderEditor } from "./provider-editor";
import { ProviderEditorFocusTarget } from "./provider-editor-focus";
import { BuiltinProviderEditor } from "./builtin-provider-editor";
import { GeminiVoiceSetupDialog } from "./gemini-voice-setup-dialog";
import { CodexProviderSettings } from "./codex-provider-settings";
import { providersApi, settingsApi, titleProvidersApi } from "../../lib/ipc";
import { splitPiBuiltinProviders } from "../../lib/pi-provider-display";
import {
  queryKeys,
  useFoundationModelsConnection,
  useProviders,
  useSettings,
} from "../../lib/queries";
import {
  OPENAI_CODEX_PROVIDER_ID,
  type ChatTitleProviderId,
  type FoundationModelsConnectionStatus,
  type GeminiUsageScope,
  type Provider,
} from "../../lib/types";
import { GOOGLE_PROVIDER_ID } from "../../shared/google-provider";
import { defaultGeminiUsageScope } from "../../shared/gemini-usage-scope";

function statusBadge(p: Provider): React.ReactNode {
  if (p.isBuiltin) {
    return p.hasKey ? <Badge color="green">Ready</Badge> : null;
  }
  if (!p.needsKey) return <Badge color="blue">No auth</Badge>;
  if (p.hasKey) return <Badge color="green">Key set</Badge>;
  return <Badge color="secondary">No key</Badge>;
}

function foundationModelsBadge(status: FoundationModelsConnectionStatus): React.ReactNode {
  switch (status.state) {
    case "ready":
      return <Badge color="green">Ready</Badge>;
    case "model_preparing":
      return <Badge color="blue">Preparing</Badge>;
    case "apple_intelligence_disabled":
      return <Badge color="secondary">Apple Intelligence off</Badge>;
    case "device_not_eligible":
    case "unsupported_os":
      return <Badge color="secondary">Not supported</Badge>;
    case "helper_unavailable":
    case "unavailable":
    case "error":
      return <Badge color="secondary">Unavailable</Badge>;
  }
}

function ProviderInfo({
  label,
  title,
  children,
}: React.PropsWithChildren<{ label: string; title: string }>) {
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Button iconOnly size="small" variant="transparent" aria-label={label} className="size-7">
          <span aria-hidden className="text-xs font-semibold leading-none">
            i
          </span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80">
        <Text variant="small-strong">{title}</Text>
        <Text as="p" variant="small" color="secondary" className="mt-1 leading-relaxed">
          {children}
        </Text>
      </HoverCardContent>
    </HoverCard>
  );
}

const CHAT_TITLE_PROVIDER_LABELS: Record<ChatTitleProviderId, string> = {
  automatic: "Automatic",
  "apple-foundation-models": "On-device only",
  "chat-model": "Selected chat model",
};

function BuiltinProviderRows({
  providers,
  onSetUp,
  geminiUsageScope,
}: {
  providers: readonly Provider[];
  onSetUp: (provider: Provider) => void;
  geminiUsageScope?: GeminiUsageScope;
}) {
  return providers.map((provider, index) => (
    <React.Fragment key={provider.id}>
      {index > 0 ? <Separator /> : null}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
          <ProviderIcon
            providerId={provider.id}
            providerLabel={provider.label}
            artwork={provider.artwork}
            className="size-4.5"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Text variant="strong" truncate>
              {provider.label}
            </Text>
            {statusBadge(provider)}
          </div>
          <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
            {provider.id === GOOGLE_PROVIDER_ID && geminiUsageScope === "transcription_only"
              ? "Transcription only · chat models hidden"
              : `${provider.models.length} available model${provider.models.length === 1 ? "" : "s"}`}
          </Text>
        </div>
        <Button variant="filled" size="small" onClick={() => onSetUp(provider)}>
          {provider.hasKey ? "Manage" : "Set up"}
        </Button>
      </div>
    </React.Fragment>
  ));
}

export function ProvidersSettings() {
  const qc = useQueryClient();
  const providers = useProviders();
  const settings = useSettings();
  const foundationModels = useFoundationModelsConnection();
  const [editing, setEditing] = React.useState<Provider | null>(null);
  const editingFocusTarget = React.useRef(new ProviderEditorFocusTarget());
  const addProviderTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const [settingUp, setSettingUp] = React.useState<Provider | null>(null);
  const [geminiDialogOpen, setGeminiDialogOpen] = React.useState(false);
  const [geminiScope, setGeminiScope] = React.useState<GeminiUsageScope>("transcription_only");
  const [geminiBusy, setGeminiBusy] = React.useState(false);
  const [geminiError, setGeminiError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<Provider | null>(null);
  const [savingTitleProvider, setSavingTitleProvider] = React.useState(false);
  const [refreshingFoundationModels, setRefreshingFoundationModels] = React.useState(false);
  const [refreshingProviders, setRefreshingProviders] = React.useState(false);
  const [showMoreBuiltinProviders, setShowMoreBuiltinProviders] = React.useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.providers });
  const list = (providers.data ?? []).filter(
    (provider) => provider.id !== OPENAI_CODEX_PROVIDER_ID,
  );
  const builtins = list.filter((provider) => provider.isBuiltin);
  const customProviders = list.filter((provider) => !provider.isBuiltin);
  const { featured: featuredBuiltins, more: moreBuiltins } = splitPiBuiltinProviders(builtins);
  const titleProviderId = settings.data?.chatTitleProviderId ?? "automatic";

  const openBuiltinSetup = (provider: Provider) => {
    if (provider.id !== GOOGLE_PROVIDER_ID) {
      setSettingUp(provider);
      return;
    }
    setGeminiScope(
      defaultGeminiUsageScope(settings.data?.geminiUsageScope, provider.hasKey === true),
    );
    setGeminiError(null);
    setGeminiDialogOpen(true);
  };

  const saveGeminiSetup = async () => {
    const saved = await settingsApi.setGeminiUsageScope(geminiScope);
    qc.setQueryData(queryKeys.settings, saved);
    await invalidate();
  };

  const confirmGeminiSetup = async () => {
    const google = list.find((provider) => provider.id === GOOGLE_PROVIDER_ID);
    if (!google) {
      setGeminiError("Google provider details are not available yet. Refresh and try again.");
      return;
    }
    if (!google.hasKey) {
      setGeminiDialogOpen(false);
      setSettingUp(google);
      return;
    }
    setGeminiBusy(true);
    setGeminiError(null);
    try {
      await saveGeminiSetup();
      setGeminiDialogOpen(false);
      toast.success("Gemini access updated.");
    } catch (error) {
      setGeminiError(error instanceof Error ? error.message : "Couldn't update Gemini access.");
    } finally {
      setGeminiBusy(false);
    }
  };

  const manageGeminiCredential = () => {
    const google = list.find((provider) => provider.id === GOOGLE_PROVIDER_ID);
    if (!google) return;
    setGeminiDialogOpen(false);
    setSettingUp(google);
  };

  const setTitleProvider = async (value: ChatTitleProviderId) => {
    setSavingTitleProvider(true);
    try {
      await settingsApi.set({ chatTitleProviderId: value });
      await qc.invalidateQueries({ queryKey: queryKeys.settings });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't save the chat title provider.",
      );
    } finally {
      setSavingTitleProvider(false);
    }
  };

  const refreshFoundationModels = async () => {
    setRefreshingFoundationModels(true);
    try {
      const status = await titleProvidersApi.refresh();
      qc.setQueryData(queryKeys.foundationModelsConnection, status);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't refresh Apple Foundation Models.",
      );
    } finally {
      setRefreshingFoundationModels(false);
    }
  };

  const refreshProviders = async () => {
    setRefreshingProviders(true);
    try {
      const result = await providersApi.refresh();
      qc.setQueryData(queryKeys.providers, result.providers);
      if (result.errors.length > 0) {
        toast.warning(
          `${result.errors.length} provider catalog${result.errors.length === 1 ? "" : "s"} could not refresh; cached models were kept.`,
        );
      } else {
        toast.success("Built-in provider models refreshed.");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't refresh built-in provider models.",
      );
    } finally {
      setRefreshingProviders(false);
    }
  };

  const addCustom = (template: "lmstudio" | "ollama" | "custom" | "tailnet") => {
    editingFocusTarget.current.capture(addProviderTriggerRef.current);
    const id =
      template === "lmstudio" || template === "ollama"
        ? `custom:${template}`
        : `custom:connection-${Date.now().toString(36)}`;
    setEditing({
      id,
      kind: "openai",
      label:
        template === "lmstudio"
          ? "LM Studio (local)"
          : template === "ollama"
            ? "Ollama (local)"
            : template === "tailnet"
              ? "Tailscale model server"
              : "Custom Provider",
      baseUrl:
        template === "lmstudio"
          ? "http://localhost:1234/v1"
          : template === "ollama"
            ? "http://localhost:11434/v1"
            : template === "tailnet"
              ? "http://your-machine.your-tailnet.ts.net:11434/v1"
              : "http://localhost:8000/v1",
      models: [],
      // A user may opt into API-key auth in the editor. Tailscale controls
      // reachability, not whether an application-layer key is required.
      needsKey: false,
      // Tailscale private servers are local inference; loopback custom defaults
      // to local via URL inference, but set it explicitly for the editor.
      deployment: "local",
      isPreset: false,
      hasKey: false,
    });
  };

  const confirmRemove = async () => {
    if (!removing) return;
    await providersApi.remove(removing.id);
    await invalidate();
    setRemoving(null);
  };

  return (
    <div className="providers-settings flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <Text variant="strong">Providers</Text>
            <ProviderInfo label="About provider connections" title="Provider connections">
              Aiden manages built-in provider endpoints and model catalogs. Use Add provider for a
              local, private, or vendor-compatible endpoint.
            </ProviderInfo>
          </div>
          <Text variant="small" color="secondary" className="mt-0.5 block">
            Connect models to Aiden and manage the providers you already use.
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-label="Refresh built-in provider models"
            disabled={refreshingProviders}
            onClick={() => void refreshProviders()}
          >
            <RefreshCw className={`size-4 ${refreshingProviders ? "animate-spin" : ""}`} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button ref={addProviderTriggerRef} variant="filled" size="small">
                <Plus className="size-4" />
                Add provider
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel>Local model servers</DropdownMenuLabel>
              <DropdownMenuItem
                className="group"
                disabled={customProviders.some((provider) => provider.id === "custom:lmstudio")}
                onSelect={() => addCustom("lmstudio")}
              >
                <ProviderIcon
                  providerId="custom:lmstudio"
                  providerLabel="LM Studio"
                  className="size-4 text-tertiary group-data-[highlighted]:text-accent-foreground"
                />
                <span className="flex min-w-0 flex-col">
                  <span>LM Studio</span>
                  <span className="text-small text-tertiary group-data-[highlighted]:text-accent-foreground">
                    OpenAI-compatible local server
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="group"
                disabled={customProviders.some((provider) => provider.id === "custom:ollama")}
                onSelect={() => addCustom("ollama")}
              >
                <ProviderIcon
                  providerId="custom:ollama"
                  providerLabel="Ollama"
                  className="size-4 text-tertiary group-data-[highlighted]:text-accent-foreground"
                />
                <span className="flex min-w-0 flex-col">
                  <span>Ollama</span>
                  <span className="text-small text-tertiary group-data-[highlighted]:text-accent-foreground">
                    Local server with Ollama-aware model discovery
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Private or custom</DropdownMenuLabel>
              <DropdownMenuItem className="group" onSelect={() => addCustom("tailnet")}>
                <span className="flex min-w-0 flex-col">
                  <span>Model server over Tailscale</span>
                  <span className="text-small text-tertiary group-data-[highlighted]:text-accent-foreground">
                    OpenAI-compatible, no authentication by default
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem className="group" onSelect={() => addCustom("custom")}>
                <span className="flex min-w-0 flex-col">
                  <span>Other custom endpoint</span>
                  <span className="text-small text-tertiary group-data-[highlighted]:text-accent-foreground">
                    Choose protocol and authentication
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <CodexProviderSettings />

      {foundationModels.data ? (
        <div
          className="rounded-card border border-separator"
          aria-busy={refreshingFoundationModels}
        >
          <div className="flex items-start gap-3 px-4 py-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
              <ProviderIcon
                providerId="apple-foundation-models"
                providerLabel="Apple Foundation Models"
                className="size-4"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Text variant="strong">Apple Foundation Models</Text>
                <ProviderInfo
                  label="About Apple Foundation Models in Aiden"
                  title="Background title generation"
                >
                  This on-device connection is used only for background chat titles. It never
                  appears in the chat model picker.
                </ProviderInfo>
                <Badge color="blue">On-device</Badge>
                {foundationModelsBadge(foundationModels.data)}
              </div>
              <div aria-live="polite">
                <Text variant="small" color="tertiary" className="mt-1 block">
                  {foundationModels.data.detail}
                </Text>
              </div>
            </div>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              aria-label="Refresh Apple Foundation Models status"
              disabled={refreshingFoundationModels}
              onClick={() => void refreshFoundationModels()}
            >
              <RefreshCw className={`size-4 ${refreshingFoundationModels ? "animate-spin" : ""}`} />
            </Button>
          </div>
          <details className="group border-t border-separator">
            <summary className="flex min-h-12 cursor-default list-none items-center gap-3 px-4 py-2.5 outline-none hover:bg-list-hover focus-visible:bg-list-selection [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 flex-1">
                <span className="block text-small-strong text-primary">Chat title generation</span>
                <span className="mt-0.5 block text-small text-tertiary">
                  {CHAT_TITLE_PROVIDER_LABELS[titleProviderId]}
                </span>
              </span>
              <ChevronDown className="size-4 shrink-0 text-tertiary transition-transform duration-150 group-open:rotate-180" />
            </summary>
            <div className="flex flex-col gap-3 px-4 pb-4 pt-1 sm:flex-row sm:items-end sm:justify-between">
              <Text variant="small" color="tertiary" as="p" className="max-w-md">
                Automatic prefers this Mac, then uses the selected chat model only when Apple is
                unavailable. On-device only never falls back to a network provider.
              </Text>
              <Select
                value={titleProviderId}
                disabled={savingTitleProvider}
                onValueChange={(value) => void setTitleProvider(value as ChatTitleProviderId)}
              >
                <SelectTrigger
                  size="small"
                  className="w-full shrink-0 sm:w-48"
                  aria-label="Chat title provider"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="automatic">Automatic</SelectItem>
                  <SelectItem value="apple-foundation-models">On-device only</SelectItem>
                  <SelectItem value="chat-model">Selected chat model</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </details>
        </div>
      ) : null}

      <div className="grid gap-2">
        <div className="px-1">
          <div className="flex items-center gap-1">
            <Text variant="small-strong">Built into Aiden</Text>
            <ProviderInfo label="About providers built into Aiden" title="Managed by Aiden">
              Aiden maintains these providers’ endpoints, model catalogs, and connection transport.
              You provide credentials when required; managed connection details stay locked to
              prevent accidental misconfiguration.
            </ProviderInfo>
          </div>
          <Text variant="small" color="tertiary" className="mt-0.5 block">
            Connect with credentials when required; Aiden keeps their model catalogs current.
          </Text>
        </div>
        <div className="rounded-card border border-separator">
          <BuiltinProviderRows
            providers={featuredBuiltins}
            onSetUp={openBuiltinSetup}
            geminiUsageScope={settings.data?.geminiUsageScope}
          />
          {moreBuiltins.length > 0 ? (
            <>
              {featuredBuiltins.length > 0 ? <Separator /> : null}
              <div className="px-4 py-2">
                <Button
                  variant="transparent"
                  size="small"
                  aria-controls="more-pi-providers"
                  aria-expanded={showMoreBuiltinProviders}
                  onClick={() => setShowMoreBuiltinProviders((showMore) => !showMore)}
                >
                  {showMoreBuiltinProviders
                    ? "Show fewer providers"
                    : `Show ${moreBuiltins.length} more provider${moreBuiltins.length === 1 ? "" : "s"}`}
                  <ChevronDown
                    className={`size-3.5 transition-transform duration-150 ${showMoreBuiltinProviders ? "rotate-180" : ""}`}
                  />
                </Button>
              </div>
            </>
          ) : null}
        </div>
        {showMoreBuiltinProviders && moreBuiltins.length > 0 ? (
          <div id="more-pi-providers" className="rounded-card border border-separator">
            <div className="px-4 py-3">
              <Text variant="small-strong">More built-in providers</Text>
              <Text variant="small" color="tertiary" className="mt-0.5 block">
                These are also managed by Aiden and can be set up whenever you need them.
              </Text>
            </div>
            <Separator />
            <BuiltinProviderRows
              providers={moreBuiltins}
              onSetUp={openBuiltinSetup}
              geminiUsageScope={settings.data?.geminiUsageScope}
            />
          </div>
        ) : null}
      </div>

      {customProviders.length > 0 ? (
        <div className="grid gap-2">
          <div className="px-1">
            <Text variant="small-strong">Custom connections</Text>
            <Text variant="small" color="tertiary" className="mt-0.5 block">
              Configure local, private, and vendor-compatible endpoints here.
            </Text>
          </div>
          <div className="rounded-card border border-separator">
            {customProviders.map((p, i) => (
              <React.Fragment key={p.id}>
                {i > 0 ? <Separator /> : null}
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
                    <ProviderIcon
                      providerId={p.id}
                      providerLabel={p.label}
                      artwork={p.artwork}
                      className="size-4.5"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Text variant="strong" truncate>
                        {p.label}
                      </Text>
                      {statusBadge(p)}
                    </div>
                    <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
                      {p.baseUrl}
                    </Text>
                  </div>
                  <Button
                    variant="filled"
                    size="small"
                    onClick={(event) => {
                      editingFocusTarget.current.capture(event.currentTarget);
                      setEditing(p);
                    }}
                  >
                    Configure
                  </Button>
                  <Button
                    variant="transparent"
                    size="small"
                    iconOnly
                    aria-label="Remove provider"
                    onClick={() => setRemoving(p)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : null}

      {editing ? (
        <ProviderEditor
          provider={editing}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={invalidate}
          returnFocus={() => editingFocusTarget.current.take() as HTMLElement | null}
        />
      ) : null}

      {settingUp ? (
        <BuiltinProviderEditor
          provider={settingUp}
          open={settingUp !== null}
          onOpenChange={(open) => !open && setSettingUp(null)}
          requireChatModel={settingUp.id !== GOOGLE_PROVIDER_ID}
          onSaved={settingUp.id === GOOGLE_PROVIDER_ID ? saveGeminiSetup : invalidate}
        />
      ) : null}

      <GeminiVoiceSetupDialog
        open={geminiDialogOpen}
        scope={geminiScope}
        activatesVoice={false}
        hasKey={list.some(
          (provider) => provider.id === GOOGLE_PROVIDER_ID && provider.hasKey === true,
        )}
        busy={geminiBusy}
        error={geminiError}
        onScopeChange={setGeminiScope}
        onOpenChange={(open) => {
          if (!geminiBusy) {
            setGeminiDialogOpen(open);
            if (!open) setGeminiError(null);
          }
        }}
        onConfirm={confirmGeminiSetup}
        onManageCredential={manageGeminiCredential}
      />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this provider?"
        description={removing ? `“${removing.label}” and its saved key will be removed.` : null}
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={confirmRemove}
      />
    </div>
  );
}
