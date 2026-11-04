import * as React from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";

import { storageApi } from "../../lib/ipc";
import {
  DEFAULT_STORAGE_INACTIVE_DAYS,
  DEFAULT_THREAD_INACTIVE_DAYS,
  STORAGE_INACTIVE_DAYS,
  STORAGE_PROTECTION_COPY,
  formatStorageBytes,
  storageCategoryLabel,
  storageSharePercent,
  type StorageCleanupAction,
  type StorageCleanupPreview,
  type StorageInactiveDays,
  type StorageItem,
  type StorageReport,
  type StorageScanState,
  type StorageThreadView,
  type StorageWorktreeView,
} from "../../shared/storage";
import { AlertDialog, Badge, Button, EmptyState, Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text, toast } from "../ui";

type Busy = StorageCleanupAction | "refresh" | null;

function scanCaption(scan: StorageScanState): string {
  if (scan.status === "failed") return scan.error ?? "Aiden could not measure local storage.";
  if (scan.status === "scanning") return "Measuring how much disk Aiden uses…";
  if (scan.scannedAt === null) return "Not measured yet.";
  const when = new Date(scan.scannedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return scan.truncated
    ? `Measured at ${when}. Aiden stopped early, so the total is a minimum.`
    : `Measured at ${when}.`;
}

function idleCaption(days: number | null): string {
  if (days === null) return "No recorded use";
  if (days === 0) return "Used today";
  if (days === 1) return "Unused for 1 day";
  return `Unused for ${days} days`;
}

function worktreeCaption(worktree: StorageWorktreeView): string {
  const parts = [worktree.branch, idleCaption(worktree.idleDays)];
  if (worktree.protected && worktree.protectionReason) {
    parts.push(STORAGE_PROTECTION_COPY[worktree.protectionReason]);
  }
  return parts.join(" · ");
}

function threadCaption(thread: StorageThreadView): string {
  const parts = [idleCaption(thread.idleDays)];
  if (thread.protected && thread.protectionReason) {
    parts.push(STORAGE_PROTECTION_COPY[thread.protectionReason]);
  }
  return parts.join(" · ");
}

/** The stacked bar: one segment per category with disk usage, largest first. */
function StorageBar({ report }: { report: StorageReport }) {
  const used = report.categories.filter((category) => category.bytes > 0);
  if (report.totalBytes <= 0 || used.length === 0) return null;
  const ordered = [...used].sort((a, b) => b.bytes - a.bytes);
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-pill bg-control"
      role="img"
      aria-label={`Disk use by category: ${ordered
        .map((category) => `${storageCategoryLabel(category.id)} ${formatStorageBytes(category.bytes)}`)
        .join(", ")}`}
    >
      {ordered.map((category, index) => (
        <span
          key={category.id}
          aria-hidden="true"
          className="h-full first:rounded-l-pill last:rounded-r-pill"
          style={{
            width: `${Math.max(0.8, storageSharePercent(category.bytes, report.totalBytes))}%`,
            backgroundColor: `var(--chart-${(index % 8) + 1})`,
          }}
        />
      ))}
    </div>
  );
}

function StorageLegend({ report }: { report: StorageReport }) {
  return (
    <ul className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-6 gap-y-1.5">
      {[...report.categories]
        .sort((a, b) => b.bytes - a.bytes)
        .map((category, index) => (
          <li key={category.id} className="flex min-w-0 items-baseline gap-2 text-small">
            <span
              aria-hidden="true"
              className="mt-1 size-2 shrink-0 rounded-full"
              style={{ backgroundColor: `var(--chart-${(index % 8) + 1})` }}
            />
            <span className="min-w-0 flex-1 truncate text-secondary">
              {storageCategoryLabel(category.id)}
            </span>
            <span className="shrink-0 tabular-nums text-tertiary">
              {formatStorageBytes(category.bytes)}
            </span>
          </li>
        ))}
    </ul>
  );
}

