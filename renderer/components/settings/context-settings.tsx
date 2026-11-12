// The context half of Settings → Context & Limits. Each group saves on its own,
// so a change in one is never dropped while another is still saving.
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Field, FieldSet, RadioGroup, RadioGroupItem, Switch, Text, toast } from "../ui";
import { InfoHint } from "../ui-info-hint";
import { providersApi, settingsApi } from "../../lib/ipc";
import { queryKeys, useProviders, useSettings } from "../../lib/queries";
import type { AppSettings } from "../../lib/types";
import { compactionEngineFrom, type CompactionEngine, type CompactionModelBudget } from "../../shared/compaction";
import { CompactionBudgetSettings } from "./compaction-budget-settings";

const ENGINES = [
  ["llm", "LLM Compaction", "Uses your chat model to summarize older context. Takes time and uses model tokens."],
  [
    "vcc",
    "pi-vcc Compaction — Experimental",
    "Compacts locally without a summarization call. Preserves selected excerpts and retrieves earlier details when needed.",
  ],
] as const;

export function AutomaticCompactionGroup() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const engine = compactionEngineFrom(settings.data?.compactionEngine);

  const setEngine = async (next: CompactionEngine) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await settingsApi.set({ compactionEngine: next });
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
    } catch {
      toast.error("Couldn't update automatic compaction.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <FieldSet
      title="Automatic compaction"
      hint={(
        <InfoHint topic="automatic compaction">
          Applies to new runs and /compact. Try /compact-LLM or /compact-VCC in an idle chat for a one-time override.
        </InfoHint>
      )}
    >
      <RadioGroup
        orientation="vertical"
        aria-label="Automatic compaction engine"
        value={engine}
        onValueChange={(value) => void setEngine(compactionEngineFrom(value))}
        disabled={settings.isLoading}
        aria-busy={saving}
        className="gap-1 p-2"
      >
        {ENGINES.map(([value, label, description]) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg p-3 transition-colors hover:bg-control-hover ${engine === value ? "bg-control" : ""}`}
          >
            <RadioGroupItem
              value={value}
              aria-label={label}
              className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
            />
            <span className="flex flex-col gap-1">
              <Text>{label}</Text>
              <Text as="span" variant="small" color="secondary">
                {description}
              </Text>
            </span>
          </label>
        ))}
      </RadioGroup>
      <Text as="p" variant="small" color="secondary" className="px-4 pb-4 text-pretty">
        Local compaction can omit details, which Aiden can retrieve from the current chat. That
        context may be sent to your chat model when the conversation continues. Current-chat
        recall works even when Memory is off.
      </Text>
      <Text as="p" variant="small" color="secondary" className="px-4 pb-4 text-pretty">
        When you come back to a chat over 100K tokens after its prompt cache expired, pi-vcc
        compacts it right away. With LLM Compaction, Aiden asks “Compact first?” instead, since
        summarizing uses model tokens.
      </Text>
    </FieldSet>
  );
}

export function PromptCacheGroup() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);

  const setWarmingEnabled = async (enabled: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await settingsApi.set({ cacheWarmingEnabled: enabled });
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
    } catch {
      toast.error("Couldn’t update cache warming.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <FieldSet title="Prompt cache">
      <Field
        label="Warm caches during active chats"
        description="Optional paid one-token requests keep an eligible provider cache warm during long agent runs in Aiden Agent. Off by default; starts with your next chat run and stops when the run ends."
      >
        <Switch
          aria-label="Warm prompt caches during active chats"
          checked={settings.data?.cacheWarmingEnabled === true}
          disabled={settings.isLoading || saving}
          onCheckedChange={(enabled) => void setWarmingEnabled(enabled)}
        />
      </Field>
      <Text as="p" variant="small" color="secondary" className="px-4 pb-4 text-pretty">
        Only refreshes when provider-reported usage and known pricing estimate at least $0.05 in savings. Charges appear
        in Usage. Stops after one hour, on cancellation, or when switched off. Does not warm idle chats, Bots, scheduled
        tasks, or subagents.
      </Text>
    </FieldSet>
  );
}

export function CompactionBudgetGroup() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const providers = useProviders();
  // Reuse Codex models already in the query cache without triggering an auth
  // status request just because this page opened or regained focus.
  const codexModels = useQuery({
    queryKey: queryKeys.codexProviderStatus,
    queryFn: () => providersApi.authStatus("openai-codex"),
    enabled: false,
  }).data?.models;
  const modelKeys = React.useMemo(
    () => [
      ...(providers.data ?? []).flatMap((provider) => provider.models.map((model) => `${provider.id}/${model}`)),
      ...(codexModels ?? []).map((model) => `openai-codex/${model.id}`),
    ],
    [providers.data, codexModels],
  );

  return (
    <CompactionBudgetSettings
      overrides={settings.data?.compactionModelOverrides ?? {}}
      modelKeys={modelKeys}
      disabled={settings.isLoading}
      onSave={async (modelKey: string, budget: CompactionModelBudget | undefined) => {
        const saved = await settingsApi.setCompactionModelBudget(modelKey, budget ?? null);
        queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
      }}
    />
  );
}
