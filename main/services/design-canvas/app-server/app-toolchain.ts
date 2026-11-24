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
import type { DetectedApp, PackageManagerName } from "./app-server-core.js";

export const DESIGN_NODE_MIN_MAJOR = 22;

export type ToolchainProblem =
  | { problem: "node-missing" }
  | { problem: "manager-missing"; manager: PackageManagerName }
  | { problem: "manager-conflict"; conflict: PackageManagerName[]; field?: PackageManagerName }
  | { problem: "unsupported-manager"; manager: "deno" };

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

const designExecutableCache = createExecutableCache();

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

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One fixed sentence per problem, for 2b's tool answers and 2c's chip. */
export function toolchainProblemMessage(problem: ToolchainProblem): string {
  switch (problem.problem) {
    case "node-missing":
      return `Node.js ${DESIGN_NODE_MIN_MAJOR} or newer wasn't found. Install it from nodejs.org or Homebrew, then try again.`;
    case "manager-missing":
      return `This app uses ${problem.manager}, which wasn't found. Install ${problem.manager}, then try again.`;
    case "manager-conflict": {
      if (problem.field) {
        const locked = problem.conflict.filter((name) => name !== problem.field).map((name) => `${name}'s`);
        const noun = locked.length > 1 ? "lockfiles are" : "lockfile is";
        return `packageManager says ${problem.field}, but the ${noun} ${listNames(locked)}.`;
      }
      return `This app has lockfiles for ${listNames(problem.conflict)}. Delete the one you don't use, or set packageManager in package.json.`;
    }
    case "unsupported-manager":
      return "This app uses Deno, which design mode can't run yet.";
  }
}
