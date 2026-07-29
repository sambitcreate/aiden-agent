import path from "node:path";

export const AIDEN_RUNTIME_PROFILE_ENV = "AIDEN_RUNTIME_PROFILE";
export const AIDEN_CONFIG_DIR_ENV = "AIDEN_CONFIG_DIR";
export const AIDEN_DEV_GLOBAL_SHORTCUTS_ENV = "AIDEN_DEV_GLOBAL_SHORTCUTS";

export type RuntimeProfileId = "production" | "development";

export interface RuntimeProfile {
  id: RuntimeProfileId;
  appName: string;
  userDataPath: string;
  sessionDataPath: string;
  logsPath: string;
  crashDumpsPath: string;
  configDir: string;
  globalShortcutsEnabled: boolean;
  updatesEnabled: boolean;
}

export interface RuntimeProfileInput {
  appDataPath: string;
  explicitUserDataPath?: string;
  homePath: string;
  isPackaged: boolean;
  environment?: NodeJS.ProcessEnv;
}

function explicitProfile(environment: NodeJS.ProcessEnv): RuntimeProfileId | undefined {
  const value = environment[AIDEN_RUNTIME_PROFILE_ENV]?.trim();
  if (!value) return undefined;
  if (value === "production" || value === "development") return value;
  throw new Error(
    `${AIDEN_RUNTIME_PROFILE_ENV} must be "production" or "development"; received ${JSON.stringify(value)}.`,
  );
}

function configDirectory(
  profile: RuntimeProfileId,
  homePath: string,
  environment: NodeJS.ProcessEnv,
): string {
  const override = environment[AIDEN_CONFIG_DIR_ENV]?.trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error(
        `${AIDEN_CONFIG_DIR_ENV} must be an absolute path; received ${JSON.stringify(override)}.`,
      );
    }
    return path.resolve(override);
  }
  return path.join(homePath, profile === "development" ? ".aiden-dev" : ".aiden");
}

export function resolveRuntimeProfile(input: RuntimeProfileInput): RuntimeProfile {
  const environment = input.environment ?? process.env;
  const id = explicitProfile(environment) ?? (input.isPackaged ? "production" : "development");
  const appName = id === "development" ? "Aiden Agent Dev" : "Aiden Agent";
  const hasExplicitUserDataPath = input.explicitUserDataPath !== undefined;
  const explicitUserDataPath = input.explicitUserDataPath?.trim() ?? "";
  if (hasExplicitUserDataPath && !explicitUserDataPath) {
    throw new Error("Electron's explicit user-data directory cannot be empty.");
  }
  if (hasExplicitUserDataPath && !path.isAbsolute(explicitUserDataPath)) {
    throw new Error(
      `Electron's explicit user-data directory must be absolute; received ${JSON.stringify(explicitUserDataPath)}.`,
    );
  }
  const userDataPath = hasExplicitUserDataPath
    ? path.resolve(explicitUserDataPath)
    : path.join(input.appDataPath, appName);

  return {
    id,
    appName,
    userDataPath,
    sessionDataPath: userDataPath,
    logsPath: path.join(userDataPath, "logs"),
    crashDumpsPath: path.join(userDataPath, "Crashpad"),
    configDir: configDirectory(id, input.homePath, environment),
    globalShortcutsEnabled:
      id === "production" || environment[AIDEN_DEV_GLOBAL_SHORTCUTS_ENV]?.trim() === "1",
    updatesEnabled: id === "production",
  };
}
