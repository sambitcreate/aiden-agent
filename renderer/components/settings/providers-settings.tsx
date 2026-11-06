// Providers settings — list preset + custom connections, configure keys/models,
// add custom endpoints, and remove custom providers.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Badge,
  Button,
  Field,
  Separator,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "../ui";
import { Check, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ProviderIcon } from "../provider-icon";
import { InfoHint } from "../ui-info-hint";
import { ProviderEditor } from "./provider-editor";
import { ProviderEditorFocusTarget } from "./provider-editor-focus";
import { BuiltinProviderEditor } from "./builtin-provider-editor";
import { ProviderSetupRow } from "./provider-setup-row";
import { GeminiVoiceSetupDialog } from "./gemini-voice-setup-dialog";
import { CodexProviderSettings } from "./codex-provider-settings";
import { providersApi, settingsApi, titleProvidersApi } from "../../lib/ipc";
import { availableChatModel } from "../../lib/provider-chat-readiness";
import { GuidedProviderChooser, type ConnectionRoute } from "../guided-provider-chooser";
import { ProviderKeyDialog } from "../provider-key-dialog";
import { LocalProviderDialog } from "../local-provider-dialog";
import {
  queryKeys,
  useFoundationModelsConnection,
  useCodexProviderStatus,
  useModelCatalogStatus,
  useProviders,
  useSettings,
} from "../../lib/queries";
import {
  OPENAI_CODEX_PROVIDER_ID,
  type AppSettings,
  type ChatTitleProviderId,
  type FoundationModelsConnectionStatus,
  type GeminiUsageScope,
  type Provider,
} from "../../lib/types";
import { GOOGLE_PROVIDER_ID } from "../../shared/google-provider";
import { defaultGeminiUsageScope } from "../../shared/gemini-usage-scope";

import { useAppCapabilities } from "../../lib/app-capabilities";

function statusBadge(p: Provider): React.ReactNode {
  if (p.isBuiltin) {
    return p.hasKey ? <Badge>Configured</Badge> : <Badge color="warning">Needs attention</Badge>;
  }
  if (!p.needsKey) return <Badge color="blue">No key needed</Badge>;
  if (p.hasKey) return <Badge color="green" icon={<Check />}>Key saved</Badge>;
  return <Badge color="warning">Needs API key</Badge>;
}

function foundationModelsBadge(status: FoundationModelsConnectionStatus): React.ReactNode {
  switch (status.state) {
    case "ready":
      return <Badge color="green" icon={<Check />}>Ready</Badge>;
    case "model_preparing":
      return <Badge color="blue" icon={<Loader2 className="animate-spin motion-reduce:animate-none" />}>Preparing</Badge>;
    case "apple_intelligence_disabled":
      return <Badge>Apple Intelligence off</Badge>;
    case "device_not_eligible":
    case "unsupported_os":
      return <Badge>Not supported</Badge>;
    case "helper_unavailable":
    case "unavailable":
    case "error":
      return <Badge>Unavailable</Badge>;
  }
}

function BuiltinProviderRows({
  providers,
  onSetUp,
  settings,
}: {
  providers: readonly Provider[];
  onSetUp: (provider: Provider) => void;
  settings?: AppSettings;
}) {
  return providers.map((provider, index) => (
    <React.Fragment key={provider.id}>
      {index > 0 ? <Separator /> : null}
      <ProviderSetupRow
        icon={
          <ProviderIcon
            providerId={provider.id}
            providerLabel={provider.label}
            artwork={provider.artwork}
            className="size-4.5"
          />
        }
        name={provider.label}
        badge={statusBadge(provider)}
        subtitle={
          provider.id === GOOGLE_PROVIDER_ID && settings?.geminiUsageScope === "transcription_only"
            ? "Transcription only · chat models hidden"
            : availableChatModel(provider, settings) ?? "No chat model available"
        }
        actionLabel={provider.hasKey ? "Manage" : "Reconnect"}
        onAction={() => onSetUp(provider)}
      />
    </React.Fragment>
  ));
}

