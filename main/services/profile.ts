import { execFile } from "node:child_process";
import * as os from "node:os";
import { promisify } from "node:util";
import { configStore } from "./config-store.js";
import {
  MAX_PROFILE_NAME_LENGTH,
  normalizeProfileName,
  validateProfileName,
} from "./profile-core.js";
import type { Profile } from "./types.js";

const execFileAsync = promisify(execFile);

function titleCaseUsername(username: string): string {
  const words = username
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .split(/[._\-\s]+/gu)
    .filter(Boolean);
  return (
    words.map((word) => `${word.slice(0, 1).toLocaleUpperCase()}${word.slice(1)}`).join(" ") ||
    "Aiden User"
  );
}

async function systemDisplayName(): Promise<string> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/usr/bin/id", ["-F"], {
        encoding: "utf8",
        timeout: 1_000,
      });
      const fullName = normalizeProfileName(stdout);
      if (fullName) return [...fullName].slice(0, MAX_PROFILE_NAME_LENGTH).join("");
    } catch {
      // Fall back to the local account name below.
    }
  }
  return titleCaseUsername(os.userInfo().username);
}

export const profileService = {
  async get(): Promise<Profile> {
    const settings = await configStore.getSettings();
    const existing = normalizeProfileName(settings.profileName ?? "");
    if (existing) return { name: existing };

    const name = validateProfileName(await systemDisplayName());
    await configStore.setSettings({ profileName: name });
    return { name };
  },

  async setName(value: string): Promise<Profile> {
    const name = validateProfileName(value);
    await configStore.setSettings({ profileName: name });
    return { name };
  },
};
