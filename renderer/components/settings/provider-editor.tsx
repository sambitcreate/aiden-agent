// Dialog to configure a custom provider: base URL, API key, connection test,
// model discovery, and default model. Pi built-ins use a separate setup view.

import * as React from "react";
import {
  Badge,
  Button,
  Dialog,
  Field,
  FieldSet,
  Input,
  InlineMetadata,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "../ui";
import { providersApi } from "../../lib/ipc";
import { useModelInfo, useSettings } from "../../lib/queries";
import { resolveModelDisplay } from "../../lib/model-display";
import type {
  Provider,
  ProviderDeployment,
  ProviderKind,
  ProviderModelMetadata,
} from "../../lib/types";
import { resolveProviderDeployment } from "../../shared/provider-deployment";
import { ProviderModelVisibility } from "./provider-model-visibility";
import { ProviderIcon } from "../provider-icon";
import { isModelHidden } from "../../shared/model-visibility";

/** Compact k-token label, e.g. 128000 → "128K". */
function formatContext(n: number | undefined): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function isTailnetEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith(".ts.net");
  } catch {
    return false;
  }
}

interface ProviderEditorProps {
  provider: Provider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  returnFocus?: () => HTMLElement | null;
}

export function ProviderEditor({
  provider,
  open,
  onOpenChange,
  onSaved,
  returnFocus,
}: ProviderEditorProps) {
  const artworkInputRef = React.useRef<HTMLInputElement>(null);
  const artworkBusyRef = React.useRef(false);
  const [label, setLabel] = React.useState(provider.label);
  const [baseUrl, setBaseUrl] = React.useState(provider.baseUrl);
  const [kind, setKind] = React.useState<ProviderKind>(provider.kind);
  const [needsKey, setNeedsKey] = React.useState(provider.needsKey);
  const [deployment, setDeployment] = React.useState<ProviderDeployment>(
    resolveProviderDeployment(provider),
  );
  const [keyDraft, setKeyDraft] = React.useState("");
  const [models, setModels] = React.useState<string[]>(provider.models);
  const [modelMetadata, setModelMetadata] = React.useState<Record<string, ProviderModelMetadata>>(
    provider.modelMetadata ?? {},
  );
  const [defaultModel, setDefaultModel] = React.useState(
    provider.defaultModel ?? provider.models[0] ?? "",
  );
  const [artwork, setArtwork] = React.useState(provider.artwork);
  const [artworkBusy, setArtworkBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [modelsStale, setModelsStale] = React.useState(false);
  const [connectionNotice, setConnectionNotice] = React.useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const modelInfo = useModelInfo(provider.id, models, provider);
  const settings = useSettings();
  const visibleDefaultModels = settings.data
    ? models.filter(
        (modelId) =>
          !isModelHidden(settings.data?.hiddenModelsByProvider, provider.id, modelId),
      )
    : [];
  const defaultModelIsHidden = Boolean(
    settings.data &&
    defaultModel &&
    isModelHidden(settings.data.hiddenModelsByProvider, provider.id, defaultModel),
  );
  const usesArtificialAnalysis = models.some(
    (modelId) => modelInfo.data?.[modelId]?.metadataSource === "artificial-analysis",
  );

  // Reset drafts whenever a different provider is opened.
  React.useEffect(() => {
    if (open) {
      setLabel(provider.label);
      setBaseUrl(provider.baseUrl);
      setKind(provider.kind);
      setNeedsKey(provider.needsKey);
      setDeployment(resolveProviderDeployment(provider));
      setKeyDraft("");
      setModels(provider.models);
      setModelMetadata(provider.modelMetadata ?? {});
      setDefaultModel(provider.defaultModel ?? provider.models[0] ?? "");
      setArtwork(provider.artwork);
      setModelsStale(false);
      setConnectionNotice(null);
    }
  }, [open, provider]);

  const buildDraft = (): Omit<Provider, "hasKey"> => ({
    id: provider.id,
    kind,
    label: label.trim() || provider.label,
    artwork,
    baseUrl: baseUrl.trim() || provider.baseUrl,
    models,
    modelMetadata,
    defaultModel: defaultModel || undefined,
    needsKey,
    deployment,
    isPreset: false,
    isBuiltin: false,
  });

  const chooseArtwork = async (file: File | undefined) => {
    if (!file || artworkBusyRef.current) return;
    if (file.size > 512 * 1024) {
      toast.error("Provider artwork must be 512 KB or smaller.");
      return;
    }
    artworkBusyRef.current = true;
    setArtworkBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          typeof reader.result === "string"
            ? resolve(reader.result)
            : reject(new Error("Aiden could not read that image."));
        reader.onerror = () => reject(reader.error ?? new Error("Aiden could not read that image."));
        reader.readAsDataURL(file);
      });
      const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      setArtwork(await providersApi.normalizeArtwork({ name: file.name, dataBase64 }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not use that provider icon.");
    } finally {
      artworkBusyRef.current = false;
      setArtworkBusy(false);
      if (artworkInputRef.current) artworkInputRef.current.value = "";
    }
  };

  const applyDiscoveredModels = (
    list: string[],
    metadata: Record<string, ProviderModelMetadata>,
    recommendedModel?: string,
  ) => {
    setModels(list);
    setModelMetadata(metadata);
    setDefaultModel((current) =>
      list.includes(current)
        ? current
        : recommendedModel && list.includes(recommendedModel)
          ? recommendedModel
          : (list[0] ?? ""),
    );
    setModelsStale(false);
  };

  const markDiscoveryStale = () => {
    setModelsStale(true);
    setConnectionNotice({
      message: "Connection settings changed. Discover models again before saving.",
      error: true,
    });
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await providersApi.test(buildDraft(), keyDraft.trim() || undefined);
      applyDiscoveredModels(result.models, result.modelMetadata, result.recommendedModel);
      if (result.models.length > 0) {
        setConnectionNotice({
          message: `${result.modelCount} model${result.modelCount === 1 ? "" : "s"} found. Save to use them.`,
          error: false,
        });
        toast.success(
          `Endpoint reached — ${result.modelCount} model${result.modelCount === 1 ? "" : "s"} loaded. Save to use them.`,
        );
      } else {
        const message =
          "Endpoint reached, but no models were found. Load one in the server, then discover models again.";
        setConnectionNotice({ message, error: false });
        toast.info(message);
      }
    } catch (error) {
      const message = `Couldn't reach this endpoint: ${error instanceof Error ? error.message : String(error)}`;
      setConnectionNotice({ message, error: true });
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (modelsStale) {
      const message = "Connection settings changed. Discover models again before saving.";
      setConnectionNotice({ message, error: true });
      toast.error(message);
      return;
    }
    setSaving(true);
    try {
      await providersApi.save(buildDraft(), keyDraft.trim() || undefined);
      if (models.length === 0) {
        toast.info("Saved without models. Discover models before sending a chat.");
      }
      onSaved();
      onOpenChange(false);
    } catch (error) {
      const message = `Couldn't save provider: ${error instanceof Error ? error.message : String(error)}`;
      setConnectionNotice({ message, error: true });
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Configure ${provider.label}`}
      description="Set the connection details and models for this custom endpoint."
      size="large"
      confirmLabel="Save"
      confirmDisabled={saving || testing}
      onConfirm={handleSave}
      returnFocus={returnFocus}
    >
      <FieldSet>
        <Field label="Name">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>

        <Field
          label="Provider icon"
          description="Choose a PNG or SVG up to 512 KB. Aiden normalizes it locally and shares only the bounded PNG with paired iOS devices."
        >
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
              <ProviderIcon
                providerId={provider.id}
                providerLabel={label.trim() || provider.label}
                artwork={artwork}
                className="size-6"
              />
            </span>
            <input
              ref={artworkInputRef}
              type="file"
              accept="image/png,image/svg+xml,.png,.svg"
              className="sr-only"
              aria-label="Choose provider icon"
              disabled={artworkBusy}
              onChange={(event) => void chooseArtwork(event.target.files?.[0])}
            />
            <Button
              type="button"
              variant="muted"
              size="small"
              disabled={artworkBusy}
              onClick={() => artworkInputRef.current?.click()}
            >
              {artworkBusy ? "Normalizing…" : artwork ? "Replace" : "Choose image"}
            </Button>
            {artwork ? (
              <Button
                type="button"
                variant="transparent"
                size="small"
                disabled={artworkBusy}
                onClick={() => setArtwork(undefined)}
              >
                Use default
              </Button>
            ) : null}
          </div>
        </Field>

        <Field
          label="Base URL"
          description={
            isTailnetEndpoint(baseUrl)
              ? "Private Tailnet address. HTTP and HTTPS are supported; Tailscale encrypts traffic between devices."
              : "Base address of an OpenAI- or Anthropic-compatible API."
          }
        >
          <Input
            value={baseUrl}
            disabled={testing}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              markDiscoveryStale();
            }}
            placeholder="https://api.example.com/v1"
          />
        </Field>

        <Field label="API format">
          <Select
            value={kind}
            disabled={testing}
            onValueChange={(v) => {
              setKind(v as ProviderKind);
              markDiscoveryStale();
            }}
          >
            <SelectTrigger size="small">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">OpenAI-compatible</SelectItem>
              <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Deployment"
          description={
            deployment === "local"
              ? "Aiden shows model-loading status and treats usage as on-device when this device (or a marked private host) serves the model."
              : "Hosted cloud APIs skip local model-loading status and may track usage cost when available."
          }
        >
          <Select
            value={deployment}
            disabled={testing}
            onValueChange={(value) => {
              setDeployment(value as ProviderDeployment);
            }}
          >
            <SelectTrigger size="small">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local</SelectItem>
              <SelectItem value="hosted">Hosted</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Authentication"
          description={
            needsKey
              ? "This endpoint requires an API key. It is encrypted on this device."
              : isTailnetEndpoint(baseUrl)
                ? "Tailscale controls network reachability. Add an API key only if this server requires one."
                : "No API key is requested or stored. Aiden sends no Authorization or API-key header."
          }
        >
          <Select
            value={needsKey ? "api-key" : "none"}
            disabled={testing}
            onValueChange={(value) => {
              setNeedsKey(value === "api-key");
              markDiscoveryStale();
            }}
          >
            <SelectTrigger size="small">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No authentication</SelectItem>
              <SelectItem value="api-key">API key</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {needsKey ? (
          <Field
            label="API key"
            description={
              provider.hasKey
                ? "A key is saved. Enter it again to test a changed endpoint; it will not be sent to a different address."
                : "Stored encrypted on this device."
            }
          >
            <Input
              type="password"
              value={keyDraft}
              disabled={testing}
              onChange={(e) => {
                setKeyDraft(e.target.value);
                markDiscoveryStale();
              }}
              placeholder={provider.hasKey ? "••••••••••••" : "Paste your API key"}
            />
          </Field>
        ) : null}

        <Field label="Connection">
          <div className="grid gap-2">
            <div className="flex gap-2">
              <Button
                size="small"
                variant="filled"
                onClick={handleTest}
                disabled={testing || saving}
              >
                {testing ? "Discovering…" : "Discover models"}
              </Button>
            </div>
            {connectionNotice ? (
              <Text
                variant="small"
                color={connectionNotice.error ? "red" : "tertiary"}
                as="p"
                role={connectionNotice.error ? "alert" : "status"}
                aria-live={connectionNotice.error ? "assertive" : "polite"}
              >
                {connectionNotice.message}
              </Text>
            ) : null}
          </div>
        </Field>

        {models.length > 0 ? (
          <Field label="Default model">
            <div className="grid gap-1.5">
              <Select
                value={defaultModel}
                onValueChange={setDefaultModel}
                disabled={settings.data === undefined}
              >
                <SelectTrigger size="small">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {defaultModelIsHidden ? (
                    <SelectItem value={defaultModel} disabled>
                      {resolveModelDisplay(
                        defaultModel,
                        modelMetadata[defaultModel]?.name
                          ? { name: modelMetadata[defaultModel].name }
                          : modelInfo.data?.[defaultModel],
                      ).label} <InlineMetadata>· Hidden</InlineMetadata>
                    </SelectItem>
                  ) : null}
                  {visibleDefaultModels.map((m) => (
                    <SelectItem key={m} value={m}>
                      {
                        resolveModelDisplay(
                          m,
                          modelMetadata[m]?.name
                            ? { name: modelMetadata[m].name }
                            : modelInfo.data?.[m],
                        ).label
                      }
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {usesArtificialAnalysis ? (
                <a
                  href="https://artificialanalysis.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="w-fit text-small text-tertiary underline decoration-separator underline-offset-2 hover:text-secondary"
                >
                  Model data · Artificial Analysis
                </a>
              ) : null}
            </div>
          </Field>
        ) : (
          <Text variant="small" color="tertiary">
            {`No models loaded. Discover models after entering a valid endpoint${needsKey ? " and API key." : "."}`}
          </Text>
        )}
      </FieldSet>

      {models.length > 0 ? (
        <div className="mt-4">
          <Text variant="small-strong" as="p">
            Model capabilities
          </Text>
          <Text variant="small" color="tertiary" as="p" className="mt-0.5">
            Capability hints bundled with this release. Check provider documentation for exact
            support.
          </Text>
          <div className="mt-2 max-h-64 overflow-y-auto rounded-card border border-separator">
            {models.map((m, i) => {
              const info = modelInfo.data?.[m];
              const display = resolveModelDisplay(m, info);
              const ctx = formatContext(info?.contextLength);
              return (
                <div
                  key={m}
                  className={`flex items-center gap-2 px-3 py-2 ${i > 0 ? "border-t border-separator" : ""}`}
                >
                  <Text variant="small" truncate className="min-w-0 flex-1" title={m}>
                    {display.label}
                  </Text>
                  {info?.matched ? (
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                      {info.vision ? <Badge color="blue">Vision</Badge> : null}
                      {info.toolCall ? <Badge color="green">Tools</Badge> : null}
                      {info.reasoning ? <Badge color="purple">Reasoning</Badge> : null}
                      {info.openWeights ? <Badge color="secondary">Open</Badge> : null}
                      {ctx ? <Badge color="secondary">{ctx}</Badge> : null}
                    </div>
                  ) : (
                    <Text variant="small" color="quaternary" className="shrink-0">
                      {modelInfo.isLoading ? "…" : "Unlisted"}
                    </Text>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      <ProviderModelVisibility provider={{ ...provider, models, modelMetadata }} />
    </Dialog>
  );
}
