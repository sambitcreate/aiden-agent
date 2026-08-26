import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  HardDrive,
  Loader2,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Volume2,
  VolumeX,
} from "lucide-react";

import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Field,
  FieldSet,
  Input,
  Range,
  Separator,
  Switch,
  Text,
  toast,
} from "../ui";
import { ambientMusicApi, settingsApi } from "../../lib/ipc";
import { queryKeys, useAmbientMusic, useSettings } from "../../lib/queries";
import { cn } from "../../lib/ui-utils";
import {
  activeAmbientMusicPrompts,
  ambientMusicPromptError,
  ambientMusicRowsMatchAppliedMix,
  LatestAmbientMusicControl,
  normalizeAmbientMusicPrompts as normalizePrompts,
  OrderedAmbientMusicPersistence,
  setAmbientMusicPromptWeight as setPromptWeight,
} from "../../lib/ambient-music-control";
import type { AppSettings } from "../../lib/types";
import {
  DEFAULT_AMBIENT_MUSIC_CONFIG,
  parseAmbientMusicConfig,
  type AmbientMusicConfigV1,
  type AmbientMusicFeatureSnapshot,
  type AmbientMusicModelId,
  type AmbientMusicModelStatus,
  type AmbientMusicPromptStyle,
} from "../../shared/ambient-music";
import { AmbientMusicVisualizer } from "./ambient-music-visualizer";

const MODEL_TERMS_URL = "https://huggingface.co/google/magenta-realtime-2";
const PROMPT_LIMIT = 6;

type BusyOperation =
  | `download:${AmbientMusicModelId}`
  | `remove:${AmbientMusicModelId}`
  | `switch:${AmbientMusicModelId}`
  | "apply"
  | "playback"
  | "benchmark"
  | null;

function cloneConfig(config: AmbientMusicConfigV1): AmbientMusicConfigV1 {
  return { ...config, prompts: config.prompts.map((prompt) => ({ ...prompt })) };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[power]}`;
}

function supportCopy(snapshot: AmbientMusicFeatureSnapshot | undefined): string {
  if (!snapshot || snapshot.supported) return "";
  if (snapshot.supportReason === "requires_apple_silicon") {
    return "Ambient Music requires a Mac with Apple silicon.";
  }
  if (snapshot.supportReason === "requires_macos_14") {
    return "Ambient Music requires macOS 14 or later.";
  }
  return "Ambient Music is available on supported Apple silicon Macs.";
}

function modelDescription(model: AmbientMusicModelId): string {
  return model === "mrt2_small"
    ? "Responsive on-device generation for any supported Apple silicon Mac."
    : "Higher-capacity generation for faster Macs after a local real-time benchmark.";
}

function modelBadge(status: AmbientMusicModelStatus): React.ReactNode {
  if (status.state === "ready") return <Badge color="green">Ready</Badge>;
  if (status.state === "needs_repair") return <Badge color="red">Repair needed</Badge>;
  if (status.state === "failed") return <Badge color="red">Download failed</Badge>;
  if (status.state === "verifying") return <Badge>Verifying</Badge>;
  if (status.state === "downloading") return <Badge color="blue">Downloading</Badge>;
  return null;
}

function AmbientMusicHeading() {
  return (
    <div className="mb-5 flex flex-col gap-1 px-1">
      <div className="flex items-center gap-2">
        <Music2 className="size-5 text-accent" />
        <Text as="h1" variant="heading1">Ambient Music</Text>
        <Badge color="blue">Experimental</Badge>
      </div>
      <Text as="p" variant="small" color="tertiary" className="max-w-xl">
        Generate an endless instrumental soundtrack on your Mac. Audio and prompts stay on-device after the model is downloaded.
      </Text>
    </div>
  );
}

function ProgressBar({ status }: { status: AmbientMusicModelStatus }) {
  const progress = status.progress;
  if (!progress) return null;
  const percentage = progress.totalBytes > 0
    ? Math.max(0, Math.min(100, (progress.downloadedBytes / progress.totalBytes) * 100))
    : 0;
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div
        className="h-1.5 overflow-hidden rounded-pill bg-control"
        role="progressbar"
        aria-label={`${status.label} download progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percentage)}
      >
        <div
          className="h-full rounded-pill bg-accent transition-[width] duration-150 motion-reduce:transition-none"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <Text variant="small" color="tertiary" className="tabular-nums">
        {status.state === "verifying" ? "Verifying files" : `${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}`}
        {progress.fileCount > 0 ? ` · file ${progress.currentFile} of ${progress.fileCount}` : ""}
      </Text>
    </div>
  );
}

interface ModelCardProps {
  status: AmbientMusicModelStatus;
  selected: boolean;
  termsAccepted: boolean;
  basePassed: boolean;
  busy: BusyOperation;
  disabled: boolean;
  removeDisabled: boolean;
  onSelect(): void;
  onDownload(repair: boolean): void;
  onCancel(): void;
  onRemove(): void;
  onBenchmark(): void;
  cardRef?(node: HTMLDivElement | null): void;
}

