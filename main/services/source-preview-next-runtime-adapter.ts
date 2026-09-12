import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import {
  classifyNextSourceAdapter,
  type NextBoundaryFixtureKind,
  type NextBundlerFixtureKind,
  type NextSourceAdapterClassification,
  type NextSourceAdapterFixtureV1,
  type NextSourceGraphFixtureState,
} from "./source-preview-transport-next-adapter.js";

const MAX_PACKAGE_BYTES = 512 * 1024;
const MAX_ROUTE_BYTES = 256 * 1024;
const MAX_ROUTES = 128;
const MAX_DEPTH = 12;
const NEXT_ROUTE_FILE = /\.(?:[cm]?js|jsx|tsx?)$/u;
const APP_ENTRY_FILE = /^page\.(?:[cm]?js|jsx|tsx?)$/u;
const NEXT_CONFIG_FILE = /^next\.config\.(?:[cm]?js|ts)$/u;
const CLIENT_DIRECTIVE = /^\s*["']use client["']\s*;?/u;

export type NextPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface NextPreviewRouteAdapter {
  routePath: string;
  entryPath: string;
  boundary: NextBoundaryFixtureKind;
  classification: NextSourceAdapterClassification;
}

export interface NextPreviewRuntimeAdapter {
  framework: "next";
  scriptId: string;
  label: string;
  command: string;
  packageManager: NextPackageManager;
  nextVersion: string;
  router: "app" | "pages" | "hybrid" | "none";
  bundler: NextBundlerFixtureKind;
  configPath?: string;
  routes: NextPreviewRouteAdapter[];
}

interface DetectionOptions {
  sourceGraphState?: NextSourceGraphFixtureState;
  manifestFormatVersion?: number;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function realDirectory(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function packageManager(root: string): Promise<NextPackageManager> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(root, "yarn.lock"))) return "yarn";
  if ((await exists(path.join(root, "bun.lock"))) || (await exists(path.join(root, "bun.lockb")))) {
    return "bun";
  }
  return "npm";
}

