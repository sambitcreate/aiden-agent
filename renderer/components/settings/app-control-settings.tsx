import * as React from "react";
import { settingsApi, appControlsApi } from "../../lib/ipc";
import {
  Button,
  Switch,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Dialog,
} from "../ui";
import { resolveAppControlPolicy, type AppControlPolicy } from "../../shared/app-controls";
export function AppControlSettings() {
  const [policy, setPolicy] = React.useState<AppControlPolicy>("safe");
  const [remote, setRemote] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let current = true;
    const refresh = async () => {
      try {
        const settings = await settingsApi.get();
        if (current) {
          setPolicy(resolveAppControlPolicy(settings));
          setRemote(settings.remoteAppControlsEnabled === true);
          setReady(true);
        }
      } catch {
        if (current) setError("App-control settings could not be loaded.");
      }
    };
    void refresh();
    const unsubscribe = appControlsApi.onChanged(() => {
      void refresh();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);
  const save = async (patch: {
    appControlPolicy?: AppControlPolicy;
    remoteAppControlsEnabled?: boolean;
  }) => {
    setBusy(true);
    setError("");
    try {
      const settings = await settingsApi.set(patch);
      setPolicy(resolveAppControlPolicy(settings));
      setRemote(settings.remoteAppControlsEnabled === true);
    } catch {
      setError("App-control settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="appearance-theme-section" aria-labelledby="app-controls-settings-title">
      <h2 id="app-controls-settings-title">Controls in chat</h2>
      <p className="appearance-section-description">
        Ask Aiden how a feature works or to show its settings. Chat controls use the same settings
        and permissions as the app.
      </p>
      <div className="settings-group-card px-4">
        <div className="flex items-center justify-between gap-4 py-3">
          <div>
            <label id="app-controls-policy-label" className="text-small font-medium">
              Agent app actions
            </label>
            <p className="text-mini text-secondary">
              Safe controls permits reversible presentation changes and turning features off.
              Enablement requires your foreground choice. Workspace file access grants no app
              authority.
            </p>
          </div>
          <Select
            value={policy}
            disabled={!ready || busy}
            onValueChange={(value) => {
              void save({ appControlPolicy: value as AppControlPolicy });
            }}
          >
            <SelectTrigger aria-labelledby="app-controls-policy-label" className="max-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">Disabled</SelectItem>
              <SelectItem value="ask">Ask every time</SelectItem>
              <SelectItem value="safe">Safe controls</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-separator py-3">
          <div>
            <label htmlFor="paired-app-controls" className="text-small font-medium">
              Paired-device chat controls
            </label>
            <p className="text-mini text-secondary">
              Allow paired clients to request access to supported host settings through chat. A
              phone's own appearance stays separate.
            </p>
          </div>
          <Switch
            id="paired-app-controls"
            checked={remote}
            disabled={!ready || busy}
            onCheckedChange={(value) => {
              if (value) setConfirm(true);
              else void save({ remoteAppControlsEnabled: false });
            }}
          />
        </div>
      </div>
      {error ? (
        <div role="alert" className="mt-2 flex items-center gap-2 text-small text-secondary">
          {error}
          <Button
            size="small"
            variant="transparent"
            onClick={() => {
              void settingsApi.get().then(
                (settings) => {
                  setPolicy(resolveAppControlPolicy(settings));
                  setRemote(settings.remoteAppControlsEnabled === true);
                  setReady(true);
                  setError("");
                },
                () => setError("App-control settings could not be loaded."),
              );
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Allow paired-device chat controls?"
        description="Paired clients may request access to theme, chat width, Memory, Web Search and Skills controls on this host. Their pairing and workspace grants, app policy and existing setup requirements still apply. This does not allow credentials, terminal access or arbitrary app administration."
        confirmLabel="Allow chat controls"
        onConfirm={() => {
          setConfirm(false);
          void save({ remoteAppControlsEnabled: true });
        }}
      />
    </section>
  );
}
