import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Loader2, RefreshCw } from "lucide-react";

import { useAppCapabilities } from "../../lib/app-capabilities";
import { storageApi } from "../../lib/ipc";
import { settingsLocation } from "../../lib/settings-section";
import { availableSettingsDestinations, type SettingsSection } from "../../shared/settings-section";
import {
  DEFAULT_STORAGE_INACTIVE_DAYS,
  STORAGE_INACTIVE_DAYS,
  STORAGE_PROTECTION_COPY,
  formatStorageBytes,
  storageCategory,
  storageSharePercent,
  type StorageCategoryUsage,
  type StorageCleanupAction,
  type StorageCleanupPreview,
  type StorageCleanupRequest,
  type StorageInactiveDays,
  type StorageProtectionReason,
  type StorageReport,
  type StorageScanState,
} from "../../shared/storage";
import { AlertDialog, Badge, Button, EmptyState, Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text, toast } from "../ui";
import { InfoHint } from "../ui-info-hint";

/** How many of the largest worktrees and chats the page lists. */
const LARGEST_ITEM_COUNT = 8;

type OpenPreview = {
  request: StorageCleanupRequest;
  /** One named item (a row's button) rather than a sweep. */
  single: boolean;
  data: StorageCleanupPreview;
};

function scanCaption(scan: StorageScanState): string {
  if (scan.status === "failed") return scan.error ?? "Aiden could not measure local storage.";
  if (scan.status === "scanning") return "Measuring how much disk Aiden uses…";
  if (scan.scannedAt === null) return "Not measured yet.";
  const when = new Date(scan.scannedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return scan.truncated
    ? `Measured at ${when}. Aiden stopped early, so some sizes are a minimum.`
    : `Measured at ${when}.`;
}

function idleCaption(days: number | null): string {
  if (days === null) return "No recorded use";
  if (days === 0) return "Used today";
  if (days === 1) return "Used yesterday";
  return `Unused for ${days} days`;
}

function sizeLabel(bytes: number, complete = true): string {
  return complete ? formatStorageBytes(bytes) : `At least ${formatStorageBytes(bytes)}`;
}

function protectionCopy(reason: string | undefined): string {
  if (reason === "recent") return "Used recently";
  return STORAGE_PROTECTION_COPY[reason as StorageProtectionReason] ?? "Kept";
}

function segmentColor(index: number): string {
  return `var(--chart-${(index % 8) + 1})`;
}

/** Categories with something on disk, largest first; the bar and the list share this order. */
function usedCategories(report: StorageReport): StorageCategoryUsage[] {
  return report.categories.filter((category) => category.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}

function StorageBar({ report }: { report: StorageReport }) {
  const used = usedCategories(report);
  if (report.totalBytes <= 0 || used.length === 0) return null;
  return (
    <div
      className="flex h-2 w-full gap-[2px] overflow-hidden rounded-pill bg-control"
      role="img"
      aria-label={`Disk use by category: ${used
        .map((category) => `${storageCategory(category.id).label} ${formatStorageBytes(category.bytes)}`)
        .join(", ")}`}
    >
      {used.map((category, index) => (
        <span
          key={category.id}
          aria-hidden="true"
          className="h-full first:rounded-l-pill last:rounded-r-pill"
          style={{
            width: `${Math.max(0.8, storageSharePercent(category.bytes, report.totalBytes))}%`,
            backgroundColor: segmentColor(index),
          }}
        />
      ))}
    </div>
  );
}

/** Size on the left of a fixed-width action column, so sizes line up down a card. */
function SizeAndAction({ size, children }: { size: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-3">
      <Text variant="small" color="secondary" className="shrink-0 tabular-nums">
        {size}
      </Text>
      <div className="flex w-[7.5rem] shrink-0 justify-end">{children}</div>
    </div>
  );
}

function ItemRow({
  label,
  caption,
  size,
  keptReason,
  actionLabel,
  actionDisabled,
  onAction,
}: {
  label: string;
  caption: string;
  size: string;
  keptReason?: string;
  actionLabel: string;
  actionDisabled: boolean;
  onAction: () => void;
}) {
  return (
    <Field
      label={<span className="block truncate">{label}</span>}
      description={keptReason ? `${caption} · ${keptReason}` : caption}
    >
      <SizeAndAction size={size}>
        {keptReason ? (
          <Badge color="gray">Kept</Badge>
        ) : (
          <Button
            size="small"
            variant="filled"
            disabled={actionDisabled}
            aria-label={`${actionLabel.replace("…", "")} ${label}`}
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        )}
      </SizeAndAction>
    </Field>
  );
}

/** Settings → Storage inside the Settings window: adds links to the pages that own data. */
export function StorageSettingsPage() {
  const navigate = useNavigate();
  const capabilities = useAppCapabilities();
  const available = React.useMemo(
    () => new Set(availableSettingsDestinations(capabilities).map((destination) => destination.id)),
    [capabilities],
  );
  return (
    <StorageSettings
      canOpenSection={(section) => available.has(section)}
      onOpenSection={(section) => void navigate({ ...settingsLocation(section), replace: true })}
    />
  );
}

/** Settings → Storage: how much disk Aiden uses and what can be cleaned up. */
export function StorageSettings({
  canOpenSection,
  onOpenSection,
}: {
  canOpenSection?: (section: SettingsSection) => boolean;
  onOpenSection?: (section: SettingsSection) => void;
}) {
  const [report, setReport] = React.useState<StorageReport | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [busy, setBusy] = React.useState<StorageCleanupAction | "refresh" | "preview" | null>(null);
  const [preview, setPreview] = React.useState<OpenPreview | null>(null);
  // What the last cleanup did, kept on the page after its toast has gone.
  const [outcome, setOutcome] = React.useState<string | null>(null);
  const refreshRef = React.useRef<HTMLButtonElement | null>(null);
  const latestLoad = React.useRef(0);
  const latestWindowChange = React.useRef(0);

  const load = React.useCallback(async (mode: "read" | "refresh") => {
    // Reads overlap (a scan starting, then finishing); only the newest may land.
    const request = ++latestLoad.current;
    try {
      const next = mode === "refresh" ? await storageApi.refresh() : await storageApi.report();
      if (request !== latestLoad.current) return;
      setReport(next);
      setLoadFailed(false);
    } catch {
      if (request === latestLoad.current) setLoadFailed(true);
    }
  }, []);

  React.useEffect(() => {
    // Subscribe before the first read, so a scan that finishes behind the page
    // is never missed.
    const stop = storageApi.onChange((event) => {
      if (event?.kind === "scan-started" || event?.kind === "scan-finished") void load("read");
    });
    void load("read");
    return stop;
  }, [load]);

  const scanning = report?.scan.status === "scanning";
  const total = report?.totalBytes ?? 0;
  const actionsDisabled = busy !== null || scanning || report?.scan.status !== "ready";

  const openPreview = async (request: StorageCleanupRequest, single: boolean) => {
    if (busy) return;
    setBusy("preview");
    try {
      const data = await storageApi.preview(request);
      setPreview({ request, single, data });
    } catch {
      toast.error("Aiden could not work out what would be removed.");
    } finally {
      setBusy(null);
    }
  };

  const closePreview = () => {
    latestWindowChange.current += 1;
    setPreview(null);
    setBusy(null);
  };

  const changeWindow = async (inactiveDays: StorageInactiveDays) => {
    if (!preview || busy) return;
    const change = ++latestWindowChange.current;
    const request = { ...preview.request, inactiveDays };
    // Holds Confirm off, so what it removes is always the list on screen.
    setBusy("preview");
    try {
      const data = await storageApi.preview(request);
      if (change === latestWindowChange.current) setPreview({ request, single: false, data });
    } catch {
      if (change === latestWindowChange.current) toast.error("Aiden could not work out what would be removed.");
    } finally {
      if (change === latestWindowChange.current) setBusy(null);
    }
  };

  const announce = (kind: "success" | "error", message: string) => {
    toast[kind](message);
    setOutcome(message);
  };

  const runCleanup = async () => {
    if (!preview || busy) return;
    const { request, data } = preview;
    if (data.items.length === 0) {
      setPreview(null);
      return;
    }
    setBusy(request.action);
    setOutcome(null);
    try {
      const result = await storageApi.cleanup({
        action: request.action,
        inactiveDays: data.inactiveDays,
        targetIds: data.items.map((item) => item.id),
      });
      const freed = result.freedBytes > 0 ? `Freed ${formatStorageBytes(result.freedBytes)}.` : "No measurable space was freed.";
      // The removal only reports what the review had listed, so everything here is news.
      const notRemoved = result.failed.length + result.skipped.length;
      if (result.removed.length === 0) {
        const kept = result.skipped[0];
        announce(
          "error",
          result.failed[0]?.reason ??
            (kept ? `Aiden kept ${kept.label}: ${protectionCopy(kept.reason).toLowerCase()}.` : "Nothing was removed."),
        );
      } else if (notRemoved > 0) {
        announce("error", `${freed} ${notRemoved} item${notRemoved === 1 ? " was" : "s were"} kept or could not be removed.`);
      } else {
        announce("success", freed);
      }
    } catch {
      announce("error", "Aiden could not finish cleaning up. The sizes below show what is left.");
    }
    // Either way the review is out of date: its list may name what has already gone.
    setPreview(null);
    try {
      await load("refresh");
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setBusy("refresh");
    try {
      await load("refresh");
    } finally {
      setBusy(null);
    }
  };

  const categoryAction = (category: StorageCategoryUsage): React.ReactNode => {
    const action = storageCategory(category.id).action;
    if (!action || !report) return null;
    switch (action.kind) {
      case "review-worktrees":
        return (
          <Button
            size="small"
            variant="filled"
            disabled={actionsDisabled || report.worktrees.length === 0}
            onClick={() =>
              void openPreview({ action: "remove-worktrees", inactiveDays: DEFAULT_STORAGE_INACTIVE_DAYS }, false)
            }
          >
            Review…
          </Button>
        );
      case "clear-browser-cache":
        return (
          <Button
            size="small"
            variant="filled"
            disabled={actionsDisabled || report.browserCacheBytes <= 0}
            onClick={() =>
              void openPreview({ action: "clear-browser-cache", inactiveDays: DEFAULT_STORAGE_INACTIVE_DAYS }, false)
            }
          >
            Clear cache…
          </Button>
        );
      case "clear-logs":
        return (
          <Button
            size="small"
            variant="filled"
            disabled={actionsDisabled}
            onClick={() =>
              void openPreview({ action: "clear-logs", inactiveDays: DEFAULT_STORAGE_INACTIVE_DAYS }, false)
            }
          >
            Clear…
          </Button>
        );
      case "manage":
        if (!onOpenSection || canOpenSection?.(action.section) === false) return null;
        return (
          <Button size="small" variant="transparent" onClick={() => onOpenSection(action.section)}>
            Manage
            <ChevronRight />
          </Button>
        );
    }
  };

  const worktrees = report?.worktrees.slice(0, LARGEST_ITEM_COUNT) ?? [];
  const threads = report?.threads.slice(0, LARGEST_ITEM_COUNT) ?? [];

  return (
    <>
      <FieldSet
        title="On this computer"
        action={
          <Button
            ref={refreshRef}
            size="small"
            variant="filled"
            disabled={busy !== null || scanning}
            onClick={() => void refresh()}
          >
            {busy === "refresh" || scanning ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {scanning ? "Measuring…" : "Measure again"}
          </Button>
        }
      >
        <div className="p-4">
          <div className="flex items-baseline gap-3">
            <span className="text-heading1 font-semibold tabular-nums text-primary">
              {report ? formatStorageBytes(total) : "—"}
            </span>
            <span className="text-small text-secondary">used by Aiden</span>
          </div>
          <div className="mt-0.5 text-small text-secondary">
            {report ? scanCaption(report.scan) : "Checking how much disk Aiden uses…"}
          </div>
          {report && total > 0 ? (
            <div className="mt-4">
              <StorageBar report={report} />
            </div>
          ) : null}
          {outcome ? (
            <Text as="p" variant="small" color="secondary" role="status" className="mt-3">
              {outcome}
            </Text>
          ) : null}
          {loadFailed ? (
            <Text as="p" variant="small" color="secondary" role="status" className="mt-3">
              Aiden could not measure local storage. Nothing was changed.
            </Text>
          ) : null}
        </div>
      </FieldSet>

      {report && total > 0 ? (
        <FieldSet title="What’s using space">
          {usedCategories(report).map((category, index) => {
            const definition = storageCategory(category.id);
            return (
              <Field
                key={category.id}
                label={
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: segmentColor(index) }}
                    />
                    {definition.label}
                  </span>
                }
                hint={<InfoHint topic={definition.label}>{definition.description}</InfoHint>}
              >
                <SizeAndAction size={sizeLabel(category.bytes, category.complete !== false)}>
                  {categoryAction(category)}
                </SizeAndAction>
              </Field>
            );
          })}
        </FieldSet>
      ) : null}

      {worktrees.length > 0 ? (
        <FieldSet
          title="Largest worktrees"
          hint={
            <InfoHint topic="worktree removal">
              Aiden only removes worktrees it created, and never one with work that isn’t saved and pushed.
            </InfoHint>
          }
        >
          {worktrees.map((worktree) => (
            <ItemRow
              key={worktree.workspaceId}
              label={worktree.name}
              caption={`${worktree.branch} · ${idleCaption(worktree.idleDays)}`}
              size={sizeLabel(worktree.bytes, worktree.bytesComplete)}
              keptReason={worktree.protected ? protectionCopy(worktree.protectionReason) : undefined}
              actionLabel="Remove…"
              actionDisabled={actionsDisabled}
              onAction={() =>
                void openPreview(
                  {
                    action: "remove-worktrees",
                    inactiveDays: DEFAULT_STORAGE_INACTIVE_DAYS,
                    targetIds: [worktree.workspaceId],
                  },
                  true,
                )
              }
            />
          ))}
        </FieldSet>
      ) : null}

      {threads.length > 0 ? (
        <FieldSet
          title="Largest chats"
          hint={<InfoHint topic="chat deletion">Chats are deleted one at a time, and only when you ask.</InfoHint>}
        >
          {threads.map((thread) => (
            <ItemRow
              key={thread.chatId}
              label={thread.title}
              caption={
                thread.imageCount > 0
                  ? `${idleCaption(thread.idleDays)} · ${thread.imageCount} picture${thread.imageCount === 1 ? "" : "s"}`
                  : idleCaption(thread.idleDays)
              }
              size={sizeLabel(thread.bytes, thread.bytesComplete)}
              keptReason={thread.protected ? protectionCopy(thread.protectionReason) : undefined}
              actionLabel="Delete…"
              actionDisabled={actionsDisabled}
              onAction={() =>
                void openPreview(
                  { action: "delete-threads", inactiveDays: DEFAULT_STORAGE_INACTIVE_DAYS, targetIds: [thread.chatId] },
                  true,
                )
              }
            />
          ))}
        </FieldSet>
      ) : null}

      {report && report.scan.status === "ready" && worktrees.length === 0 && threads.length === 0 ? (
        <EmptyState
          placement="inline"
          title="Nothing to list yet"
          description="Worktrees and chats appear here once Aiden has some, largest first."
        />
      ) : null}

      <AlertDialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open && (busy === null || busy === "preview")) closePreview();
        }}
        title={preview ? previewTitle(preview) : ""}
        description={preview ? previewDescription(preview) : undefined}
        confirmLabel={
          preview && busy === preview.request.action ? "Removing…" : preview ? previewConfirmLabel(preview) : "Remove"
        }
        confirmVariant={
          preview?.request.action === "remove-worktrees" || preview?.request.action === "delete-threads"
            ? "destructive"
            : undefined
        }
        busy={preview !== null && busy === preview.request.action}
        keepOpenOnConfirm
        returnFocus={() => refreshRef.current}
        onConfirm={runCleanup}
      >
        {preview ? <PreviewBody preview={preview} onWindowChange={changeWindow} /> : null}
      </AlertDialog>
    </>
  );
}