async function readPackage(root: string): Promise<Record<string, unknown> | undefined> {
  const packagePath = path.join(root, "package.json");
  try {
    const stat = await fs.lstat(packagePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PACKAGE_BYTES) return undefined;
    const value: unknown = JSON.parse(await fs.readFile(packagePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function nextVersion(manifest: Record<string, unknown>): string | undefined {
  for (const key of ["dependencies", "devDependencies"]) {
    const dependencies = manifest[key];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    const value = (dependencies as Record<string, unknown>).next;
    if (typeof value !== "string") continue;
    const match = value.match(/(?:^|[^0-9])(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
    if (match) return `${match[1]}.${match[2] ?? "0"}.${match[3] ?? "0"}`;
  }
  return undefined;
}

function bundlerFor(command: string, version: string): NextBundlerFixtureKind {
  const turbo = /(?:^|\s)--turbo(?:pack)?(?:\s|$)/u.test(command);
  const webpack = /(?:^|\s)--webpack(?:\s|$)/u.test(command);
  if (turbo && webpack) return "ambiguous";
  if (turbo) return "turbopack";
  if (webpack) return "webpack";
  const major = Number(version.split(".", 1)[0]);
  return major >= 16 ? "turbopack" : "webpack";
}

async function configPath(root: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile() && NEXT_CONFIG_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

function routeSegment(segment: string): string | undefined {
  if (segment.startsWith("(") && segment.endsWith(")")) return undefined;
  if (segment.startsWith("@")) return undefined;
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/u);
  if (catchAll) return `*${catchAll[1]}`;
  const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/u);
  if (optionalCatchAll) return `*${optionalCatchAll[1]}`;
  const dynamic = segment.match(/^\[(.+)\]$/u);
  if (dynamic) return `:${dynamic[1]}`;
  return segment;
}

function routeFromEntry(router: "app" | "pages", relativePath: string): string | undefined {
  const parts = relativePath.split("/");
  const file = parts.pop();
  if (!file) return undefined;
  if (router === "pages") {
    if (/^_(?:app|document|error)\./u.test(file) || parts[0] === "api") return undefined;
    const stem = file.replace(NEXT_ROUTE_FILE, "");
    if (stem !== "index") parts.push(stem);
  }
  const routeParts = parts.map(routeSegment).filter((part): part is string => Boolean(part));
  return `/${routeParts.join("/")}`;
}

async function boundaryFor(
  router: "app" | "pages",
  absolutePath: string,
): Promise<NextBoundaryFixtureKind> {
  if (router === "pages") return "client";
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > MAX_ROUTE_BYTES) return "unknown";
    const source = await fs.readFile(absolutePath, "utf8");
    return CLIENT_DIRECTIVE.test(source) ? "client" : "server";
  } catch {
    return "unknown";
  }
}

async function collectRoutes(
  root: string,
  routeRoot: string,
  router: "app" | "pages",
): Promise<Array<{ routePath: string; entryPath: string; boundary: NextBoundaryFixtureKind }>> {
  const absoluteRoot = path.join(root, routeRoot);
  const routes: Array<{ routePath: string; entryPath: string; boundary: NextBoundaryFixtureKind }> =
    [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || routes.length >= MAX_ROUTES) return;
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (routes.length >= MAX_ROUTES || entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !NEXT_ROUTE_FILE.test(entry.name)) continue;
      if (router === "app" && !APP_ENTRY_FILE.test(entry.name)) continue;
      const relativeWithinRouter = path
        .relative(absoluteRoot, absolutePath)
        .split(path.sep)
        .join("/");
      const routePath = routeFromEntry(router, relativeWithinRouter);
      if (!routePath) continue;
      routes.push({
        routePath,
        entryPath: path.posix.join(routeRoot, relativeWithinRouter),
        boundary: await boundaryFor(router, absolutePath),
      });
    }
  };
  await visit(absoluteRoot, 0);
  return routes;
}

async function routerRoots(root: string): Promise<{
  kind: "app" | "pages" | "hybrid" | "none";
  appRoot?: string;
  pagesRoot?: string;
}> {
  const appRoot = (await realDirectory(path.join(root, "app")))
    ? "app"
    : (await realDirectory(path.join(root, "src", "app")))
      ? "src/app"
      : undefined;
  const pagesRoot = (await realDirectory(path.join(root, "pages")))
    ? "pages"
    : (await realDirectory(path.join(root, "src", "pages")))
      ? "src/pages"
      : undefined;
  return {
    kind: appRoot && pagesRoot ? "hybrid" : appRoot ? "app" : pagesRoot ? "pages" : "none",
    ...(appRoot ? { appRoot } : {}),
    ...(pagesRoot ? { pagesRoot } : {}),
  };
}

export function nextPreviewLaunchArguments(
  manager: NextPackageManager,
  scriptId: string,
  port: number,
): { command: string; args: string[] } {
  return {
    command: manager,
    args: ["run", scriptId, "--", "--hostname", "127.0.0.1", "--port", String(port)],
  };
}

export async function detectNextPreviewRuntimeAdapters(
  root: string,
  options: DetectionOptions = {},
): Promise<NextPreviewRuntimeAdapter[]> {
  const manifest = await readPackage(root);
  const version = manifest ? nextVersion(manifest) : undefined;
  const scripts = manifest?.scripts;
  if (!manifest || !version || !scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return [];
  }
  const manager = await packageManager(root);
  const roots = await routerRoots(root);
  const detectedConfigPath = await configPath(root);
  const graphState = options.sourceGraphState ?? "missing";
  const routeEntries = [
    ...(roots.appRoot ? await collectRoutes(root, roots.appRoot, "app") : []),
    ...(roots.pagesRoot ? await collectRoutes(root, roots.pagesRoot, "pages") : []),
  ];
  return Object.entries(scripts as Record<string, unknown>)
    .filter(
      ([scriptId, command]) =>
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(scriptId) &&
        typeof command === "string" &&
        command.length <= 4_096 &&
        /(?:^|\s)next\s+dev(?:\s|$)/u.test(command),
    )
    .sort(([left], [right]) =>
      left === "dev" ? -1 : right === "dev" ? 1 : left.localeCompare(right),
    )
    .slice(0, 4)
    .map(([scriptId, rawCommand]) => {
      const command = rawCommand as string;
      const bundler = bundlerFor(command, version);
      const routes = routeEntries.map((route): NextPreviewRouteAdapter => {
        const router = route.entryPath.startsWith(roots.appRoot ?? "\0") ? "app" : "pages";
        const fixture: NextSourceAdapterFixtureV1 = {
          version: 1,
          framework: "next",
          nextVersion: version,
          devCommand: {
            kind: "next-dev",
            scriptId,
            controlledLoopbackHost: true,
            controlledPort: true,
          },
          routerFixture: {
            kind: router,
            routePath: route.routePath,
            entryPath: route.entryPath,
          },
          bundlerFixture: {
            kind: bundler,
            ...(detectedConfigPath ? { configPath: detectedConfigPath } : {}),
          },
          boundaryFixture: { kind: route.boundary, evidencePath: route.entryPath },
          sourceGraphFixture: {
            state: graphState,
            ...(options.manifestFormatVersion === undefined
              ? {}
              : { manifestFormatVersion: options.manifestFormatVersion }),
          },
        };
        return { ...route, classification: classifyNextSourceAdapter(fixture) };
      });
      return {
        framework: "next" as const,
        scriptId,
        label: scriptId === "dev" ? "Next.js development app" : scriptId,
        command: `${manager} run ${scriptId} -- --hostname 127.0.0.1 --port <port>`,
        packageManager: manager,
        nextVersion: version,
        router: roots.kind,
        bundler,
        ...(detectedConfigPath ? { configPath: detectedConfigPath } : {}),
        routes,
      };
    });
}
