import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button, Input, Switch, Text, toast } from "../ui";
import { settingsApi } from "../../lib/ipc";
import { createModelEntries } from "../../lib/model-picker-data";
import { queryKeys, useSettings } from "../../lib/queries";
import type { AppSettings, Provider } from "../../lib/types";
import { isModelHidden } from "../../shared/model-visibility";

export function ProviderModelVisibility({ provider }: { provider: Provider }) {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const [query, setQuery] = React.useState("");
  const [pendingModel, setPendingModel] = React.useState<string>();
  const [showingAll, setShowingAll] = React.useState(false);
  const entries = React.useMemo(() => createModelEntries([provider]), [provider]);
  const hidden = settings.data?.hiddenModelsByProvider;
  const hiddenCount = entries.filter((entry) =>
    isModelHidden(hidden, provider.id, entry.model),
  ).length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? entries.filter((entry) =>
        `${entry.label} ${entry.model}`.toLocaleLowerCase().includes(normalizedQuery),
      )
    : entries;

  const cache = (saved: AppSettings) => {
    queryClient.setQueryData(queryKeys.settings, saved);
  };

  const setVisible = async (modelId: string, visible: boolean) => {
    setPendingModel(modelId);
    try {
      cache(await settingsApi.setModelVisibility(provider.id, modelId, !visible));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update model visibility.");
    } finally {
      setPendingModel(undefined);
    }
  };

  const showAll = async () => {
    setShowingAll(true);
    try {
      cache(await settingsApi.showAllProviderModels(provider.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't show all models.");
    } finally {
      setShowingAll(false);
    }
  };

  if (entries.length === 0) return null;

  return (
    <section
      className="mt-4 border-t border-separator pt-4"
      aria-labelledby={`model-visibility-${provider.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Text id={`model-visibility-${provider.id}`} variant="small-strong" as="h3">
            Model visibility
          </Text>
          <Text variant="small" color="tertiary" as="p" className="mt-0.5">
            Hidden models stay configured and keep working in existing chats, but disappear from
            model pickers on this Mac and paired Aiden clients.
          </Text>
        </div>
        {hiddenCount > 0 ? (
          <Button size="small" variant="muted" disabled={showingAll} onClick={() => void showAll()}>
            {showingAll ? "Showing…" : "Show all"}
          </Button>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          aria-label={`Search ${provider.label} models`}
        />
        <Text variant="small" color="tertiary" className="shrink-0 tabular-nums">
          {entries.length - hiddenCount} shown · {hiddenCount} hidden
        </Text>
      </div>

      <div className="mt-2 max-h-72 overflow-y-auto rounded-card border border-separator">
        {filtered.length > 0 ? (
          filtered.map((entry, index) => {
            const visible = !isModelHidden(hidden, provider.id, entry.model);
            return (
              <label
                key={entry.value}
                className={`flex min-h-11 items-center gap-3 px-3 py-2 ${index > 0 ? "border-t border-separator" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <Text variant="small" as="span" truncate title={entry.model}>
                    {entry.label}
                  </Text>
                  {entry.label !== entry.model ? (
                    <Text
                      variant="small"
                      color="tertiary"
                      as="span"
                      truncate
                      className="mt-0.5 block text-[11px]"
                      title={entry.model}
                    >
                      {entry.model}
                    </Text>
                  ) : null}
                </span>
                <Switch
                  checked={visible}
                  disabled={pendingModel === entry.model || showingAll}
                  onCheckedChange={(checked) => void setVisible(entry.model, checked)}
                  aria-label={`${visible ? "Hide" : "Show"} ${entry.label} in model pickers`}
                />
              </label>
            );
          })
        ) : (
          <Text variant="small" color="tertiary" as="p" className="px-3 py-4 text-center">
            No matching models.
          </Text>
        )}
      </div>
    </section>
  );
}