function ModelCard({
  status,
  selected,
  termsAccepted,
  basePassed,
  busy,
  disabled,
  removeDisabled,
  onSelect,
  onDownload,
  onCancel,
  onRemove,
  onBenchmark,
  cardRef,
}: ModelCardProps) {
  const downloading = status.state === "downloading" || status.state === "verifying";
  const downloadBusy = busy === `download:${status.model}`;
  const removable = status.installedBytes > 0 || status.state === "ready" || status.state === "needs_repair";
  const needsRepair = status.state === "needs_repair";
  const baseNeedsBenchmark = status.model === "mrt2_base" && status.state === "ready" && !basePassed;

  return (
    <div ref={cardRef} className={cn("rounded-card border p-3", selected ? "border-accent bg-accent/5" : "border-field")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Text variant="small-strong">{status.label}</Text>
            {status.recommended ? <Badge color="blue">Recommended</Badge> : null}
            {selected ? <Badge color="green">Selected</Badge> : null}
            {modelBadge(status)}
          </div>
          <Text as="p" variant="small" color="tertiary" className="mt-1">
            {modelDescription(status.model)}
          </Text>
        </div>
        <Text variant="small" color="tertiary" className="shrink-0 tabular-nums">
          {status.state === "ready"
            ? `${formatBytes(status.reclaimableBytes)} removable`
            : `${formatBytes(status.additionalDownloadBytes)} download`}
        </Text>
      </div>

      {status.error ? (
        <Text as="p" variant="small" color="red" className="mt-2">
          {status.error.message}
        </Text>
      ) : null}
      <ProgressBar status={status} />

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {downloading || downloadBusy ? (
          <Button size="small" variant="transparent" disabled={busy === "playback"} onClick={onCancel}>
            Cancel
          </Button>
        ) : status.state === "ready" ? (
          <>
            {baseNeedsBenchmark ? (
              <Button size="small" variant="filled" disabled={disabled || busy !== null} onClick={onBenchmark}>
                {busy === "benchmark" ? <Loader2 className="animate-spin" /> : <SlidersHorizontal />}
                Run benchmark
              </Button>
            ) : selected ? null : (
              <Button size="small" variant="filled" disabled={disabled || busy !== null} onClick={onSelect}>
                Use
              </Button>
            )}
            <Button
              size="small"
              variant="transparent"
              iconOnly
              disabled={removeDisabled || busy !== null}
              onClick={onRemove}
              aria-label={`Remove ${status.label}`}
            >
              <Trash2 className="text-support-red" />
            </Button>
          </>
        ) : (
          <Button
            size="small"
            variant="filled"
            disabled={disabled || busy !== null || !termsAccepted}
            onClick={() => onDownload(needsRepair)}
          >
            {downloadBusy ? <Loader2 className="animate-spin" /> : <Download />}
            {needsRepair ? "Repair" : status.state === "failed" ? "Retry" : "Download"}
          </Button>
        )}
        {removable && status.state !== "ready" && !downloading ? (
          <Button
            size="small"
            variant="transparent"
            iconOnly
            disabled={removeDisabled || busy !== null}
            onClick={onRemove}
            aria-label={`Remove ${status.label}`}
          >
            <Trash2 className="text-support-red" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function AmbientMusicSettings() {
  const queryClient = useQueryClient();
  const ambient = useAmbientMusic();
  const settings = useSettings();
  const initialConfig = React.useMemo(
    () => parseAmbientMusicConfig(settings.data?.ambientMusic) ?? DEFAULT_AMBIENT_MUSIC_CONFIG,
    [settings.data?.ambientMusic],
  );
  const [config, setConfig] = React.useState(() => cloneConfig(initialConfig));
  const [draftPrompts, setDraftPrompts] = React.useState(() =>
    initialConfig.prompts.map((prompt) => ({ ...prompt })));
  const [initialized, setInitialized] = React.useState(settings.isSuccess);
  const [termsAccepted, setTermsAccepted] = React.useState(false);
  const [busy, setBusy] = React.useState<BusyOperation>(null);
  const [removing, setRemoving] = React.useState<AmbientMusicModelStatus | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");
  const [liveUpdateNotice, setLiveUpdateNotice] = React.useState<string | null>(null);
  const [saveNotice, setSaveNotice] = React.useState<string | null>(null);
  const promptRefs = React.useRef(new Map<string, HTMLInputElement>());
  const addPromptRef = React.useRef<HTMLButtonElement>(null);
  const resetButtonRef = React.useRef<HTMLButtonElement>(null);
  const modelCardRefs = React.useRef(new Map<AmbientMusicModelId, HTMLDivElement>());
  const removeReturnModel = React.useRef<AmbientMusicModelId | null>(null);
  const promptCounter = React.useRef(0);
  const lastAudibleVolume = React.useRef(DEFAULT_AMBIENT_MUSIC_CONFIG.volumeDb);
  const lastPlayback = React.useRef<AmbientMusicFeatureSnapshot["playback"] | undefined>(ambient.data?.playback);
  const lastBenchmarking = React.useRef(ambient.data?.benchmarking === true);

  const snapshot = ambient.data;
  const supported = snapshot?.supported !== false;
  const helperMissing = snapshot?.helper === "missing";

  const commitSnapshot = React.useCallback((next: AmbientMusicFeatureSnapshot) => {
    const current = queryClient.getQueryData<AmbientMusicFeatureSnapshot>(queryKeys.ambientMusic);
    if (current && current.revision > next.revision) return false;
    const previousActivity = lastBenchmarking.current ? "benchmarking" : lastPlayback.current;
    const nextActivity = next.benchmarking ? "benchmarking" : next.playback;
    lastPlayback.current = next.playback;
    lastBenchmarking.current = next.benchmarking === true;
    if (previousActivity && previousActivity !== nextActivity) {
      const label = nextActivity === "benchmarking"
        ? "is benchmarking Base locally"
        : nextActivity === "playing"
          ? "playing"
          : nextActivity === "paused"
            ? "paused"
            : nextActivity === "error"
              ? "encountered an error"
              : "stopped";
      setAnnouncement(`Ambient Music ${label}.`);
    }
    queryClient.setQueryData<AmbientMusicFeatureSnapshot>(queryKeys.ambientMusic, next);
    return true;
  }, [queryClient]);

  const continuousControlError = React.useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : "Couldn't update Ambient Music.";
    toast.error(message);
    setAnnouncement(message);
    setLiveUpdateNotice("The control remains ready for the next Apply, but the live soundtrack did not update.");
  }, []);
  const [weightControl] = React.useState(() => new LatestAmbientMusicControl<number[]>(100, async (weights) => {
    commitSnapshot(await ambientMusicApi.setWeights(weights));
    setLiveUpdateNotice(null);
  }, continuousControlError));
  const [volumeControl] = React.useState(() => new LatestAmbientMusicControl<number>(100, async (decibels) => {
    commitSnapshot(await ambientMusicApi.setVolume(decibels));
    setLiveUpdateNotice(null);
  }, continuousControlError));
  const [variationControl] = React.useState(() => new LatestAmbientMusicControl<number>(100, async (variation) => {
    commitSnapshot(await ambientMusicApi.setVariation(variation));
    setLiveUpdateNotice(null);
  }, continuousControlError));

  React.useEffect(() => ambientMusicApi.onChanged(commitSnapshot), [commitSnapshot]);

  React.useEffect(() => {
    if (initialized || !settings.isSuccess) return;
    const parsed = parseAmbientMusicConfig(settings.data.ambientMusic) ?? DEFAULT_AMBIENT_MUSIC_CONFIG;
    const next = cloneConfig(parsed);
    setConfig(next);
    setDraftPrompts(next.prompts.map((prompt) => ({ ...prompt })));
    lastAudibleVolume.current = next.volumeDb > -60 ? next.volumeDb : DEFAULT_AMBIENT_MUSIC_CONFIG.volumeDb;
    setInitialized(true);
  }, [initialized, settings.data, settings.isSuccess]);

  const [settingsPersistence] = React.useState(() =>
    new OrderedAmbientMusicPersistence<AmbientMusicConfigV1, AmbientMusicConfigV1>(300, async (next) => {
      const parsed = parseAmbientMusicConfig(next);
      if (!parsed) throw new Error("Check the Ambient Music prompt mix before saving.");
      const saved = await settingsApi.set({ ambientMusic: parsed });
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
      setSaveNotice(null);
      return parsed;
    }, (error) => {
      const message = error instanceof Error ? error.message : "Couldn't save Ambient Music settings.";
      toast.error(message);
      setAnnouncement(message);
      setSaveNotice("The live control changed, but it could not be saved and may revert next time.");
    }));

  const cancelPendingPersist = React.useCallback(() => {
    settingsPersistence.cancelScheduled();
  }, [settingsPersistence]);

  const persist = React.useCallback(
    (next: AmbientMusicConfigV1) => settingsPersistence.writeNow(next),
    [settingsPersistence],
  );

  const persistSoon = React.useCallback((next: AmbientMusicConfigV1) => {
    if (parseAmbientMusicConfig(next)) settingsPersistence.schedule(cloneConfig(next));
  }, [settingsPersistence]);

  React.useEffect(() => () => {
    settingsPersistence.dispose(true);
    weightControl.dispose();
    volumeControl.dispose();
    variationControl.dispose();
  }, [settingsPersistence, variationControl, volumeControl, weightControl]);

  const run = React.useCallback(async <T,>(operation: Exclude<BusyOperation, null>, task: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return undefined;
    setBusy(operation);
    try {
      return await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ambient Music couldn't complete that operation.";
      if (!(operation.startsWith("download:") && /cancel/iu.test(message))) {
        toast.error(message);
        setAnnouncement(message);
      }
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const selectModel = (model: AmbientMusicModelId) => {
    void run(`switch:${model}`, async () => {
      cancelPendingPersist();
      const previous = config;
      const next = { ...config, selectedModel: model };
      const saved = await persist(next);
      setConfig(cloneConfig(saved));
      try {
        const accepted = commitSnapshot(await ambientMusicApi.load(model));
        if (accepted) {
          setAnnouncement(`${model === "mrt2_small" ? "Small" : "Base"} selected and ready for a prompt mix.`);
        }
      } catch (error) {
        await persist(previous);
        setConfig(previous);
        throw error;
      }
    });
  };

  const download = (model: AmbientMusicModelId, repair: boolean) => {
    void run(`download:${model}`, async () => {
      const next = await ambientMusicApi.download(model, { termsAccepted: true, repair });
      commitSnapshot(next);
      toast.success(repair ? "Ambient Music model repaired." : "Ambient Music model downloaded.");
      setAnnouncement(repair ? "Ambient Music model repaired." : "Ambient Music model download ready.");
    });
  };

  const cancelDownload = async () => {
    try {
      commitSnapshot(await ambientMusicApi.cancelDownload());
      toast.info("Download paused. Aiden will resume from the partial download next time.");
      setAnnouncement("Download paused. It can resume later.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't cancel the download.");
    }
  };

  const applyMix = async (playAfter = false) => {
    await run(playAfter ? "playback" : "apply", async () => {
      const activePrompts = activeAmbientMusicPrompts(draftPrompts);
      const parsed = parseAmbientMusicConfig({ ...config, prompts: normalizePrompts(activePrompts) });
      if (!parsed) throw new Error("Add one to six non-empty music prompts and keep at least one mix level above zero.");
      setAnnouncement("Encoding the Ambient Music style mix…");
      if (!snapshot) throw new Error("Ambient Music is still starting.");
      cancelPendingPersist();
      await settingsPersistence.settle();
      const result = await ambientMusicApi.applyConfiguration(parsed, playAfter);
      const accepted = commitSnapshot(result.snapshot);
      queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => ({
        ...current,
        ambientMusic: result.config,
      }));
      setConfig(cloneConfig(result.config));
      setDraftPrompts(result.config.prompts.map((prompt) => ({ ...prompt })));
      setLiveUpdateNotice(null);
      setSaveNotice(null);
      if (accepted) {
        setAnnouncement(playAfter ? "Ambient Music is playing." : "Ambient Music style mix ready.");
      }
    });
  };

  const playCommittedMix = async () => {
    await run("playback", async () => {
      const parsed = parseAmbientMusicConfig(config);
      if (!parsed) throw new Error("The saved Ambient Music mix is invalid. Apply a valid mix before playing.");
      setAnnouncement("Preparing the saved Ambient Music mix…");
      cancelPendingPersist();
      await settingsPersistence.settle();
      const result = await ambientMusicApi.applyConfiguration(parsed, true);
      const accepted = commitSnapshot(result.snapshot);
      queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => ({
        ...current,
        ambientMusic: result.config,
      }));
      setConfig(cloneConfig(result.config));
      setLiveUpdateNotice(null);
      setSaveNotice(null);
      if (accepted) setAnnouncement("Ambient Music is playing.");
    });
  };

  const togglePlayback = () => {
    if (snapshot?.benchmarking) return;
    if (snapshot?.playback === "playing") {
      void run("playback", async () => commitSnapshot(await ambientMusicApi.pause()));
      return;
    }
    if (
      snapshot?.loadedModel === config.selectedModel &&
      snapshot.promptReady
    ) {
      void run("playback", async () => commitSnapshot(await ambientMusicApi.play()));
      return;
    }
    void playCommittedMix();
  };

  const restart = () => {
    void run("playback", async () => commitSnapshot(await ambientMusicApi.restart()));
  };

  const updatePrompt = (id: string, patch: Partial<Pick<AmbientMusicPromptStyle, "text" | "weight">>) => {
    setDraftPrompts((current) =>
      current.map((prompt) => prompt.id === id ? { ...prompt, ...patch } : prompt));
  };

  const updateWeight = (id: string, weight: number) => {
    const changed = setPromptWeight(draftPrompts, id, weight);
    if (changed.reduce((sum, prompt) => sum + prompt.weight, 0) <= 0) {
      toast.info("Keep at least one music style above zero.");
      return;
    }
    setDraftPrompts(changed);
    const rowsMatchApplied = ambientMusicRowsMatchAppliedMix(changed, config.prompts);
    if (rowsMatchApplied) {
      const nextPrompts = config.prompts.map((prompt, index) => ({
        ...prompt,
        weight: changed[index]?.weight ?? prompt.weight,
      }));
      const next = { ...config, prompts: nextPrompts };
      setConfig(next);
      persistSoon(next);
      if (snapshot?.loadedModel === config.selectedModel && snapshot.promptReady) {
        weightControl.push(nextPrompts.map((prompt) => prompt.weight));
      }
    }
  };

  const addPrompt = () => {
    if (draftPrompts.length >= PROMPT_LIMIT) return;
    promptCounter.current += 1;
    const id = `style-${Date.now().toString(36)}-${promptCounter.current}`;
    const prompts = normalizePrompts([
      ...draftPrompts,
      { id, text: "", weight: 0 },
    ]);
    setDraftPrompts(prompts);
    requestAnimationFrame(() => promptRefs.current.get(id)?.focus());
  };

  const removePrompt = (id: string) => {
    if (draftPrompts.length <= 1) return;
    const index = draftPrompts.findIndex((prompt) => prompt.id === id);
    const remaining = normalizePrompts(draftPrompts.filter((prompt) => prompt.id !== id));
    setDraftPrompts(remaining);
    requestAnimationFrame(() => {
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) promptRefs.current.get(next.id)?.focus();
      else addPromptRef.current?.focus();
    });
  };

  const updateControl = <K extends "volumeDb" | "variation">(key: K, value: AmbientMusicConfigV1[K]) => {
    const next = { ...config, [key]: value };
    setConfig(next);
    persistSoon(next);
    if (snapshot?.loadedModel === config.selectedModel) {
      if (key === "volumeDb") volumeControl.push(value);
      else variationControl.push(value);
    }
  };

  const setDrumless = (enabled: boolean) => {
    const next = { ...config, drumless: enabled };
    setConfig(next);
    cancelPendingPersist();
    void persist(next).catch((error) => {
      const message = error instanceof Error ? error.message : "Couldn't save Ambient Music settings.";
      toast.error(message);
      setSaveNotice("The live control changed, but it could not be saved and may revert next time.");
    });
    if (snapshot?.loadedModel === config.selectedModel) {
      void ambientMusicApi.setDrumless(enabled).then((nextSnapshot) => {
        commitSnapshot(nextSnapshot);
        setLiveUpdateNotice(null);
      }).catch((error) => {
        const message = error instanceof Error ? error.message : "Couldn't update Ambient Music.";
        toast.error(message);
        setAnnouncement(message);
        setLiveUpdateNotice("The control remains ready for the next Apply, but the live soundtrack did not update.");
      });
    }
  };

  const toggleMute = () => {
    const nextVolume = config.volumeDb <= -60 ? lastAudibleVolume.current : -60;
    if (config.volumeDb > -60) lastAudibleVolume.current = config.volumeDb;
    updateControl("volumeDb", nextVolume);
  };

  const resetStyle = () => {
    setDraftPrompts(DEFAULT_AMBIENT_MUSIC_CONFIG.prompts.map((prompt) => ({ ...prompt })));
    setResetOpen(false);
    setAnnouncement("Default style restored as a draft. Apply the mix when ready.");
  };

  const benchmarkBase = () => {
    void run("benchmark", async () => {
      let current = snapshot;
      if (!current) throw new Error("Ambient Music is still starting.");
      if (current.selectedModel) {
        current = await ambientMusicApi.unload();
        commitSnapshot(current);
      }
      const result = await ambientMusicApi.benchmarkBase(current.revision);
      commitSnapshot(await ambientMusicApi.get());
      if (result.status === "passed") {
        toast.success("This Mac passed the Base real-time benchmark.");
      } else {
        toast.error("Base did not sustain real-time generation on this Mac. Small remains recommended.");
      }
    });
  };

  const removeModel = () => {
    if (!removing || !snapshot) return;
    const target = removing;
    void run(`remove:${target.model}`, async () => {
      const next = await ambientMusicApi.removeModel(target.model, snapshot.revision);
      commitSnapshot(next);
      if (config.selectedModel === target.model) {
        const fallback = { ...config, selectedModel: "mrt2_small" as const };
        setConfig(fallback);
        cancelPendingPersist();
        await persist(fallback);
      }
      toast.success(`${target.label} removed from this Mac.`);
      setRemoving(null);
    });
  };

  const modelReturnFocus = (): HTMLElement | null => {
    const preferred = removeReturnModel.current;
    const cards = preferred
      ? [modelCardRefs.current.get(preferred), ...modelCardRefs.current.values()]
      : [...modelCardRefs.current.values()];
    for (const card of cards) {
      const target = card?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])");
      if (target) return target;
    }
    return resetButtonRef.current;
  };

  const mixDirty = JSON.stringify(draftPrompts) !== JSON.stringify(config.prompts);
  const promptErrors = draftPrompts.map((prompt) => ambientMusicPromptError(prompt.text, prompt.weight));
  const mixValid = promptErrors.every((error) => error === undefined) &&
    draftPrompts.some((prompt) => prompt.weight > 0);
  const selectedStatus = snapshot?.models.find((model) => model.model === config.selectedModel);
  const selectedReady = selectedStatus?.state === "ready" &&
    (config.selectedModel !== "mrt2_base" || snapshot?.baseBenchmark?.status === "passed");
  const benchmarking = snapshot?.benchmarking === true;
  const runtimeModel = benchmarking
    ? "mrt2_base"
    : snapshot?.loadedModel ?? snapshot?.selectedModel ?? config.selectedModel;
  const runtimeStatus = snapshot?.models.find((model) => model.model === runtimeModel);
  const dominantPrompt = [...config.prompts].sort((left, right) => right.weight - left.weight)[0]?.text || "Ambient Music";
  const playbackLabel = benchmarking
    ? "Benchmarking"
    : snapshot?.playback === "playing"
      ? "Playing"
      : snapshot?.playback === "loading"
        ? "Loading"
        : snapshot?.playback === "paused"
          ? "Paused"
          : snapshot?.playback === "error"
            ? "Error"
            : "Stopped";
  const supportMessage = supportCopy(snapshot);

  if (ambient.isError || settings.isError) {
    return (
      <div className="flex flex-col gap-1 pb-8">
        <AmbientMusicHeading />
        <Callout color="red" role="alert">
          <Text variant="small-strong" color="red">Ambient Music settings couldn't load</Text>
          <Text variant="small" color="secondary">Retry the local status and settings reads. No model download was started.</Text>
          <Button
            size="small"
            variant="filled"
            className="mt-2 w-fit"
            onClick={() => void Promise.all([ambient.refetch(), settings.refetch()])}
          >
            Retry
          </Button>
        </Callout>
      </div>
    );
  }

  if (ambient.isLoading || settings.isLoading || !initialized) {
    return (
      <div className="flex min-h-44 items-center justify-center" role="status">
        <Loader2 className="mr-2 size-4 animate-spin text-secondary" />
        <Text color="secondary">Loading Ambient Music…</Text>
      </div>
    );
  }

  if (!supported) {
    return (
      <div className="flex flex-col gap-1 pb-8">
        <AmbientMusicHeading />
        <Callout color="red" className="mb-6" role="status">
          <span className="flex items-center gap-2">
            <TriangleAlert className="size-4 text-red" />
            <Text variant="small-strong" color="red">Not available on this Mac</Text>
          </span>
          <Text variant="small" color="secondary">{supportMessage}</Text>
          <Text variant="small" color="tertiary">No model files will be downloaded on this device.</Text>
        </Callout>
        <Text as="p" variant="small" color="tertiary" className="px-1">
          Ambient Music uses Magenta RealTime 2 locally and requires Apple silicon with macOS 14 or later.
        </Text>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 pb-8">
      <AmbientMusicHeading />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

      {snapshot?.error ? (
        <Callout color="red" className="mb-6" role="alert">
          <Text variant="small-strong" color="red">Ambient Music needs attention</Text>
          <Text variant="small" color="secondary">{snapshot.error.message}</Text>
          {snapshot.error.retryable ? (
            <Button
              size="small"
              variant="filled"
              className="mt-2 w-fit"
              disabled={busy !== null || !selectedReady || helperMissing}
              onClick={() => void playCommittedMix()}
            >
              Retry playback
            </Button>
          ) : null}
        </Callout>
      ) : null}

      {helperMissing ? (
        <Callout className="mb-6" role="status">
          <Text variant="small-strong">Native helper not built</Text>
          <Text variant="small" color="secondary">
            This development build cannot download or play Ambient Music. Restart development with
            {" "}<code className="rounded bg-control px-1 py-0.5 font-mono text-[0.92em]">AIDEN_BUILD_AMBIENT_MUSIC=1 npm run dev</code>.
          </Text>
          <Text variant="small" color="tertiary">
            Existing downloaded models remain on this Mac and can still be removed below.
          </Text>
        </Callout>
      ) : null}

      {liveUpdateNotice || saveNotice ? (
        <Callout className="mb-6">
          <Text variant="small-strong">Ambient Music controls need attention</Text>
          {liveUpdateNotice ? <Text variant="small" color="secondary">{liveUpdateNotice}</Text> : null}
          {saveNotice ? <Text variant="small" color="secondary">{saveNotice}</Text> : null}
        </Callout>
      ) : null}

      {snapshot?.degradation ? (
        <Callout className="mb-6">
          <Text variant="small-strong">Ambient Music is under heavy local load</Text>
          <Text variant="small" color="secondary">
            Audio may stutter while other local work is busy. Pause heavy local tasks, switch to Small, or pause and retry when the Mac is quieter. Aiden will not switch models automatically.
          </Text>
        </Callout>
      ) : null}

      <FieldSet title="Now Playing">
        <Field orientation="vertical" className="gap-0">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-card bg-accent/10 text-accent">
                <Music2 className="size-5" />
              </div>
              <div className="min-w-0">
                <Text as="p" variant="strong" truncate>{dominantPrompt}</Text>
                <Text as="p" variant="small" color="tertiary">
                  {runtimeStatus?.label ?? "Choose a model"} · {playbackLabel}
                </Text>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="small"
                variant="transparent"
                iconOnly
                disabled={benchmarking || busy !== null || !supported || helperMissing}
                onClick={toggleMute}
                aria-label={config.volumeDb <= -60 ? "Unmute Ambient Music" : "Mute Ambient Music"}
                aria-pressed={config.volumeDb <= -60}
              >
                {config.volumeDb <= -60 ? <VolumeX /> : <Volume2 />}
              </Button>
              <Button
                size="small"
                variant="transparent"
                iconOnly
                disabled={benchmarking || !selectedReady || busy !== null || !snapshot?.promptReady || helperMissing}
                onClick={restart}
                aria-label="Restart Ambient Music"
              >
                <RotateCcw />
              </Button>
              <Button
                size="large"
                variant="accent"
                iconOnly
                disabled={benchmarking || !selectedReady || busy !== null || helperMissing}
                onClick={togglePlayback}
                aria-label={benchmarking
                  ? "Benchmarking Ambient Music"
                  : snapshot?.playback === "playing"
                    ? "Pause Ambient Music"
                    : "Play Ambient Music"}
                aria-pressed={!benchmarking && snapshot?.playback === "playing"}
              >
                {benchmarking || busy === "playback" || snapshot?.playback === "loading" ? (
                  <Loader2 className="animate-spin" />
                ) : snapshot?.playback === "playing" ? <Pause /> : <Play />}
              </Button>
            </div>
          </div>
          <AmbientMusicVisualizer
            playing={!benchmarking && snapshot?.playback === "playing"}
            bands={snapshot?.metrics?.visualizerBands}
          />
          <Text as="p" variant="small" color="tertiary" className="mt-2">
            The spectrum follows the generated audio. Native Now Playing integration exposes play and pause to macOS media controls.
          </Text>
        </Field>
      </FieldSet>

      <FieldSet title="Music Style">
        <Field
          label="Prompt mix"
          description="Blend up to six descriptions. Text changes take effect when you apply the mix; levels move live while music is ready."
          orientation="vertical"
        >
          <div className="flex flex-col gap-2.5">
            {draftPrompts.map((prompt, index) => {
              const promptError = promptErrors[index];
              const errorId = `ambient-prompt-${prompt.id}-error`;
              return (
              <div key={prompt.id} className="rounded-card border border-field bg-main p-3">
                <div className="flex items-center gap-2">
                  <Input
                    ref={(node) => {
                      if (node) promptRefs.current.set(prompt.id, node);
                      else promptRefs.current.delete(prompt.id);
                    }}
                    value={prompt.text}
                    maxLength={200}
                    placeholder={index === 0 ? "soft focus ambient, warm synthesizer, no vocals" : "Add another style…"}
                    aria-label={`Music style ${index + 1}`}
                    aria-invalid={promptError ? true : undefined}
                    aria-errormessage={promptError ? errorId : undefined}
                    onChange={(event) => updatePrompt(prompt.id, { text: event.target.value })}
                  />
                  <Button
                    size="small"
                    variant="transparent"
                    iconOnly
                    disabled={draftPrompts.length <= 1 || busy !== null}
                    onClick={() => removePrompt(prompt.id)}
                    aria-label={`Remove music style ${index + 1}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
                {promptError ? (
                  <Text id={errorId} as="p" variant="small" color="red" className="mt-1.5">
                    {promptError}
                  </Text>
                ) : null}
                <div className="mt-2 flex items-center gap-3">
                  <Range
                    min={0}
                    max={1}
                    step={0.01}
                    value={prompt.weight}
                    disabled={busy !== null || helperMissing}
                    aria-label={`${prompt.text || `Music style ${index + 1}`} mix level`}
                    onChange={(event) => updateWeight(prompt.id, Number(event.target.value))}
                  />
                  <Text variant="small" color="tertiary" className="w-10 shrink-0 text-right tabular-nums">
                    {Math.round(prompt.weight * 100)}%
                  </Text>
                </div>
              </div>
              );
            })}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  ref={addPromptRef}
                  size="small"
                  variant="transparent"
                  disabled={draftPrompts.length >= PROMPT_LIMIT || busy !== null}
                  onClick={addPrompt}
                >
                  <Plus />
                  Add style
                </Button>
                <Button ref={resetButtonRef} size="small" variant="transparent" disabled={busy !== null} onClick={() => setResetOpen(true)}>
                  <RotateCcw />
                  Reset to default
                </Button>
              </div>
              <Button
                size="small"
                variant={mixDirty ? "accent" : "filled"}
                disabled={!selectedReady || busy !== null || !mixValid || helperMissing}
                onClick={() => void applyMix(false)}
              >
                {busy === "apply" ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                {mixDirty ? "Apply mix" : "Reapply mix"}
              </Button>
            </div>
          </div>
        </Field>

        <Field label="Volume" description="Ambient Music output level.">
          <div className="flex items-center gap-3">
            <Range
              min={-60}
              max={0}
              step={1}
              value={config.volumeDb}
              disabled={busy !== null || helperMissing}
              aria-label="Ambient Music volume"
              onChange={(event) => updateControl("volumeDb", Number(event.target.value))}
            />
            <Text variant="small" color="tertiary" className="w-12 shrink-0 text-right tabular-nums">
              {config.volumeDb} dB
            </Text>
          </div>
        </Field>

        <Field label="Variation" description="Higher values refresh the generation with a more varied seed.">
          <div className="flex items-center gap-3">
            <Range
              min={0}
              max={1}
              step={0.01}
              value={config.variation}
              disabled={busy !== null || helperMissing}
              aria-label="Ambient Music variation"
              onChange={(event) => updateControl("variation", Number(event.target.value))}
            />
            <Text variant="small" color="tertiary" className="w-10 shrink-0 text-right tabular-nums">
              {Math.round(config.variation * 100)}%
            </Text>
          </div>
        </Field>

        <Field label="No drums" description="Reduce percussion while keeping the rest of the prompt mix.">
          <div className="flex justify-end">
            <Switch
              checked={config.drumless}
              disabled={busy !== null || helperMissing}
              onCheckedChange={setDrumless}
              aria-label="Generate Ambient Music without drums"
            />
          </div>
        </Field>

        <Field label="Output" description="Ambient Music follows the current macOS audio route.">
          <Text as="p" variant="small" color="secondary" className="text-right">System default</Text>
        </Field>
      </FieldSet>

      <FieldSet title="On-device Models">
        <Field orientation="vertical">
          <Callout>
            <span className="flex items-center gap-2">
              <HardDrive className="size-4 text-secondary" />
              <Text variant="small-strong">Downloaded only when you choose</Text>
            </span>
            <Text variant="small" color="secondary">
              Model files are not bundled with Aiden. Hugging Face downloads begin only after you choose one, are verified before use, and live in {snapshot?.storage.locationLabel ?? "Aiden application data"}. Generation can use sustained power and memory.
            </Text>
            <Text variant="small" color="tertiary" className="tabular-nums">
              Shared model resources: {formatBytes(snapshot?.storage.sharedBytes ?? 0)}
              {snapshot?.storage.availableBytes !== undefined
                ? ` · ${formatBytes(snapshot.storage.availableBytes)} available`
                : ""}
            </Text>
            <label className="mt-2 flex cursor-default items-start gap-2 text-small text-primary">
              <input
                type="checkbox"
                checked={termsAccepted}
                disabled={helperMissing}
                onChange={(event) => setTermsAccepted(event.target.checked)}
                className="ambient-terms-checkbox mt-0.5 size-4 accent-accent"
              />
              <span>
                I reviewed the Magenta RealTime 2 model terms and understand that the weights are CC BY 4.0.
              </span>
            </label>
            <a
              href={MODEL_TERMS_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex w-fit items-center gap-1 text-small text-accent hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Review model card and terms <ExternalLink className="size-3" />
            </a>
          </Callout>

          <div className="mt-3 flex flex-col gap-2.5">
            {snapshot?.models.map((status) => (
              <ModelCard
                key={status.model}
                status={status}
                selected={config.selectedModel === status.model}
                termsAccepted={termsAccepted}
                basePassed={snapshot.baseBenchmark?.status === "passed"}
                busy={busy}
                disabled={!supported || helperMissing}
                removeDisabled={!supported}
                onSelect={() => selectModel(status.model)}
                onDownload={(repair) => download(status.model, repair)}
                onCancel={() => void cancelDownload()}
                onRemove={() => {
                  removeReturnModel.current = status.model;
                  setRemoving(status);
                }}
                onBenchmark={benchmarkBase}
                cardRef={(node) => {
                  if (node) modelCardRefs.current.set(status.model, node);
                  else modelCardRefs.current.delete(status.model);
                }}
              />
            ))}
          </div>

          {snapshot?.baseBenchmark ? (
            <Text as="p" variant="small" color="tertiary" className="mt-3 tabular-nums">
              Base benchmark {snapshot.baseBenchmark.status}: p95 {snapshot.baseBenchmark.p95FrameMs.toFixed(1)} ms · {snapshot.baseBenchmark.droppedFrames} dropped frames.
            </Text>
          ) : null}
        </Field>
      </FieldSet>

      <Separator className="mb-4" />
      <Text as="p" variant="small" color="tertiary" className="px-1">
        Powered by Magenta RealTime 2 from Google DeepMind. Aiden uses the Apache 2.0 engine source and CC BY 4.0 model weights. Generated audio may reflect limitations in the training data; use it responsibly.
      </Text>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this Ambient Music model?"
        description={removing ? `${removing.label} will remove ${formatBytes(removing.reclaimableBytes)} of local model data. Shared resources retained for another local model will remain. You can download it again later.` : null}
        confirmLabel="Remove"
        confirmVariant="destructive"
        busy={removing ? busy === `remove:${removing.model}` : false}
        keepOpenOnConfirm
        returnFocus={modelReturnFocus}
        onConfirm={removeModel}
      />
      <AlertDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset the style mix?"
        description="Replace the prompt rows with Aiden's default ambient style. The current soundtrack will not change until you choose Apply mix."
        confirmLabel="Reset style"
        returnFocus={() => resetButtonRef.current}
        onConfirm={resetStyle}
      />
    </div>
  );
}
