// On-device model management subview: search, download/delete, and activate
// Parakeet transcription models. Downloaded models sit above available ones,
// each showing accuracy/speed, size, quant, and languages.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Input, Separator, Text, toast } from "@glaze/core/components";
import { cn } from "@glaze/core/utils";
import { Check, ChevronLeft, Download, Globe, Loader2, Trash2 } from "lucide-react";
import { localVoiceApi, settingsApi } from "../../lib/ipc";
import type { ModelDownloadProgress } from "../../lib/ipc";
import { onNotification } from "../../lib/ipc";
import { queryKeys, useLocalModels, useSettings } from "../../lib/queries";
import type { LocalVoiceModel } from "../../lib/types";

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <Text variant="small" color="tertiary" className="w-14 shrink-0 text-right">
        {label}
      </Text>
      <div className="h-1.5 flex-1 overflow-hidden rounded-pill bg-well">
        <div className="h-full rounded-pill bg-accent" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

function DownloadProgress({ percentage, phase }: { percentage: number; phase: "download" | "extract" }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-pill bg-well">
        <div
          className="h-full rounded-pill bg-accent transition-[width] duration-150"
          style={{ width: `${Math.max(0, Math.min(100, percentage))}%` }}
        />
      </div>
      <Text variant="small" color="tertiary" className="tabular-nums">
        {phase === "extract" ? "Extracting…" : "Downloading…"} {percentage}%
      </Text>
    </div>
  );
}

interface CardProps {
  model: LocalVoiceModel;
  active: boolean;
  progress?: ModelDownloadProgress;
  busy?: "download" | "delete";
  onDownload: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onActivate: (id: string) => void;
}

function ModelCard({ model, active, progress, busy, onDownload, onCancel, onDelete, onActivate }: CardProps) {
  return (
    <div className={cn("flex flex-col gap-2.5 rounded-card border p-3", active ? "border-accent" : "border-field")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Text variant="small-strong">{model.name}</Text>
            {active ? (
              <Badge color="green">
                <Check className="size-3" />
                Active
              </Badge>
            ) : null}
            {model.recommended && !model.installed ? <Badge color="blue">Recommended</Badge> : null}
          </div>
          <Text variant="small" color="tertiary">
            {model.description}
          </Text>
        </div>
        <div className="flex w-36 shrink-0 flex-col gap-1">
          <Meter label="accuracy" value={model.accuracy} />
          <Meter label="speed" value={model.speed} />
        </div>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <Globe className="size-3.5 text-tertiary" />
            <Text variant="small" color="tertiary">
              {model.languagesLabel}
            </Text>
          </span>
          <Text variant="small" color="tertiary" className="tabular-nums">
            {model.sizeLabel} · {model.quant}
          </Text>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {busy === "download" ? (
            <Button size="small" variant="transparent" onClick={() => onCancel(model.id)}>
              Cancel
            </Button>
          ) : model.installed ? (
            <>
              {active ? null : (
                <Button size="small" variant="filled" onClick={() => onActivate(model.id)}>
                  Use
                </Button>
              )}
              <Button
                size="small"
                variant="transparent"
                iconOnly
                disabled={busy === "delete"}
                onClick={() => onDelete(model.id)}
                aria-label={`Delete ${model.name}`}
              >
                {busy === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 className="text-support-red" />}
              </Button>
            </>
          ) : (
            <Button size="small" variant="filled" onClick={() => onDownload(model.id)}>
              <Download />
              Download
            </Button>
          )}
        </div>
      </div>

      {busy === "download" ? (
        <DownloadProgress percentage={progress?.percentage ?? 0} phase={progress?.phase ?? "download"} />
      ) : null}
    </div>
  );
}

export function ModelManagerView({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const models = useLocalModels();
  const settings = useSettings();
  const activeModel = settings.data?.localVoiceModel ?? "";
  const [query, setQuery] = React.useState("");
  const [progress, setProgress] = React.useState<Record<string, ModelDownloadProgress>>({});
  const [busy, setBusy] = React.useState<Record<string, "download" | "delete">>({});

  React.useEffect(() => {
    return onNotification<ModelDownloadProgress>("localModels:progress", (p) => {
      setProgress((prev) => ({ ...prev, [p.id]: p }));
    });
  }, []);

  const clearBusy = (id: string) =>
    setBusy((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const activate = async (id: string) => {
    await settingsApi.set({ localVoiceModel: id, voiceProvider: "local" });
    await qc.invalidateQueries({ queryKey: queryKeys.settings });
  };

  const download = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: "download" }));
    setProgress((p) => ({ ...p, [id]: { id, downloaded: 0, total: 0, percentage: 0, phase: "download" } }));
    try {
      await localVoiceApi.downloadModel(id);
      await qc.invalidateQueries({ queryKey: queryKeys.localModels });
      // Auto-select the first model the user installs.
      if (!activeModel) await activate(id);
      toast.success("Model downloaded.");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!/cancel/i.test(msg)) toast.error(msg);
    } finally {
      clearBusy(id);
      setProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const remove = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: "delete" }));
    try {
      await localVoiceApi.deleteModel(id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.localModels }),
        qc.invalidateQueries({ queryKey: queryKeys.settings }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      clearBusy(id);
    }
  };

  const all = models.data ?? [];
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter((m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
    : all;
  const downloaded = filtered.filter((m) => m.installed);
  const available = filtered.filter((m) => !m.installed);

  const renderCard = (m: LocalVoiceModel) => (
    <ModelCard
      key={m.id}
      model={m}
      active={m.id === activeModel}
      progress={progress[m.id]}
      busy={busy[m.id]}
      onDownload={(id) => void download(id)}
      onCancel={(id) => void localVoiceApi.cancelDownload(id)}
      onDelete={(id) => void remove(id)}
      onActivate={(id) => void activate(id)}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button size="small" variant="transparent" onClick={onBack}>
          <ChevronLeft className="size-4" />
          Back
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <Text variant="heading1">Transcription Models</Text>
        <Text variant="small" color="tertiary">
          Download and manage on-device models. Everything runs locally — no audio leaves your Mac.
        </Text>
      </div>

      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models by name…" />

      {downloaded.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Text variant="small-strong" color="secondary">
            Downloaded Models
          </Text>
          {downloaded.map(renderCard)}
        </div>
      ) : null}

      {available.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Text variant="small-strong" color="secondary">
            Available to Download
          </Text>
          {available.map(renderCard)}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <Text variant="small" color="tertiary">
          No models match “{query}”.
        </Text>
      ) : null}
    </div>
  );
}
