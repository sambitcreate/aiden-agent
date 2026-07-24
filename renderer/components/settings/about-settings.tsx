import * as React from "react";
import { Github } from "lucide-react";
import { Button, FieldSet } from "../ui";
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

  return (
    <FieldSet title="About">
      <div className="flex items-center gap-4 p-4 max-[540px]:items-start">
        <img src={APP_ICON_URL} alt="" className="size-16 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-large-strong text-primary">{appInfo?.name ?? "Aiden Agent"}</h3>
          <p className="mt-0.5 text-small text-secondary">
            {appInfo ? (
              <>
                Version {appInfo.version} <span aria-hidden="true">·</span> Beta{" "}
                <span aria-hidden="true">·</span>{" "}
                {buildLabel(appInfo.environment)}
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
    </FieldSet>
  );
}
