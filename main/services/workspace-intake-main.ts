import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { logger } from "../platform.js";
import { configStore } from "./config-store.js";
import { createGitCloneRunner } from "./git-clone-runner.js";
import { workspaceApplicationService } from "./workspace-application-service-main.js";
import { createWorkspaceIntakeService } from "./workspace-intake.js";

export const workspaceIntakeService = createWorkspaceIntakeService({
  home: os.homedir(),
  stat: (target) => fs.stat(target, { bigint: true }),
  lstat: (target) => fs.lstat(target),
  rename: (from, to) => fs.rename(from, to),
  mkdtemp: (prefix) => fs.mkdtemp(prefix),
  writeNewFile: (target, content) => fs.writeFile(target, content, { flag: "wx", mode: 0o600 }),
  readFile: (target) => fs.readFile(target, "utf8"),
  randomId: () => randomUUID(),
  logError: (area, message, error) => logger.error(area, message, error),
  realpath: (target) => fs.realpath(target),
  readdir: (target) => fs.readdir(target),
  mkdir: async (target) => {
    await fs.mkdir(target);
  },
  rmdir: (target) => fs.rmdir(target),
  removeTree: (target) => fs.rm(target, { recursive: true, force: true }),
  listWorkspaces: () => configStore.listWorkspaces(),
  getWorkspace: async (id) => (await configStore.getWorkspace(id)) ?? null,
  createFromFolder: (folderPath, options) => workspaceApplicationService.createFromFolder(folderPath, undefined, options),
  runClone: createGitCloneRunner(),
});
