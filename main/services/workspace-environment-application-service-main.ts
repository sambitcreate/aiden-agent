import * as fs from "node:fs/promises";
import { configStore } from "./config-store.js";
import { assertManagedWorktreeAdmission } from "./managed-worktree-admission.js";
import { createWorkspaceEnvironmentApplicationService } from "./workspace-environment-application-service.js";
import { workspaceMutationGate } from "./workspace-mutation-gate.js";
import { workspaceOperationRegistry } from "./workspace-operation-registry.js";

export const workspaceEnvironmentApplicationService =
  createWorkspaceEnvironmentApplicationService({
    configStore,
    workspaceMutationGate,
    workspaceOperationRegistry,
    assertManagedWorktreeAdmission,
    realpath: fs.realpath,
    stat: fs.stat,
  });
