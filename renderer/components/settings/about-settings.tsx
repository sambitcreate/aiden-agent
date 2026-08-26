import * as React from "react";
import { Download, Github, Loader2, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import { AlertDialog, Button, Field, FieldSet, toast } from "../ui";
import { appApi, appUpdatesApi, type AppInfo } from "../../lib/ipc";
import { useAppUpdateSnapshot } from "../../lib/use-app-update-snapshot";
import type { AppUpdateRestartResult, AppUpdateSnapshot } from "../../shared/app-update";
import { useAppCapabilities } from "../../lib/app-capabilities";

const APP_ICON_URL = new URL("../../../resources/app-icon.png", import.meta.url).href;
const REPOSITORY_URL = "https://github.com/sambitcreate/aiden-agent";
const RELEASES_URL = `${REPOSITORY_URL}/releases`;

function buildLabel(environment: string): string {
  return environment.toLocaleLowerCase() === "development"
    ? "Development build"
    : "Production build";
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function updateDescription(snapshot: AppUpdateSnapshot): string {
  switch (snapshot.status) {
    case "idle":
      return "Aiden checks automatically and downloads signed updates without interrupting your work.";
    case "checking":
      return "Checking the signed Aiden Agent update feed…";
    case "downloading": {
      const progress =
        snapshot.transferred !== null && snapshot.total !== null
          ? `${formatMegabytes(snapshot.transferred)} of ${formatMegabytes(snapshot.total)}`
          : snapshot.percent !== null
            ? `${Math.floor(snapshot.percent)}%`
            : "Starting…";
      return `Downloading Aiden Agent ${snapshot.version} · ${progress}`;
    }
    case "ready":
      return `Aiden Agent ${snapshot.version} is ready. Restart to finish installing it.`;
    case "error":
      return snapshot.error === "download-failed"
        ? `Aiden Agent${snapshot.version ? ` ${snapshot.version}` : ""} couldn’t finish downloading. Check your connection and try again.`
        : "Aiden couldn’t reach the signed update feed. Check your connection and try again.";
  }
}

function updateRestartError(result: AppUpdateRestartResult): string | null {
  if (result.accepted) return null;
  switch (result.reason) {
    case "busy":
      return "Aiden is already preparing another window action.";
    case "not-ready":
      return "That update is no longer ready. Check for updates again.";
    case "unavailable":
      return "Aiden could not restart into the update.";
  }
}

export function AboutSettings() {
  const capabilities = useAppCapabilities();
  const [appInfo, setAppInfo] = React.useState<AppInfo | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [resetError, setResetError] = React.useState<string | null>(null);
  const [updateActionBusy, setUpdateActionBusy] = React.useState(false);
  const [showingOnboarding, setShowingOnboarding] = React.useState(false);
  const resetButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const updateSnapshot = useAppUpdateSnapshot();

  React.useEffect(() => {
    let cancelled = false;
    void appApi
      .getInfo()
      .then((info) => {
        if (!cancelled) setAppInfo(info);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const resetOnboarding = async () => {
    if (resetting) return;
    setResetting(true);
    setResetError(null);
    try {
      const restarting = await appApi.resetOnboarding();
      if (!restarting) {
        throw new Error(
          "Aiden couldn’t restart. Close any active editor or Git operation, then try again.",
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Aiden couldn’t reset onboarding. Try again.";
      setResetError(message);
      toast.error(message);
      setResetting(false);
    }
  };

  const showOnboarding = async () => {
    if (showingOnboarding) return;
    setShowingOnboarding(true);
    try {
      await appApi.setOnboardingOutcome("incomplete");
      window.dispatchEvent(new Event("aiden:show-onboarding"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden couldn't reopen onboarding.");
    } finally {
      setShowingOnboarding(false);
    }
  };

  const checkForUpdates = async () => {
    if (updateActionBusy || updateSnapshot.status === "checking") return;
    setUpdateActionBusy(true);
    try {
      const result = await appUpdatesApi.check();
      if (result.outcome === "up-to-date") {
        toast.success(
          appInfo ? `Aiden Agent ${appInfo.version} is up to date.` : "Aiden Agent is up to date.",
        );
      } else if (result.outcome === "unavailable") {
        toast.info("Automatic updates are available in signed production builds.");
      }
    } catch {
      toast.error("Aiden could not start an update check.");
    } finally {
      setUpdateActionBusy(false);
    }
  };

  const restartToUpdate = async () => {
    if (updateActionBusy || updateSnapshot.status !== "ready") return;
    setUpdateActionBusy(true);
    try {
      const result = await appUpdatesApi.restart();
      const message = updateRestartError(result);
      if (message) {
        setUpdateActionBusy(false);
        toast.error(message);
      } else {
        window.setTimeout(() => setUpdateActionBusy(false), 10_000);
      }
    } catch {
      setUpdateActionBusy(false);
      toast.error("Aiden could not restart into the update.");
    }
  };

  const updateInProgress =
    updateSnapshot.status === "checking" || updateSnapshot.status === "downloading";

  return (
    <>
      <FieldSet title="About">
        <div className="settings-about-header flex items-center gap-4 p-4 max-[540px]:items-start">
          <img src={APP_ICON_URL} alt="" className="size-16 shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="text-large-strong text-primary">{appInfo?.name ?? "Aiden Agent"}</h3>
            <p className="mt-0.5 text-small text-secondary">
              {appInfo ? (
                <>
                  Version {appInfo.version} <span aria-hidden="true">·</span> Beta{" "}
                  <span aria-hidden="true">·</span> {buildLabel(appInfo.environment)}
                </>
              ) : loadFailed ? (
                "Build details unavailable"
              ) : (
                "Loading build details…"
              )}
            </p>
            <Button asChild size="small" variant="filled" className="mt-3">
              <a
                href={REPOSITORY_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="Open the Aiden Agent repository on GitHub"
              >
                <Github />
                GitHub
              </a>
            </Button>
          </div>
        </div>
        <Field
          className="border-t border-separator"
          label="Onboarding"
          description="Reopen setup without deleting providers, credentials, preferences, or other app data."
        >
          <div className="settings-action-align-narrow flex justify-end max-[540px]:justify-start">
            <Button
              size="small"
              variant="filled"
              disabled={showingOnboarding}
              onClick={() => void showOnboarding()}
            >
              {showingOnboarding ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {showingOnboarding ? "Opening…" : "Show onboarding"}
            </Button>
          </div>
        </Field>
        <Field
          className="border-t border-separator"
          label="Software update"
          description={
            capabilities.platform === "linux"
              ? "Install updates through your package manager, or download the newest Linux package from GitHub Releases."
              : updateDescription(updateSnapshot)
          }
        >
          {capabilities.platform === "linux" ? (
            <Button asChild size="small" variant="filled">
              <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                <Download /> Open releases
              </a>
            </Button>
          ) : (
          <div className="flex flex-col items-end gap-2 max-[540px]:items-start">
            {updateSnapshot.status === "downloading" && updateSnapshot.percent !== null ? (
              <div
                className="h-1 w-full max-w-48 overflow-hidden rounded-full bg-control"
                role="progressbar"
                aria-label="Update download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.floor(updateSnapshot.percent)}
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-150"
                  style={{ width: `${updateSnapshot.percent}%` }}
                />
              </div>
            ) : null}
            <Button
              size="small"
              variant={updateSnapshot.status === "ready" ? "accent" : "filled"}
              disabled={updateActionBusy || updateInProgress}
              onClick={() =>
                void (updateSnapshot.status === "ready" ? restartToUpdate() : checkForUpdates())
              }
            >
              {updateActionBusy || updateInProgress ? (
                <Loader2 className="animate-spin" />
              ) : updateSnapshot.status === "ready" ? (
                <Download />
              ) : (
                <RefreshCw />
              )}
              {updateSnapshot.status === "ready"
                ? "Update and restart"
                : updateSnapshot.status === "checking"
                  ? "Checking…"
                  : updateSnapshot.status === "downloading"
                    ? "Downloading…"
                    : updateSnapshot.status === "error"
                      ? "Try again"
                      : "Check for updates"}
            </Button>
          </div>
          )}
        </Field>
        <Field
          className="border-t border-separator"
          label="Reset onboarding"
          description="Clear this profile’s setup and preferences, restart Aiden, and return to the first onboarding step."
        >
          <div className="settings-action-align-narrow flex justify-end max-[540px]:justify-start">
            <Button
              ref={resetButtonRef}
              size="small"
              variant="filled"
              disabled={resetting}
              onClick={() => {
                setResetError(null);
                setConfirmReset(true);
              }}
            >
              {resetting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              {resetting ? "Resetting…" : "Reset onboarding…"}
            </Button>
          </div>
        </Field>
      </FieldSet>

      <AlertDialog
        open={confirmReset}
        onOpenChange={(open) => {
          setConfirmReset(open);
          if (!open) setResetError(null);
        }}
        title="Reset onboarding and restart Aiden?"
        description={
          <div className="space-y-2">
            <p>
              This removes your profile, app preferences, custom provider and MCP setup, saved API
              keys and OAuth sessions, and cached benchmark data.
            </p>
            <p>
              Chats, projects, schedules, skills, and downloaded local models stay. Aiden will
              restart and reopen onboarding.
            </p>
            {resetError ? (
              <p role="alert" className="text-red">
                {resetError}
              </p>
            ) : null}
          </div>
        }
        confirmLabel={resetting ? "Resetting…" : "Reset & restart"}
        confirmVariant="destructive"
        busy={resetting}
        keepOpenOnConfirm
        returnFocus={() => resetButtonRef.current}
        onConfirm={resetOnboarding}
      />
    </>
  );
}
