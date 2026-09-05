import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react";
import { Badge, Button, Callout, Dialog, Field, FieldSet, Switch, Text, toast } from "../ui";
import { computerUseApi } from "../../lib/ipc";
import { reduceComputerUseRefreshState } from "../../lib/computer-use-control";
import {
  restoreComputerUseNotice,
  useComputerUseNoticeDismissed,
} from "../../lib/computer-use-notice";
import { queryKeys, useComputerUseStatus, useSettings } from "../../lib/queries";
import type { AppSettings, ComputerUseStatus } from "../../lib/types";

function statusPresentation(status: ComputerUseStatus | undefined, failed: boolean) {
  if (failed) {
    return { label: "Check failed", color: "red", icon: TriangleAlert, iconClass: "text-red" };
  }
  if (!status) {
    return { label: "Checking…", color: undefined, icon: Loader2, iconClass: "animate-spin" };
  }
  if (status.state === "ready") {
    return { label: "Ready", color: "green", icon: CheckCircle2, iconClass: "text-green" };
  }
  if (status.state === "permission_required") {
    return {
      label: "Permission needed",
      color: undefined,
      icon: ShieldAlert,
      iconClass: "text-support-warning",
    };
  }
  if (status.state === "disabled") {
    return { label: "Off", color: undefined, icon: ShieldAlert, iconClass: "text-tertiary" };
  }
  return { label: "Unavailable", color: "red", icon: TriangleAlert, iconClass: "text-red" };
}

