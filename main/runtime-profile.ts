import { mkdirSync } from "node:fs";

import { app } from "electron";
import {
  AIDEN_CONFIG_DIR_ENV,
  AIDEN_RUNTIME_PROFILE_ENV,
  resolveRuntimeProfile,
  type RuntimeProfile,
} from "./runtime-profile-core.js";

let configuredProfile: RuntimeProfile | null = null;

/**
 * Configure identity and storage before importing the main application.
 * Electron's single-instance lock, Chromium session, crash reporter, logs,
 * machine-local state, and portable config must all observe the same profile.
 */
export function configureRuntimeProfile(): RuntimeProfile {
  if (configuredProfile) return configuredProfile;

  const profile = resolveRuntimeProfile({
    appDataPath: app.getPath("appData"),
    explicitUserDataPath: app.commandLine.hasSwitch("user-data-dir")
      ? app.commandLine.getSwitchValue("user-data-dir")
      : undefined,
    homePath: app.getPath("home"),
    isPackaged: app.isPackaged,
    environment: process.env,
  });

  for (const directory of new Set([
    profile.userDataPath,
    profile.sessionDataPath,
    profile.logsPath,
    profile.crashDumpsPath,
    profile.configDir,
  ])) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  app.setName(profile.appName);
  app.setPath("userData", profile.userDataPath);
  app.setPath("sessionData", profile.sessionDataPath);
  app.setPath("crashDumps", profile.crashDumpsPath);
  app.setAppLogsPath(profile.logsPath);
  process.env[AIDEN_RUNTIME_PROFILE_ENV] = profile.id;
  process.env[AIDEN_CONFIG_DIR_ENV] = profile.configDir;
  configuredProfile = profile;
  return profile;
}

export function currentRuntimeProfile(): RuntimeProfile {
  if (!configuredProfile) {
    throw new Error("Aiden runtime profile was read before bootstrap configuration.");
  }
  return configuredProfile;
}
