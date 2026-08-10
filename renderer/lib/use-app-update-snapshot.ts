import * as React from "react";

import { appUpdatesApi } from "./ipc";
import { IDLE_APP_UPDATE_SNAPSHOT, type AppUpdateSnapshot } from "../shared/app-update";

export function useAppUpdateSnapshot(): AppUpdateSnapshot {
  const [snapshot, setSnapshot] = React.useState<AppUpdateSnapshot>(IDLE_APP_UPDATE_SNAPSHOT);

  React.useEffect(() => {
    let cancelled = false;
    let notificationRevision = 0;
    const applySnapshot = (next: AppUpdateSnapshot) => {
      if (!cancelled) setSnapshot(next);
    };
    const unsubscribe = appUpdatesApi.onStateChanged((next) => {
      notificationRevision += 1;
      applySnapshot(next);
    });
    const requestedAtRevision = notificationRevision;
    void appUpdatesApi
      .state()
      .then((next) => {
        if (notificationRevision === requestedAtRevision) applySnapshot(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return snapshot;
}
