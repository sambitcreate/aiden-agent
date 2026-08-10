import * as React from "react";
import { Github, Loader2, RotateCcw } from "lucide-react";
import { AlertDialog, Button, Field, FieldSet, toast } from "../ui";
import { appApi, type AppInfo } from "../../lib/ipc";

const APP_ICON_URL = new URL("../../../resources/app-icon.png", import.meta.url).href;
const REPOSITORY_URL = "https://github.com/sambitcreate/aiden-agent";

function buildLabel(environment: string): string {
  return environment.toLocaleLowerCase() === "development"
    ? "Development build"
    : "Production build";
}

export function AboutSettings() {
  const [appInfo, setAppInfo] = React.useState<AppInfo | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [resetError, setResetError] = React.useState<string | null>(null);
  const resetButtonRef = React.useRef<HTMLButtonElement | null>(null);

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
