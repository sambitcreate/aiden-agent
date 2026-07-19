// Dialog to configure one provider: base URL, API key, connection test, model
// discovery, and default model. Used for both presets and custom providers.

import * as React from "react";
import {
  Badge,
  Button,
  Dialog,
  Field,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "../ui";
import { providersApi } from "../../lib/ipc";
import { useModelInfo } from "../../lib/queries";
import type { Provider, ProviderKind } from "../../lib/types";

/** Compact k-token label, e.g. 128000 → "128K". */
function formatContext(n: number | undefined): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

interface ProviderEditorProps {
  provider: Provider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function ProviderEditor({ provider, open, onOpenChange, onSaved }: ProviderEditorProps) {
  const [label, setLabel] = React.useState(provider.label);
  const [baseUrl, setBaseUrl] = React.useState(provider.baseUrl);
  const [kind, setKind] = React.useState<ProviderKind>(provider.kind);
  const [keyDraft, setKeyDraft] = React.useState("");
  const [models, setModels] = React.useState<string[]>(provider.models);
  const [defaultModel, setDefaultModel] = React.useState(provider.defaultModel ?? provider.models[0] ?? "");
  const [testing, setTesting] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const modelInfo = useModelInfo(provider.id, models);

  // Reset drafts whenever a different provider is opened.
  React.useEffect(() => {
    if (open) {
      setLabel(provider.label);
      setBaseUrl(provider.baseUrl);
      setKind(provider.kind);
      setKeyDraft("");
      setModels(provider.models);
      setDefaultModel(provider.defaultModel ?? provider.models[0] ?? "");
    }
  }, [open, provider]);

  const persistKeyIfNeeded = async () => {
    if (keyDraft.trim()) {
      await providersApi.setKey(provider.id, keyDraft.trim());
    }
  };

  const buildDraft = (): Omit<Provider, "hasKey"> => ({
    id: provider.id,
    kind,
    label: label.trim() || provider.label,
    baseUrl: baseUrl.trim() || provider.baseUrl,
    models,
    defaultModel: defaultModel || undefined,
    needsKey: provider.needsKey,
    isPreset: provider.isPreset,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await providersApi.test(buildDraft(), keyDraft.trim() || undefined);
      toast.success(`Connected — ${result.modelCount} model${result.modelCount === 1 ? "" : "s"} available.`);
    } catch (error) {
      toast.error(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleRefreshModels = async () => {
    setRefreshing(true);
    try {
      const list = await providersApi.listModels(buildDraft(), keyDraft.trim() || undefined);
      setModels(list);
      if (!list.includes(defaultModel)) setDefaultModel(list[0] ?? "");
      toast.success(`Loaded ${list.length} model${list.length === 1 ? "" : "s"}.`);
    } catch (error) {
      toast.error(`Couldn't load models: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSave = async () => {
    await persistKeyIfNeeded();
    await providersApi.save(buildDraft());
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Configure ${provider.label}`}
      size="large"
      confirmLabel="Save"
      onConfirm={handleSave}
    >
      <FieldSet>
        <Field label="Name">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>

        <Field label="Base URL" description={provider.isPreset ? "Base address used for API requests." : "Base address of an OpenAI- or Anthropic-compatible API."}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
        </Field>

        {!provider.isPreset ? (
          <Field label="API format">
            <Select value={kind} onValueChange={(v) => setKind(v as ProviderKind)}>
              <SelectTrigger size="small">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI-compatible</SelectItem>
                <SelectItem value="anthropic">Anthropic-compatible</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {provider.needsKey ? (
          <Field
            label="API key"
            description={provider.hasKey ? "A key is saved. Enter a new value to replace it." : "Stored encrypted on this device."}
          >
            <Input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={provider.hasKey ? "••••••••••••" : "Paste your API key"}
            />
          </Field>
        ) : null}

        <Field label="Connection">
          <div className="flex gap-2">
            <Button size="small" variant="filled" onClick={handleTest} disabled={testing}>
              {testing ? "Testing…" : "Test"}
            </Button>
            <Button size="small" variant="filled" onClick={handleRefreshModels} disabled={refreshing}>
              {refreshing ? "Loading…" : "Refresh models"}
            </Button>
          </div>
        </Field>

        {models.length > 0 ? (
          <Field label="Default model">
            <Select value={defaultModel} onValueChange={setDefaultModel}>
              <SelectTrigger size="small">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <Text variant="small" color="tertiary">
            No models loaded. Refresh models after entering a valid endpoint and API key.
          </Text>
        )}
      </FieldSet>

      {models.length > 0 ? (
        <div className="mt-4">
          <Text variant="small-strong" as="p">
            Model capabilities
          </Text>
          <Text variant="small" color="tertiary" as="p" className="mt-0.5">
            Capability hints from models.dev. Check provider documentation for exact support.
          </Text>
          <div className="mt-2 max-h-64 overflow-y-auto rounded-card border border-separator">
            {models.map((m, i) => {
              const info = modelInfo.data?.[m];
              const ctx = formatContext(info?.contextLength);
              return (
                <div
                  key={m}
                  className={`flex items-center gap-2 px-3 py-2 ${i > 0 ? "border-t border-separator" : ""}`}
                >
                  <Text variant="small" truncate className="min-w-0 flex-1">
                    {m}
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
    </Dialog>
  );
}