export function ComputerUseSettings() {
  const queryClient = useQueryClient();
  const statusQuery = useComputerUseStatus();
  const settingsQuery = useSettings();
  const [enableReview, setEnableReview] = React.useState(false);
  const [enableError, setEnableError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [pendingEnabled, setPendingEnabled] = React.useState<boolean | null>(null);
  const [requesting, setRequesting] = React.useState(false);
  const computerUseNoticeDismissed = useComputerUseNoticeDismissed();
  const [refreshState, updateRefreshState] = React.useReducer(reduceComputerUseRefreshState, {
    refreshing: false,
    error: null,
  });
  const { refreshing, error: refreshError } = refreshState;
  React.useEffect(() => {
    if (statusQuery.isSuccess && statusQuery.dataUpdatedAt > 0) {
      updateRefreshState({ type: "succeeded" });
    }
  }, [statusQuery.dataUpdatedAt, statusQuery.isSuccess]);
  const status = statusQuery.data;
  const persistedEnabled = status
    ? status.enabled
    : settingsQuery.data?.computerUseEnabled === true;
  const enabled = pendingEnabled ?? persistedEnabled;
  const statusFailed = statusQuery.isError || refreshError !== null;
  const presentation = refreshing
    ? { label: "Checking…", color: undefined, icon: Loader2, iconClass: "animate-spin" }
    : statusPresentation(status, statusFailed);
  const StatusIcon = presentation.icon;

  const commitStatus = React.useCallback(
    (next: ComputerUseStatus) => {
      updateRefreshState({ type: "succeeded" });
      queryClient.setQueryData(queryKeys.computerUseStatus, next);
      queryClient.setQueryData<AppSettings | undefined>(queryKeys.settings, (current) =>
        current ? { ...current, computerUseEnabled: next.enabled } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
    [queryClient],
  );

  const toggle = async (enabled: boolean) => {
    if (saving) return;
    setSaving(true);
    setEnableError(null);
    setPendingEnabled(enabled);
    try {
      await queryClient.cancelQueries({ queryKey: queryKeys.computerUseStatus });
      const next = await computerUseApi.setEnabled(enabled);
      commitStatus(next);
      setEnableReview(false);
      if (enabled && next.state !== "ready" && next.state !== "permission_required") {
        toast.error(next.detail);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't update Computer Use.";
      setEnableError(message);
      toast.error(message);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.computerUseStatus }),
      ]);
    } finally {
      setPendingEnabled(null);
      setSaving(false);
    }
  };

  const refresh = async () => {
    if (refreshing) return;
    updateRefreshState({ type: "start" });
    try {
      commitStatus(await computerUseApi.status(true));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't check Computer Use.";
      updateRefreshState({ type: "failed", error: message });
      toast.error(message);
    }
  };

  const requestPermissions = async () => {
    if (requesting) return;
    setRequesting(true);
    try {
      const next = await computerUseApi.requestPermissions();
      commitStatus(next);
      if (!next.ready) toast.info(next.detail);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't request access.");
    } finally {
      setRequesting(false);
    }
  };

  return (
    <>
      <FieldSet
        title={
          <span className="inline-flex items-center gap-2">
            Computer Use <Badge color="blue">Beta</Badge>
          </span>
        }
      >
        <Field
          label="Enable Computer Use"
          description="Let Aiden see your screen and help with apps when you turn it on in a chat."
        >
          <div className="flex justify-end">
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => checked ? setEnableReview(true) : void toggle(false)}
              disabled={saving || settingsQuery.isLoading}
              aria-label="Enable Computer Use beta"
            />
            {saving ? (
              <Text role="status" variant="small" color="secondary" className="ml-2">
                Saving…
              </Text>
            ) : null}
          </div>
        </Field>
        <Field
          label="Allow access on your Mac"
          description="macOS will ask you to allow Aiden Computer Use to see the screen and interact with apps."
          orientation="vertical"
        >
          <Callout
            aria-live="polite"
            aria-busy={refreshing}
            role={statusFailed ? "alert" : undefined}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <StatusIcon className={`mt-0.5 size-4 shrink-0 ${presentation.iconClass}`} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Text variant="small-strong">{presentation.label}</Text>

                  </div>
                  <Text as="p" variant="small" color="secondary" className="mt-1">
                    {refreshError ??
                      (statusQuery.isError
                        ? "Aiden couldn’t check the signed Computer Use helper. Try again."
                        : (status?.detail ?? "Checking the signed Computer Use helper…"))}
                  </Text>
                </div>
              </div>
              {enabled || statusQuery.isError ? (
                <Button
                  size="small"
                  variant="transparent"
                  iconOnly
                  onClick={() => void refresh()}
                  disabled={refreshing || statusQuery.isFetching || requesting || saving}
                  aria-label="Check Computer Use again"
                  title="Check again"
                >
                  <RefreshCw
                    className={refreshing || statusQuery.isFetching ? "animate-spin" : undefined}
                  />
                </Button>
              ) : null}
            </div>
            {status?.canRequestPermissions ? (
              <div className="mt-3 flex justify-end">
                <Button
                  size="small"
                  onClick={() => void requestPermissions()}
                  disabled={requesting}
                >
                  {requesting ? <Loader2 className="animate-spin" /> : <ShieldAlert />}
                  {requesting ? "Requesting…" : "Open Mac permissions"}
                </Button>
              </div>
            ) : null}
          </Callout>
        </Field>
      </FieldSet>

      <Dialog open={enableReview} onOpenChange={setEnableReview} title="Let Aiden help with apps?"
        description="You choose which chats can use this."
        confirmLabel="Enable Computer Use" busy={saving}
        onConfirm={() => toggle(true)}>
        <Text as="p" color="secondary">When you turn this on in a chat, its selected AI provider may receive screenshots and text visible in your apps. Each click or typing action asks for your permission. You can stop or turn it off at any time.</Text>
        <Text as="p" color="secondary">Next, allow Screen Recording and Accessibility in macOS. Enabling this feature alone does not share your screen.</Text>
        {enableError ? <Callout color="red" role="alert">{enableError}</Callout> : null}
      </Dialog>
      <FieldSet title="How it behaves">
        <div className="settings-computer-use-grid grid grid-cols-[minmax(0,1fr)_auto] items-start gap-6 p-4 max-[640px]:grid-cols-1 max-[640px]:gap-3">
          <Text as="p" variant="small" color="secondary" className="max-w-[46rem] text-pretty">
            Only chats you turn on can use Computer Use. For those responses, your selected model
            may receive screenshots, window details, and accessibility text. Aiden doesn’t save that
            content; your provider handles it under its data policy. Read-only inspection runs
            without prompts, while every control action requires Allow once.
          </Text>
          <div className="settings-computer-use-actions flex min-w-0 flex-col items-end gap-2 max-[640px]:items-start">
            <div className="settings-action-align flex flex-wrap justify-end gap-2 max-[640px]:justify-start">
              <Badge className="whitespace-nowrap">Per-chat opt-in</Badge>
              <Badge className="whitespace-nowrap">Actions ask first</Badge>
            </div>
            {computerUseNoticeDismissed ? (
              <Button
                size="small"
                variant="transparent"
                className="h-7 px-2 text-secondary"
                onClick={restoreComputerUseNotice}
              >
                Show privacy notice again
              </Button>
            ) : null}
          </div>
        </div>
      </FieldSet>
    </>
  );
}
