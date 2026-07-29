export interface AppUpdaterEnvironment {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  runtimeProfile: "production" | "development";
  updateConfigExists: boolean;
}

export function shouldEnableAppUpdates(environment: AppUpdaterEnvironment): boolean {
  return (
    environment.platform === "darwin" &&
    environment.isPackaged &&
    environment.runtimeProfile === "production" &&
    environment.updateConfigExists
  );
}
