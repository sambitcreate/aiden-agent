/**
 * Node.js and the package manager for a detected app (plan R9, spec §6.8).
 *
 * Node 22 or newer comes first, because every framework's CLI runs on it,
 * even under pnpm's standalone build or bun. The manager is the one the app
 * declares: there is no fallback to npm for a pnpm, yarn or bun project (it
 * would write a second lockfile) and no corepack fallback. Misses are never
 * cached, so installing Node and pressing Retry works without a restart.
 */
import path from "node:path";
import {
  createExecutableCache,
  isExecutableFile,
  isStandaloneNodeExecutable,
  loginShellCommandLookup,
  resolveExecutable,
  type ExecutableResolutionDeps,
} from "../../node-toolchain.js";
import {
  DESIGN_NODE_MIN_MAJOR,
  toolchainProblemMessage,
  type ToolchainProblem,
} from "../../../../renderer/shared/design-app.js";
import type { DetectedApp, PackageManagerName } from "./app-server-core.js";

export { DESIGN_NODE_MIN_MAJOR, toolchainProblemMessage, type ToolchainProblem };

export type AppToolchain =
  | { ok: true; node: string; manager: { name: PackageManagerName; path: string } }
  | ({ ok: false } & ToolchainProblem);

export interface AppToolchainDeps {
  node: ExecutableResolutionDeps;
  manager: ExecutableResolutionDeps;
}

export async function resolveAppToolchain(app: Pick<DetectedApp, "packageManager">, deps: AppToolchainDeps): Promise<AppToolchain> {
  const node = await resolveExecutable("node", deps.node);
  if (!node) return { ok: false, problem: "node-missing" };

  const info = app.packageManager;
  if (info.name === null) {
    if (info.unsupported) return { ok: false, problem: "unsupported-manager", manager: info.unsupported };
    return { ok: false, problem: "manager-conflict", conflict: info.conflict ?? [], ...(info.field ? { field: info.field } : {}) };
  }

  const name = info.name;
  const besideNode = path.join(path.dirname(node), "npm");
  const managerPath =
    name === "npm" && (await deps.manager.isExecutable(besideNode)) ? besideNode : await resolveExecutable(name, deps.manager);
  if (!managerPath) return { ok: false, problem: "manager-missing", manager: name };
  return { ok: true, node, manager: { name, path: managerPath } };
}

/**
 * Design mode's toolchain. E2E only: `AIDEN_E2E_DESIGN_NODE_MISSING=1` in an
 * unpackaged build answers node-missing, because a test can't hide Node from
 * the resolver's fallback folders. A packaged build ignores it.
 */
export async function resolveDesignToolchain(
  app: Pick<DetectedApp, "packageManager">,
  runtime: { isPackaged: boolean; env: NodeJS.ProcessEnv },
  deps: AppToolchainDeps = defaultAppToolchainDeps(),
): Promise<AppToolchain> {
  if (!runtime.isPackaged && runtime.env.AIDEN_E2E_DESIGN_NODE_MISSING === "1") return { ok: false, problem: "node-missing" };
  return resolveAppToolchain(app, deps);
}

const designExecutableCache = createExecutableCache();

/** Forgets every remembered login-shell answer, for 2c's Retry after the person installs or moves a tool. */
export function clearAppToolchainCache(): void {
  designExecutableCache.clear();
}

/** The design resolvers: one shared cache of validated login-shell answers, Node 22+, a 16 KiB lookup buffer. */
export function defaultAppToolchainDeps(env: NodeJS.ProcessEnv = process.env): AppToolchainDeps {
  const loginShellLookup = loginShellCommandLookup({ env, maxBuffer: 16_384 });
  return {
    node: {
      env,
      isExecutable: (candidate) => isStandaloneNodeExecutable(candidate, env, { minMajor: DESIGN_NODE_MIN_MAJOR }),
      loginShellLookup,
      cache: designExecutableCache,
    },
    manager: { env, isExecutable: isExecutableFile, loginShellLookup, cache: designExecutableCache },
  };
}