export function ProvidersSettings() {
  const qc = useQueryClient();
  const capabilities = useAppCapabilities();
  const providers = useProviders();
  const settings = useSettings();
  const foundationModels = useFoundationModelsConnection(capabilities.appleFoundationModels);
  const modelCatalogStatus = useModelCatalogStatus();
  const [editing, setEditing] = React.useState<Provider | null>(null);
  const editingFocusTarget = React.useRef(new ProviderEditorFocusTarget());
  const addProviderTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const [settingUp, setSettingUp] = React.useState<Provider | null>(null);
  const [geminiDialogOpen, setGeminiDialogOpen] = React.useState(false);
  const [geminiScope, setGeminiScope] = React.useState<GeminiUsageScope>("transcription_only");
  const [geminiBusy, setGeminiBusy] = React.useState(false);
  const [geminiError, setGeminiError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<Provider | null>(null);
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const [savingTitleProvider, setSavingTitleProvider] = React.useState(false);
  const [refreshingFoundationModels, setRefreshingFoundationModels] = React.useState(false);
  const [refreshingProviders, setRefreshingProviders] = React.useState(false);
  const [catalogOutcome, setCatalogOutcome] = React.useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = React.useState(false);
  const [showCodex, setShowCodex] = React.useState(false);
  const [routeMethod, setRouteMethod] = React.useState<"api_key" | "oauth">();
  const [hostedKey, setHostedKey] = React.useState<"openai" | "anthropic" | null>(null);
  const [runtime, setRuntime] = React.useState<"lmstudio" | "ollama" | null>(null);
  const codex = useCodexProviderStatus();

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.providers });
  const list = (providers.data ?? []).filter(
    (provider) => provider.id !== OPENAI_CODEX_PROVIDER_ID,
  );
  const builtins = list.filter((provider) => provider.isBuiltin);
  const customProviders = list.filter((provider) => !provider.isBuiltin);
  const configured = builtins.filter(p => p.hasKey || p.canLogout);
  const hasCodex = codex.data?.configured || codex.data?.needsAttention;
  const hasConnections = configured.length > 0 || customProviders.length > 0 || hasCodex;
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
    setCatalogOutcome(null);
    try {
      const result = await providersApi.updateCatalogs();
      qc.setQueryData(queryKeys.providers, result.providers);
      qc.setQueryData(queryKeys.modelCatalogStatus, result.modelsDev.status);
      if (result.modelsDev.ok) {
        await qc.invalidateQueries({ queryKey: ["modelInfo"] });
      }
      await qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
      const inventoryOk = result.inventoryErrors.length === 0;
      if (inventoryOk && result.modelsDev.ok) {
        setCatalogOutcome("Provider inventory and model details are up to date.");
        toast.success("Model catalogs updated.");
      } else {
        const outcome = `${inventoryOk ? "Provider inventory updated" : "Provider inventory kept cached data"}; ${result.modelsDev.ok ? "model details updated" : "model details kept cached data"}.`;
        setCatalogOutcome(outcome);
        toast.warning(outcome);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't update model catalogs.";
      setCatalogOutcome("Catalog update failed; cached data is still available.");
      toast.error(message);
    } finally {
      setRefreshingProviders(false);
    }
  };

  const addCustom = (template: "lmstudio" | "ollama" | "custom" | "tailnet") => {
    editingFocusTarget.current.capture(document.activeElement instanceof HTMLElement ? document.activeElement : addProviderTriggerRef.current);
    const existing = (template === "lmstudio" || template === "ollama") && customProviders.find(p => p.id === `custom:${template}`);
    if (existing) { setEditing(existing); return; }
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

  const savedConnection = async (provider: Provider) => {
    await invalidate();
    setChooserOpen(false);
    toast.success(`${provider.label} configured.`);
  };

  const returnFocus = () => editingFocusTarget.current.take() as HTMLElement | null ?? addProviderTriggerRef.current;
  const chooseConnection = (route: ConnectionRoute, trigger: HTMLButtonElement) => {
    editingFocusTarget.current.capture(trigger);
    if (route.kind === "local") { setRuntime(route.runtime); return; }
    if (route.kind === "endpoint") { addCustom(route.template); return; }
    if (route.kind === "codex") { setShowCodex(true); setChooserOpen(false); return; }
    const { id } = route.provider;
    if (route.method === "api_key" && (id === "openai" || id === "anthropic")) { setHostedKey(id); return; }
    setRouteMethod(route.method);
    openBuiltinSetup(route.provider);
  };

  const confirmRemove = async () => {
    if (!removing || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await providersApi.remove(removing.id);
    } catch (error) {
      setRemoveError(
        error instanceof Error && error.message
          ? error.message
          : "Aiden could not remove this provider. Try again.",
      );
      return;
    } finally {
      setRemoveBusy(false);
    }
    setRemoving(null);
    await invalidate();
  };

  return (
    <div className="providers-settings flex flex-col gap-6">
      <div className="settings-page-heading flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <Text as="h1" variant="heading1">Providers</Text>
            <InfoHint topic="provider connections">
              Connect an account, an API key or a local model. Custom endpoints and catalog updates are in Advanced.
            </InfoHint>
          </div>
          <Text variant="small" color="secondary" className="mt-0.5 block">
            Choose which AI services Aiden can use for chat.
          </Text>
        </div>
      </div>
      {providers.isLoading || codex.isLoading ? <Text role="status" variant="small">Loading connections…</Text>
        : providers.isError || codex.isError ? <div role="alert" className="settings-card p-4">
          Couldn’t read all connections. <Button size="small" onClick={() => { void providers.refetch(); void codex.refetch(); }}>Try again</Button>
        </div> : null}
      {hasConnections && <Text as="h2" variant="small-strong">Your connections</Text>}
      {(hasCodex || showCodex || codex.isError) && <CodexProviderSettings />}
      {configured.length > 0 && <div className="settings-card">
        <BuiltinProviderRows providers={configured} onSetUp={p => { editingFocusTarget.current.capture(document.activeElement as HTMLElement | null); setRouteMethod(undefined); openBuiltinSetup(p); }} settings={settings.data} />
      </div>}
      {customProviders.length > 0 ? (
        <div className="grid min-w-0 grid-cols-1 gap-2">
          <div className="settings-card rounded-card">
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
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Text variant="strong" truncate>
                        {p.label}
                      </Text>
                      {statusBadge(p)}
                    </div>
                    <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
                      {availableChatModel(p, settings.data) ?? (p.needsKey && !p.hasKey ? "Add an API key" : "No chat model available")}
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
                    Manage
                  </Button>
                  <Button
                    variant="transparent"
                    size="small"
                    iconOnly
                    aria-label={`Remove ${p.label}`}
                    onClick={() => {
                      setRemoveError(null);
                      setRemoving(p);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : null}
      <div className={hasConnections ? "grid justify-items-start gap-3" : "settings-card grid justify-items-start gap-3 p-4"}>
        {!hasConnections && providers.isSuccess && codex.isSuccess && <div>
          <Text as="h2" variant="strong">Give Aiden a way to reply</Text>
          <Text as="p" variant="small" color="secondary">Connect an account, use an API key or run a model on your computer.</Text>
        </div>}
        <Button ref={addProviderTriggerRef} variant={hasConnections ? "filled" : "accent"} aria-expanded={chooserOpen}
          onClick={() => setChooserOpen(!chooserOpen)}><Plus />{hasConnections ? "Connect another AI" : "Connect AI"}</Button>
        {chooserOpen && <div className="w-full"><GuidedProviderChooser providers={builtins} showEndpoints={false} onChoose={chooseConnection} /></div>}
      </div>
      <details className="settings-card">
        <summary className="cursor-pointer px-4 py-3 text-small-strong">Advanced</summary>
        <div className="grid min-w-0 gap-5 px-4 pb-4">
          <div className="flex flex-wrap gap-2"><Button variant="filled" size="small" onClick={() => addCustom("custom")}>Add custom endpoint</Button>
            <Button variant="filled" size="small" onClick={() => addCustom("tailnet")}>Connect Tailscale server</Button></div>
      {capabilities.appleFoundationModels && foundationModels.data ? (
        <div
          className="settings-card rounded-card"
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
                <InfoHint topic="Apple Foundation Models in Aiden">
                  This on-device connection is used only for background chat titles. It never
                  appears in the chat model picker.
                </InfoHint>
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
          <div className="border-t border-separator">
            <Field
              label="Chat title generation"
              hint={
                <InfoHint topic="chat title generation">
                  Automatic uses the on-device model when it can, then your chat model. On-device
                  only never sends your message to a network provider.
                </InfoHint>
              }
            >
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
            </Field>
          </div>
        </div>
      ) : !capabilities.appleFoundationModels ? (
        <div className="rounded-card bg-well px-3.5 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <Text variant="small-strong" as="p">
                Chat title provider
              </Text>
              <Text variant="small" color="tertiary" as="p" className="mt-0.5">
                {titleProviderId === "apple-foundation-models"
                  ? "On-device titles are unavailable on this computer. Choose Automatic or Selected chat model to allow your selected model to generate titles."
                  : "Automatic uses your selected chat model. Choose Selected chat model to make that preference explicit."}
              </Text>
            </div>
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
                {titleProviderId === "apple-foundation-models" ? (
                  <SelectItem value="apple-foundation-models" disabled>On-device only (unavailable)</SelectItem>
                ) : null}
                <SelectItem value="automatic">Automatic</SelectItem>
                <SelectItem value="chat-model">Selected chat model</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      <div className="settings-card rounded-card">
        <Field
          label="Model catalog"
          hint={
            <InfoHint topic="model catalogs">
              Downloaded models.dev data changes display details only, never which models can run or
              their runtime limits.
            </InfoHint>
          }
          description={
            <>
              <span aria-live="polite" className="block">
                {catalogOutcome ??
                  `Model details: ${
                    modelCatalogStatus.data?.source === "device-cache" ? "device cache" : "bundled snapshot"
                  }${
                    modelCatalogStatus.data?.fetchedAt
                      ? ` · updated ${new Date(modelCatalogStatus.data.fetchedAt).toLocaleString()}`
                      : ""
                  }`}
              </span>
              <span className="mt-0.5 block">
                Updating contacts built-in catalog services and models.dev. It sends no prompts, chats
                or device identifier. A provider&apos;s own catalog service may use your sign-in for
                that provider; models.dev gets no credentials.
              </span>
            </>
          }
        >
          <Button
            variant="filled"
            size="small"
            disabled={refreshingProviders}
            aria-busy={refreshingProviders}
            onClick={() => void refreshProviders()}
          >
            <RefreshCw
              className={`size-4 ${refreshingProviders ? "animate-spin motion-reduce:animate-none" : ""}`}
            />
            {refreshingProviders ? "Updating…" : "Update model catalogs"}
          </Button>
        </Field>
      </div>

        </div>
      </details>
      {hostedKey && <ProviderKeyDialog returnFocus={returnFocus} id={hostedKey} onClose={() => setHostedKey(null)} onSaved={savedConnection} />}
      {runtime && <LocalProviderDialog returnFocus={returnFocus} runtime={runtime} onSaved={savedConnection} onClose={() => setRuntime(null)}
        onEdit={() => { addCustom(runtime); setRuntime(null); }} />}
      {editing ? (
        <ProviderEditor
          provider={editing}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={invalidate}
          returnFocus={returnFocus}
        />
      ) : null}

      {settingUp ? (
        <BuiltinProviderEditor
          provider={settingUp}
          method={routeMethod}
          returnFocus={returnFocus}
          open={settingUp !== null}
          onOpenChange={(open) => !open && setSettingUp(null)}
          requireChatModel={settingUp.id !== GOOGLE_PROVIDER_ID}
          onSaved={settingUp.id === GOOGLE_PROVIDER_ID ? saveGeminiSetup : invalidate}
        />
      ) : null}

      <GeminiVoiceSetupDialog
        returnFocus={returnFocus}
        open={geminiDialogOpen}
        scope={geminiScope}
        activatesVoice={false}
        hasKey={list.some(
          (provider) => provider.id === GOOGLE_PROVIDER_ID && provider.hasKey === true,
        )}
        provider={list.find((provider) => provider.id === GOOGLE_PROVIDER_ID)}
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
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            setRemoveError(null);
          }
        }}
        title="Remove this provider?"
        description={
          removing ? (
            <>
              <span>“{removing.label}” and its saved key will be removed.</span>
              {removeError ? (
                <Text as="p" variant="small" className="mt-2 text-red" role="alert">
                  {removeError}
                </Text>
              ) : null}
            </>
          ) : null
        }
        confirmLabel={removeBusy ? "Removing…" : "Remove"}
        confirmVariant="destructive"
        busy={removeBusy}
        keepOpenOnConfirm
        onConfirm={confirmRemove}
      />
    </div>
  );
}
