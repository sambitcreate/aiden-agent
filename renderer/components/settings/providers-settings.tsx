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
  Separator,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "../ui";
import { ChevronDown, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { ProviderEditor } from "./provider-editor";
import { providersApi, settingsApi, titleProvidersApi } from "../../lib/ipc";
import { queryKeys, useFoundationModelsConnection, useProviders, useSettings } from "../../lib/queries";
import type { ChatTitleProviderId, FoundationModelsConnectionStatus, Provider } from "../../lib/types";

function statusBadge(p: Provider): React.ReactNode {
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

export function ProvidersSettings() {
  const qc = useQueryClient();
  const providers = useProviders();
  const settings = useSettings();
  const foundationModels = useFoundationModelsConnection();
  const [editing, setEditing] = React.useState<Provider | null>(null);
  const [removing, setRemoving] = React.useState<Provider | null>(null);
  const [savingTitleProvider, setSavingTitleProvider] = React.useState(false);
  const [refreshingFoundationModels, setRefreshingFoundationModels] = React.useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.providers });
  const list = providers.data ?? [];
  const titleProviderId = settings.data?.chatTitleProviderId ?? "automatic";

  const setTitleProvider = async (value: ChatTitleProviderId) => {
    setSavingTitleProvider(true);
    try {
      await settingsApi.set({ chatTitleProviderId: value });
      await qc.invalidateQueries({ queryKey: queryKeys.settings });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save the chat title provider.");
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
      toast.error(error instanceof Error ? error.message : "Couldn't refresh Apple Foundation Models.");
    } finally {
      setRefreshingFoundationModels(false);
    }
  };

  const addCustom = (template: "custom" | "tailnet") => {
    const id = `custom-${Date.now().toString(36)}`;
    setEditing({
      id,
      kind: "openai",
      label: template === "tailnet" ? "Tailscale model server" : "Custom Provider",
      baseUrl:
        template === "tailnet"
          ? "https://your-machine.your-tailnet.ts.net/v1"
          : "http://localhost:8000/v1",
      models: [],
      // A user may opt into API-key auth in the editor. Tailscale controls
      // reachability, not whether an application-layer key is required.
      needsKey: false,
      isPreset: false,
      hasKey: false,
    });
  };

  const configurePreset = (id: string) => {
    const preset = list.find((provider) => provider.id === id);
    if (preset) setEditing(preset);
  };

  const confirmRemove = async () => {
    if (!removing) return;
    await providersApi.remove(removing.id);
    await invalidate();
    setRemoving(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Text variant="strong">Providers</Text>
          <Text variant="small" color="secondary" className="mt-0.5 block">
            Use hosted APIs or local/private models. Messages and attachments go to the selected
            provider; API keys, when you add one, stay encrypted on this Mac.
          </Text>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="shrink-0" variant="filled" size="small">
              <Plus className="size-4" />
              Add provider
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Local model servers</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={!list.some((provider) => provider.id === "lmstudio")}
              onSelect={() => configurePreset("lmstudio")}
            >
              <span className="flex min-w-0 flex-col">
                <span>LM Studio</span>
                <span className="text-small text-tertiary">
                  Configure the built-in localhost connection
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!list.some((provider) => provider.id === "ollama")}
              onSelect={() => configurePreset("ollama")}
            >
              <span className="flex min-w-0 flex-col">
                <span>Ollama</span>
                <span className="text-small text-tertiary">
                  Configure the built-in localhost connection
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Private or custom</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => addCustom("tailnet")}>
              <span className="flex min-w-0 flex-col">
                <span>Model server over Tailscale</span>
                <span className="text-small text-tertiary">
                  OpenAI-compatible, no authentication by default
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addCustom("custom")}>
              <span className="flex min-w-0 flex-col">
                <span>Other custom endpoint</span>
                <span className="text-small text-tertiary">Choose protocol and authentication</span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {foundationModels.data ? (
        <div
          className="rounded-card border border-separator"
          aria-busy={refreshingFoundationModels}
        >
          <div className="flex items-start gap-3 px-3.5 py-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-subtle text-secondary">
              <Sparkles className="size-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Text variant="strong">Apple Foundation Models</Text>
                <Badge color="blue">On-device</Badge>
                {foundationModelsBadge(foundationModels.data)}
              </div>
              <div aria-live="polite">
                <Text variant="small" color="tertiary" className="mt-1 block">
                  {foundationModels.data.detail}
                </Text>
              </div>
              <Text variant="small" color="secondary" className="mt-1 block">
                This native connection is used only for background chat titles and never appears in
                the chat model picker.
              </Text>
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
          <Separator />
          <div className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <Text variant="small-strong" as="p">Chat title provider</Text>
              <Text variant="small" color="tertiary" as="p" className="mt-0.5">
                Automatic prefers this Mac, then uses the selected chat model only when Apple is
                unavailable. On-device only never falls back to a network provider.
              </Text>
            </div>
            <Select
              value={titleProviderId}
              disabled={savingTitleProvider}
              onValueChange={(value) => void setTitleProvider(value as ChatTitleProviderId)}
            >
              <SelectTrigger size="small" className="w-full shrink-0 sm:w-48" aria-label="Chat title provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="automatic">Automatic</SelectItem>
                <SelectItem value="apple-foundation-models">On-device only</SelectItem>
                <SelectItem value="chat-model">Selected chat model</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      <div className="rounded-card border border-separator">
        {list.map((p, i) => (
          <React.Fragment key={p.id}>
            {i > 0 ? <Separator /> : null}
            <div className="flex items-center gap-3 px-3.5 py-3">
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
              <Button variant="filled" size="small" onClick={() => setEditing(p)}>
                Configure
              </Button>
              {!p.isPreset ? (
                <Button
                  variant="transparent"
                  size="small"
                  iconOnly
                  aria-label="Remove provider"
                  onClick={() => setRemoving(p)}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </div>
          </React.Fragment>
        ))}
      </div>

      {editing ? (
        <ProviderEditor
          provider={editing}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={invalidate}
        />
      ) : null}

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