/** One expandable list of the largest items, grouped by kind. */
function LargestItems({
  report,
  onDelete,
  deleting,
}: {
  report: StorageReport;
  onDelete: (item: { kind: "worktree" | "thread"; id: string; label: string }) => void;
  deleting: string | null;
}) {
  const [open, setOpen] = React.useState(true);
  const worktrees = report.worktrees.slice(0, 8);
  const threads = report.threads.slice(0, 8);
  if (worktrees.length === 0 && threads.length === 0) {
    return (
      <EmptyState
        placement="inline"
        title="Nothing to list yet"
        description="Worktrees and threads appear here once Aiden has some, largest first."
      />
    );
  }
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <Text variant="strong">Largest items</Text>
        <Text variant="small" color="tertiary">
          {open ? "Hide" : "Show"}
        </Text>
      </button>
      {open ? (
        <div className="border-t border-separator">
          {worktrees.length > 0 ? (
            <div>
              <div className="px-4 pt-3 pb-1 text-mini text-tertiary">Worktrees</div>
              {worktrees.map((worktree) => (
                <ItemRow
                  key={`worktree:${worktree.workspaceId}`}
                  label={worktree.name}
                  caption={worktreeCaption(worktree)}
                  bytes={worktree.bytes}
                  protectedReason={
                    worktree.protected && worktree.protectionReason
                      ? STORAGE_PROTECTION_COPY[worktree.protectionReason]
                      : undefined
                  }
                  busy={deleting === `worktree:${worktree.workspaceId}`}
                  onDelete={
                    worktree.protected
                      ? undefined
                      : () =>
                          onDelete({
                            kind: "worktree",
                            id: worktree.workspaceId,
                            label: worktree.name,
                          })
                  }
                />
              ))}
            </div>
          ) : null}
          {threads.length > 0 ? (
            <div>
              <div className="px-4 pt-3 pb-1 text-mini text-tertiary">Threads</div>
              {threads.map((thread) => (
                <ItemRow
                  key={`thread:${thread.chatId}`}
                  label={thread.title}
                  caption={threadCaption(thread)}
                  bytes={thread.bytes}
                  protectedReason={
                    thread.protected && thread.protectionReason
                      ? STORAGE_PROTECTION_COPY[thread.protectionReason]
                      : undefined
                  }
                  busy={deleting === `thread:${thread.chatId}`}
                  onDelete={
                    thread.protected
                      ? undefined
                      : () =>
                          onDelete({ kind: "thread", id: thread.chatId, label: thread.title })
                  }
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ItemRow({
  label,
  caption,
  bytes,
  protectedReason,
  busy,
  onDelete,
}: {
  label: string;
  caption: string;
  bytes: number;
  protectedReason?: string;
  busy: boolean;
  onDelete?: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-strong text-primary">{label}</div>
        <div className="truncate text-small text-secondary">{caption}</div>
      </div>
      {protectedReason ? (
        <Badge color="warning" className="shrink-0">
          Kept
        </Badge>
      ) : null}
      <Text variant="small" color="tertiary" className="shrink-0 tabular-nums">
        {formatStorageBytes(bytes)}
      </Text>
      {onDelete ? (
        <Button
          size="small"
          variant="filled"
          disabled={busy}
          aria-label={`Delete ${label}`}
          onClick={onDelete}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      ) : null}
    </div>
  );
}

function InactiveDaysSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: StorageInactiveDays;
  onChange: (value: StorageInactiveDays) => void;
  label: string;
  disabled: boolean;
}) {
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => onChange(Number(next) as StorageInactiveDays)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label}>
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
  );
}

/** Settings → Storage: how much disk Aiden uses and what can be cleaned up. */
export function StorageSettings() {
  const [report, setReport] = React.useState<StorageReport | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [busy, setBusy] = React.useState<Busy>(null);
  const [worktreeDays, setWorktreeDays] = React.useState<StorageInactiveDays>(
    DEFAULT_STORAGE_INACTIVE_DAYS,
  );
  const [threadDays, setThreadDays] = React.useState<StorageInactiveDays>(
    DEFAULT_THREAD_INACTIVE_DAYS,
  );
  const [preview, setPreview] = React.useState<{
    action: StorageCleanupAction;
    data: StorageCleanupPreview;
  } | null>(null);
  const [singleDelete, setSingleDelete] = React.useState<{
    kind: "worktree" | "thread";
    id: string;
    label: string;
  } | null>(null);
  const refreshRef = React.useRef<HTMLButtonElement | null>(null);

  const load = React.useCallback(async (mode: "read" | "refresh") => {
    try {
      const next = mode === "refresh" ? await storageApi.refresh() : await storageApi.report();
      setReport(next);
      setLoadFailed(false);
      return next;
    } catch {
      setLoadFailed(true);
      return null;
    }
  }, []);

  React.useEffect(() => {
    // Subscribe before the first read, so a scan that finishes behind the page
    // is never missed.
    const stop = storageApi.onChange((event) => {
      if (event?.kind === "scan-finished") void load("read");
    });
    void load("read");
    return stop;
  }, [load]);

  const scanning = report?.scan.status === "scanning";

  const openPreview = async (action: StorageCleanupAction, inactiveDays: StorageInactiveDays) => {
    if (busy) return;
    setBusy(action);
    try {
      const data = await storageApi.preview({ action, inactiveDays });
      setPreview({ action, data });
    } catch {
      toast.error("Aiden could not work out what would be removed.");
    } finally {
      setBusy(null);
    }
  };

  const runCleanup = async () => {
    if (!preview || busy) return;
    const { action, data } = preview;
    setBusy(action);
    try {
      const result = await storageApi.cleanup({
        action,
        inactiveDays: data.inactiveDays,
        targetIds: data.items.map((item) => item.id),
      });
      const freed = formatStorageBytes(result.freedBytes);
      if (result.removed.length === 0) {
        toast.error(result.failed[0]?.reason ?? "Nothing could be removed.");
      } else if (result.failed.length > 0) {
        toast.error(`Freed ${freed}. ${result.failed.length} item${result.failed.length === 1 ? "" : "s"} could not be removed.`);
      } else {
        toast.success(`Freed ${freed}.`);
      }
      setPreview(null);
      await load("refresh");
    } catch {
      toast.error("Aiden could not finish cleaning up.");
    } finally {
      setBusy(null);
    }
  };

  const runSingleDelete = async () => {
    if (!singleDelete || busy) return;
    const isWorktree = singleDelete.kind === "worktree";
    setBusy(isWorktree ? "remove-worktrees" : "delete-threads");
    try {
      const result = await storageApi.cleanup({
        action: isWorktree ? "remove-worktrees" : "delete-threads",
        // Naming one item skips the inactivity window; protection still applies.
        inactiveDays: isWorktree ? worktreeDays : threadDays,
        targetIds: [singleDelete.id],
      });
      if (result.removed.length === 0) {
        toast.error(result.failed[0]?.reason ?? "Aiden kept this item.");
      } else {
        toast.success(`Freed ${formatStorageBytes(result.freedBytes)}.`);
      }
      setSingleDelete(null);
      await load("refresh");
    } catch {
      toast.error("Aiden could not remove this item.");
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

  const total = report?.totalBytes ?? 0;
  const cleanupDisabled = busy !== null || scanning || total <= 0;

  return (
    <>
      <FieldSet title="On this computer">
        <Field
          orientation="vertical"
          label={
            <span className="flex items-baseline gap-3">
              <span className="text-heading1 font-semibold tabular-nums">
                {report ? formatStorageBytes(total) : "—"}
              </span>
              <span className="text-small font-normal text-secondary">used by Aiden</span>
            </span>
          }
          description={report ? scanCaption(report.scan) : "Checking how much disk Aiden uses…"}
        >
          <div className="min-w-0">
            {report && total > 0 ? <StorageBar report={report} /> : null}
            {report && total > 0 ? <StorageLegend report={report} /> : null}
            {!report && loadFailed ? (
              <Text variant="small" color="secondary">
                Aiden could not measure local storage. Nothing was changed.
              </Text>
            ) : null}
            <div className="mt-3 flex justify-end">
              <Button
                ref={refreshRef}
                size="small"
                variant="filled"
                disabled={busy !== null || scanning}
                onClick={() => void refresh()}
              >
                {busy === "refresh" || scanning ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                {scanning ? "Measuring…" : "Measure again"}
              </Button>
            </div>
          </div>
        </Field>
      </FieldSet>

      <FieldSet title="Largest items">
        {report ? (
          <LargestItems
            report={report}
            deleting={
              busy === null || singleDelete === null
                ? null
                : `${singleDelete.kind}:${singleDelete.id}`
            }
            onDelete={setSingleDelete}
          />
        ) : (
          <div className="px-4 py-3">
            <Text variant="small" color="secondary">
              Checking…
            </Text>
          </div>
        )}
      </FieldSet>

      <FieldSet title="Clean up">
        <Field
          label="Remove unused worktrees"
          description="Deletes worktrees Aiden created that no one has used in this window. Worktrees with uncommitted or unpushed work, or with a chat using them, are always kept."
        >
          <div className="flex flex-wrap items-center justify-end gap-2 max-[540px]:justify-start">
            <InactiveDaysSelect
              value={worktreeDays}
              onChange={setWorktreeDays}
              label="Worktrees unused for"
              disabled={cleanupDisabled}
            />
            <Button
              size="small"
              variant="filled"
              disabled={cleanupDisabled || (report?.worktrees.length ?? 0) === 0}
              onClick={() => void openPreview("remove-worktrees", worktreeDays)}
            >
              {busy === "remove-worktrees" && !preview ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Review…
            </Button>
          </div>
        </Field>

        <Field
          className="border-t border-separator"
          label="Delete inactive threads"
          description="Deletes chats and everything they own — transcripts, images, and private per-chat history. Pinned threads, threads a Bot or Design project owns, and threads in use are always kept."
        >
          <div className="flex flex-wrap items-center justify-end gap-2 max-[540px]:justify-start">
            <InactiveDaysSelect
              value={threadDays}
              onChange={setThreadDays}
              label="Threads unused for"
              disabled={cleanupDisabled}
            />
            <Button
              size="small"
              variant="filled"
              disabled={cleanupDisabled || (report?.threads.length ?? 0) === 0}
              onClick={() => void openPreview("delete-threads", threadDays)}
            >
              {busy === "delete-threads" && !preview ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Review…
            </Button>
          </div>
        </Field>

        <Field
          className="border-t border-separator"
          label="Clear logs and diagnostics"
          description="Removes Aiden's local diagnostic journal, crash dumps, and terminal scrollback. Chats, settings, credentials, and projects stay untouched."
        >
          <div className="settings-action-align-narrow flex justify-end max-[540px]:justify-start">
            <Button
              size="small"
              variant="filled"
              disabled={cleanupDisabled}
              onClick={() => void openPreview("clear-logs", worktreeDays)}
            >
              {busy === "clear-logs" && !preview ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Clear…
            </Button>
          </div>
        </Field>
      </FieldSet>

      <Text as="p" variant="small" color="tertiary" className="px-1">
        Aiden only removes worktrees it created and threads it owns. Everything it keeps stays on
        this device and never leaves unless you send it.
      </Text>

      <AlertDialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title={preview ? previewTitle(preview.action) : ""}
        description={preview ? previewDescription(preview.action, preview.data) : undefined}
        confirmLabel={
          busy === preview?.action
            ? "Removing…"
            : preview
              ? previewConfirmLabel(preview.action, preview.data)
              : "Remove"
        }
        confirmVariant={preview?.action === "clear-logs" ? undefined : "destructive"}
        busy={busy === preview?.action}
        keepOpenOnConfirm
        returnFocus={() => refreshRef.current}
        onConfirm={runCleanup}
      >
        {preview ? <PreviewList preview={preview.data} /> : null}
      </AlertDialog>

      <AlertDialog
        open={singleDelete !== null}
        onOpenChange={(open) => {
          if (!open) setSingleDelete(null);
        }}
        title={singleDelete?.kind === "worktree" ? "Remove this worktree?" : "Delete this thread?"}
        description={
          singleDelete?.kind === "worktree"
            ? "Aiden removes its checkout and the workspace record. Worktrees with local work are kept instead."
            : "This permanently deletes the chat and everything it owns. Chats in use or pinned are kept instead."
        }
        confirmLabel={busy === null ? "Remove" : "Removing…"}
        confirmVariant="destructive"
        busy={busy !== null}
        keepOpenOnConfirm
        returnFocus={() => refreshRef.current}
        onConfirm={runSingleDelete}
      />

      {loadFailed ? (
        <p role="status" className="px-1 text-small text-secondary">
          Local storage could not be read. Your files are unchanged.
        </p>
      ) : null}
    </>
  );
}

function previewTitle(action: StorageCleanupAction): string {
  if (action === "remove-worktrees") return "Remove unused worktrees?";
  if (action === "delete-threads") return "Delete inactive threads?";
  return "Clear logs and diagnostics?";
}

function previewConfirmLabel(action: StorageCleanupAction, preview: StorageCleanupPreview): string {
  if (preview.items.length === 0) return "Nothing to remove";
  const freed = formatStorageBytes(preview.totalBytes);
  if (action === "clear-logs") return `Clear ${freed}`;
  return `Remove ${preview.items.length} · ${freed}`;
}

function previewDescription(action: StorageCleanupAction, preview: StorageCleanupPreview): string {
  if (preview.items.length === 0) {
    return action === "clear-logs"
      ? "There are no logs to clear right now."
      : `Nothing has been unused for ${preview.inactiveDays} days.`;
  }
  const freed = formatStorageBytes(preview.totalBytes);
  const kept =
    preview.skipped.length > 0
      ? ` ${preview.skipped.length} ${preview.skipped.length === 1 ? "item is" : "items are"} kept and not touched.`
      : "";
  return `This frees ${freed}.${kept}`;
}

function PreviewList({ preview }: { preview: StorageCleanupPreview }) {
  const items = preview.items.slice(0, 50);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {items.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-1">
          {items.map((item: StorageItem) => (
            <li key={item.id} className="flex min-w-0 items-baseline gap-3 text-small">
              <span className="min-w-0 flex-1 truncate text-primary">{item.label}</span>
              {item.detail ? (
                <span className="shrink-0 truncate text-tertiary">{item.detail}</span>
              ) : null}
              <span className="shrink-0 tabular-nums text-secondary">
                {formatStorageBytes(item.bytes)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {preview.items.length > items.length ? (
        <Text variant="small" color="tertiary">
          and {preview.items.length - items.length} more
        </Text>
      ) : null}
      {preview.skipped.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1 border-t border-separator pt-3">
          <Text variant="small-strong" color="secondary">
            Kept
          </Text>
          {preview.skipped.slice(0, 20).map((entry) => (
            <div key={entry.id} className="flex min-w-0 items-baseline gap-3 text-small">
              <span className="min-w-0 flex-1 truncate text-secondary">{entry.label}</span>
              <span className="shrink-0 text-tertiary">{skipReasonLabel(entry.reason)}</span>
            </div>
          ))}
          {preview.skipped.length > 20 ? (
            <Text variant="small" color="tertiary">
              and {preview.skipped.length - 20} more
            </Text>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function skipReasonLabel(reason: string): string {
  if (reason === "recent") return "Used recently";
  const copy = STORAGE_PROTECTION_COPY[reason as keyof typeof STORAGE_PROTECTION_COPY];
  return copy ?? "Kept";
}