function previewTitle({ request, single, data }: OpenPreview): string {
  switch (request.action) {
    case "remove-worktrees":
      return single ? "Remove this worktree?" : "Remove unused worktrees?";
    case "delete-threads":
      return "Delete this chat?";
    case "clear-logs":
      return "Clear logs and diagnostics?";
    case "clear-browser-cache":
      return data.items.length > 0 ? "Clear browser cache?" : "Nothing to clear";
  }
}

function previewDescription({ request, single, data }: OpenPreview): string {
  const freed = sizeLabel(data.totalBytes, data.totalComplete).replace(/^At least/u, "at least");
  const kept = data.skipped[0];
  if (data.items.length === 0) {
    if (single && kept) return `Aiden keeps ${kept.label}: ${protectionCopy(kept.reason).toLowerCase()}.`;
    switch (request.action) {
      case "remove-worktrees":
        return `No worktree has gone unused for ${data.inactiveDays} days.`;
      case "clear-logs":
        return "There are no logs to clear right now.";
      case "clear-browser-cache":
        return "The browser has no cached pages to clear right now.";
      default:
        return "There is nothing to remove.";
    }
  }
  switch (request.action) {
    case "remove-worktrees":
      return single
        ? `Removing it frees ${freed}.`
        : `${data.items.length === 1 ? "This worktree hasn’t" : `These ${data.items.length} worktrees haven’t`} been used in ${data.inactiveDays} days. Removing ${data.items.length === 1 ? "it" : "them"} frees ${freed}.`;
    case "delete-threads":
      return `“${data.items[0]!.label}” and its pictures are deleted for good. This frees ${freed}.`;
    case "clear-logs":
      return `${clearAmount(data)} Chats, settings, credentials and projects stay untouched.`;
    case "clear-browser-cache":
      return `${clearAmount(data)} You stay signed in to websites, and open tabs keep working.`;
  }
}

