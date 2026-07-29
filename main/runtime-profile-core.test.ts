import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  AIDEN_CONFIG_DIR_ENV,
  AIDEN_DEV_GLOBAL_SHORTCUTS_ENV,
  AIDEN_RUNTIME_PROFILE_ENV,
  resolveRuntimeProfile,
} from "./runtime-profile-core.js";

const appDataPath = path.join(path.sep, "Users", "person", "Library", "Application Support");
const homePath = path.join(path.sep, "Users", "person");

test("packaged production preserves the production name and storage roots", () => {
  const profile = resolveRuntimeProfile({
    appDataPath,
    homePath,
    isPackaged: true,
    environment: {},
  });

  assert.equal(profile.id, "production");
  assert.equal(profile.appName, "Aiden Agent");
  assert.equal(profile.userDataPath, path.join(appDataPath, "Aiden Agent"));
  assert.equal(profile.sessionDataPath, profile.userDataPath);
  assert.equal(profile.configDir, path.join(homePath, ".aiden"));
  assert.equal(profile.globalShortcutsEnabled, true);
  assert.equal(profile.updatesEnabled, true);
});

test("unpackaged development has a visible name and entirely separate roots", () => {
  const production = resolveRuntimeProfile({
    appDataPath,
    homePath,
    isPackaged: true,
    environment: {},
  });
  const development = resolveRuntimeProfile({
    appDataPath,
    homePath,
    isPackaged: false,
    environment: {},
  });

  assert.equal(development.id, "development");
  assert.equal(development.appName, "Aiden Agent Dev");
  assert.equal(development.userDataPath, path.join(appDataPath, "Aiden Agent Dev"));
  assert.equal(development.sessionDataPath, development.userDataPath);
  assert.equal(development.configDir, path.join(homePath, ".aiden-dev"));
  assert.equal(development.globalShortcutsEnabled, false);
  assert.equal(development.updatesEnabled, false);
  assert.notEqual(development.userDataPath, production.userDataPath);
  assert.notEqual(development.configDir, production.configDir);
  assert.notEqual(development.logsPath, production.logsPath);
  assert.notEqual(development.crashDumpsPath, production.crashDumpsPath);
});

test("an explicit profile wins over packaging state", () => {
  assert.equal(
    resolveRuntimeProfile({
      appDataPath,
      homePath,
      isPackaged: true,
      environment: { [AIDEN_RUNTIME_PROFILE_ENV]: "development" },
    }).id,
    "development",
  );
  assert.equal(
    resolveRuntimeProfile({
      appDataPath,
      homePath,
      isPackaged: false,
      environment: { [AIDEN_RUNTIME_PROFILE_ENV]: "production" },
    }).id,
    "production",
  );
});

test("invalid profiles and relative portable roots fail closed", () => {
  assert.throws(
    () =>
      resolveRuntimeProfile({
        appDataPath,
        homePath,
        isPackaged: false,
        environment: { [AIDEN_RUNTIME_PROFILE_ENV]: "staging" },
      }),
    /must be "production" or "development"/u,
  );
  assert.throws(
    () =>
      resolveRuntimeProfile({
        appDataPath,
        homePath,
        isPackaged: false,
        environment: { [AIDEN_CONFIG_DIR_ENV]: "relative/config" },
      }),
    /must be an absolute path/u,
  );
});

test("an absolute portable override is preserved for either profile", () => {
  const override = path.join(path.sep, "Volumes", "Aiden Config");
  const profile = resolveRuntimeProfile({
    appDataPath,
    homePath,
    isPackaged: false,
    environment: { [AIDEN_CONFIG_DIR_ENV]: `${override}${path.sep}` },
  });
  assert.equal(profile.configDir, override);
});

test("development global shortcuts are opt-in", () => {
  const profile = resolveRuntimeProfile({
    appDataPath,
    homePath,
    isPackaged: false,
    environment: { [AIDEN_DEV_GLOBAL_SHORTCUTS_ENV]: "1" },
  });
  assert.equal(profile.globalShortcutsEnabled, true);
});

test("an explicit Electron user-data root is preserved and contains all derived state", () => {
  const explicitUserDataPath = path.join(path.sep, "private", "soak", "user-data");
  const profile = resolveRuntimeProfile({
    appDataPath,
    explicitUserDataPath: `${explicitUserDataPath}${path.sep}`,
    homePath,
    isPackaged: true,
    environment: {},
  });

  assert.equal(profile.userDataPath, explicitUserDataPath);
  assert.equal(profile.sessionDataPath, explicitUserDataPath);
  assert.equal(profile.logsPath, path.join(explicitUserDataPath, "logs"));
  assert.equal(profile.crashDumpsPath, path.join(explicitUserDataPath, "Crashpad"));
});

test("a relative explicit Electron user-data root fails closed", () => {
  assert.throws(
    () =>
      resolveRuntimeProfile({
        appDataPath,
        explicitUserDataPath: "relative/user-data",
        homePath,
        isPackaged: true,
        environment: {},
      }),
    /user-data directory must be absolute/u,
  );
});

test("an empty explicit Electron user-data switch fails closed", () => {
  assert.throws(
    () =>
      resolveRuntimeProfile({
        appDataPath,
        explicitUserDataPath: "",
        homePath,
        isPackaged: true,
        environment: {},
      }),
    /user-data directory cannot be empty/u,
  );
});
