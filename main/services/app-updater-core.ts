export interface AppUpdaterEnvironment {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  updateConfigExists: boolean;
}

export function shouldEnableAppUpdates(environment: AppUpdaterEnvironment): boolean {
  return (
    environment.platform === "darwin" &&
    environment.isPackaged &&
    environment.updateConfigExists
  );
}
