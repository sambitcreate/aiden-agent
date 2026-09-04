import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RefreshCw, UploadCloud } from "lucide-react";
import { gitApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import type { GitPushCapability } from "../lib/types";
import {
  Button,
  Dialog,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from "./ui";

export function GitPushDialog({
  workspaceId,
  capability,
  blockedReason,
  open,
  onOpenChange,
  onBusyChange,
  onCapabilityChange,
  returnFocus,
}: {
  workspaceId: string;
  capability: GitPushCapability | null;
  blockedReason: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onCapabilityChange: (capability: GitPushCapability) => void;
  returnFocus: () => HTMLElement | null;
}) {
  const queryClient = useQueryClient();
  const [remote, setRemote] = React.useState("");
  const [destinationBranch, setDestinationBranch] = React.useState("");
  const [setUpstream, setSetUpstream] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [needsRefresh, setNeedsRefresh] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const originWorkspaceRef = React.useRef<string | null>(null);
  const destinationRef = React.useRef<HTMLInputElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  const invalidateGitState = React.useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.gitReview(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.git(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.gitBranches(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.gitPushCapability(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.gitComparisons(workspaceId) }),
      ]),
    [queryClient, workspaceId],
  );

  React.useEffect(() => {
    if (!open) {
      originWorkspaceRef.current = null;
      return;
    }
    if (originWorkspaceRef.current === null) {
      originWorkspaceRef.current = workspaceId;
      const nextRemote = capability?.suggestedRemote ?? capability?.remotes[0] ?? "";
      const nextDestination = capability?.destinationBranch ?? capability?.branch ?? "";
      setRemote(nextRemote);
      setDestinationBranch(nextDestination);
      setSetUpstream(capability?.upstream !== `${nextRemote}/${nextDestination}`);
      setBusy(false);
      setRefreshing(false);
      setNeedsRefresh(false);
      setError(null);
      return;
    }
    if (originWorkspaceRef.current !== workspaceId && !busy) onOpenChange(false);
  }, [busy, capability, onOpenChange, open, workspaceId]);

  const refreshCapability = async () => {
    if (busy || refreshing) return;
    setRefreshing(true);
    try {
      const latest = await gitApi.pushCapability(workspaceId);
      queryClient.setQueryData(queryKeys.gitPushCapability(workspaceId), latest);
      onCapabilityChange(latest);
      if (!latest.remotes.includes(remote)) setRemote(latest.suggestedRemote ?? latest.remotes[0] ?? "");
      if (!destinationBranch) setDestinationBranch(latest.destinationBranch ?? latest.branch ?? "");
      setNeedsRefresh(false);
      setError(null);
      requestAnimationFrame(() => {
        if (latest.allowed) destinationRef.current?.focus();
        else cancelRef.current?.focus();
      });
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Aiden could not refresh the push state.");
    } finally {
      setRefreshing(false);
    }
  };

  const push = async () => {
    const expectedHead = capability?.expectedHead;
    const expectedBranch = capability?.branch;
    const expectedRemoteIdentity = capability?.remoteIdentities[remote];
    const destination = destinationBranch.trim();
    if (
      busy ||
      blockedReason ||
      !capability?.allowed ||
      !expectedBranch ||
      !expectedHead ||
      !expectedRemoteIdentity ||
      !remote ||
      !destination ||
      needsRefresh
    ) {
      return;
    }
    setBusy(true);
    onBusyChange(true);
    setError(null);
    let closeAfterSuccess = false;
    try {
      const result = await gitApi.push(workspaceId, {
        destinationBranch: destination,
        expectedBranch,
        expectedHead,
        expectedRemoteIdentity,
        remote,
        setUpstream,
      });
      await invalidateGitState();
      closeAfterSuccess = true;
      toast.success(`Pushed ${result.branch} to ${result.remote}/${result.destinationBranch}.`);
      if (result.warning) toast.warning(result.warning);
    } catch (pushError) {
      setError(pushError instanceof Error ? pushError.message : "Aiden could not push this branch.");
      setNeedsRefresh(true);
      void invalidateGitState();
    } finally {
      onBusyChange(false);
      setBusy(false);
      if (closeAfterSuccess) requestAnimationFrame(() => onOpenChange(false));
    }
  };

  const disabledReason = busy ? null : blockedReason ?? capability?.reason ?? null;
  const confirmDisabled =
    busy ||
    refreshing ||
    needsRefresh ||
    Boolean(disabledReason) ||
    !capability?.branch ||
    !capability?.expectedHead ||
    !capability?.remoteIdentities[remote] ||
    !remote ||
    !destinationBranch.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
      title="Push branch"
      description={
        <>
          Push the reviewed <span className="font-medium text-primary">{capability?.branch ?? "current branch"}</span> commit.
          Aiden uses a normal non-force push and does not fetch first.
        </>
      }
      confirmLabel={busy ? "Pushing…" : "Push"}
      confirmDisabled={confirmDisabled}
      confirmHidden={!capability?.allowed}
      cancelRef={cancelRef}
      dismissDisabled={busy}
      onConfirm={push}
      returnFocus={returnFocus}
    >
      <div className="space-y-4" aria-busy={busy}>
        {capability?.allowed ? (
          <>
            <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3">
              <div>
                <Label htmlFor="environment-push-remote">Remote</Label>
                <Select value={remote} onValueChange={setRemote} disabled={busy || refreshing}>
                  <SelectTrigger id="environment-push-remote" className="mt-1.5" aria-label="Push remote">
                    <SelectValue placeholder="Choose remote" />
                  </SelectTrigger>
                  <SelectContent>
                    {capability.remotes.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="environment-push-destination">Destination branch</Label>
                <Input
                  ref={destinationRef}
                  id="environment-push-destination"
                  value={destinationBranch}
                  onChange={(event) => setDestinationBranch(event.target.value)}
                  disabled={busy || refreshing}
                  className="mt-1.5"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
            </div>

            <Label className="items-start justify-between rounded-control border border-field px-3 py-2.5">
              <span className="min-w-0 pr-3">
                <span className="block text-regular text-primary">Remember as upstream</span>
                <span className="mt-0.5 block text-small text-secondary">
                  Future ahead/behind counts use the last-fetched tracking ref. Aiden still never fetches implicitly.
                </span>
              </span>
              <Switch
                checked={setUpstream}
                onCheckedChange={setSetUpstream}
                disabled={busy || refreshing}
                aria-label="Remember destination as upstream"
                className="shrink-0"
              />
            </Label>

            <div className="rounded-control bg-well px-3 py-2 text-small text-secondary">
              Pre-push hooks and configured Git authentication may run. Force push and submodule recursion are never used.
            </div>
          </>
        ) : null}

        {busy ? (
          <div className="flex items-center gap-2 rounded-control bg-status-accent-surface px-3 py-2 text-small text-status-accent" role="status">
            <UploadCloud className="size-4 shrink-0" aria-hidden="true" />
            <span>Pushing the frozen commit… Workspace switching and dismissal stay locked.</span>
          </div>
        ) : disabledReason ? (
          <div className="flex items-start gap-2 rounded-control bg-status-warning-surface px-3 py-2 text-small text-status-warning" role="status">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{disabledReason}</span>
          </div>
        ) : error ? (
          <div className="rounded-control bg-status-red-surface px-3 py-2 text-small text-status-red" role="alert">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
            {needsRefresh ? (
              <Button
                type="button"
                variant="transparent"
                size="small"
                disabled={refreshing}
                onClick={() => void refreshCapability()}
                className="mt-2 text-primary"
              >
                <RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
                {refreshing ? "Refreshing…" : "Refresh branch state"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