/** A file in use stays through a clear, so its measured size is a ceiling, not a promise. */
function clearAmount(data: StorageCleanupPreview): string {
  return data.totalComplete
    ? `This frees up to ${formatStorageBytes(data.totalBytes)}.`
    : `Aiden measured at least ${formatStorageBytes(data.totalBytes)} here, and clears what isn’t in use.`;
}

function previewConfirmLabel({ request, data }: OpenPreview): string {
  if (data.items.length === 0) return "Close";
  const freed = sizeLabel(data.totalBytes, data.totalComplete).replace(/^At least/u, "at least");
  switch (request.action) {
    case "remove-worktrees":
      return `Remove ${data.items.length} · ${freed}`;
    case "delete-threads":
      return `Delete · ${freed}`;
    case "clear-logs":
      return "Clear logs";
    case "clear-browser-cache":
      return "Clear cache";
  }
}

function PreviewBody({
  preview,
  onWindowChange,
}: {
  preview: OpenPreview;
  onWindowChange: (days: StorageInactiveDays) => void;
}) {
  const { request, single, data } = preview;
  if (request.action !== "remove-worktrees") return null;
  // Every item, however many: nothing may go that the person was not shown.
  const items = data.items;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {single ? null : (
        <div className="flex items-center justify-between gap-3">
          <Text variant="small" color="secondary" className="whitespace-nowrap">
            Unused for
          </Text>
          <Select value={String(data.inactiveDays)} onValueChange={(next) => onWindowChange(Number(next) as StorageInactiveDays)}>
            <SelectTrigger size="small" aria-label="Unused for" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STORAGE_INACTIVE_DAYS.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {days} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {items.length > 0 ? (
        <ul
          className="flex max-h-56 min-w-0 flex-col gap-2 overflow-y-auto rounded-card bg-control p-3"
          aria-label="Worktrees to remove"
          tabIndex={0}
        >
          {items.map((item) => (
            <li key={item.id} className="flex min-w-0 items-baseline gap-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-primary">{item.label}</span>
                {item.detail ? <span className="block truncate text-tertiary">{item.detail}</span> : null}
              </span>
              <span className="shrink-0 tabular-nums text-secondary">
                {sizeLabel(item.bytes, item.bytesComplete !== false)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {items.length > 0 ? (
        <Text variant="small" color="secondary">
          If nothing was ever committed on a worktree’s branch, Aiden deletes that branch too.
          Branches with commits stay in your repository.
        </Text>
      ) : null}
      {data.skipped.length > 0 && !(single && items.length === 0) ? (
        <div className="flex min-w-0 flex-col gap-1 pt-1">
          <Text variant="small-strong" color="secondary">
            Kept ({data.skipped.length})
          </Text>
          {data.skipped.slice(0, 20).map((entry) => (
            <div key={entry.id} className="flex min-w-0 items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate text-secondary">{entry.label}</span>
              <span className="shrink-0 text-tertiary">{protectionCopy(entry.reason)}</span>
            </div>
          ))}
          {data.skipped.length > 20 ? (
            <Text variant="small" color="tertiary">
              and {data.skipped.length - 20} more
            </Text>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
