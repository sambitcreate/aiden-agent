export const NEXT_SOURCE_ADAPTER_FIXTURE_VERSION = 1 as const;
export const NEXT_SOURCE_ADAPTER_MAX_FIXTURE_BYTES = 8 * 1024;

const ROOT_KEYS = new Set([
  "version",
  "framework",
  "nextVersion",
  "devCommand",
  "routerFixture",
  "bundlerFixture",
  "boundaryFixture",
  "sourceGraphFixture",
]);
const DEV_COMMAND_KEYS = new Set(["kind", "scriptId", "controlledLoopbackHost", "controlledPort"]);
const ROUTER_KEYS = new Set(["kind", "routePath", "entryPath"]);
const BUNDLER_KEYS = new Set(["kind", "configPath"]);
const BOUNDARY_KEYS = new Set(["kind", "evidencePath"]);
const SOURCE_GRAPH_KEYS = new Set(["state", "manifestFormatVersion"]);
const SAFE_SCRIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;

export type NextRouterFixtureKind = "app" | "pages" | "hybrid" | "none";
export type NextBundlerFixtureKind = "webpack" | "turbopack" | "ambiguous" | "unknown";
export type NextBoundaryFixtureKind = "client" | "server" | "mixed" | "unknown";
export type NextSourceGraphFixtureState = "current" | "missing" | "stale" | "ambiguous";

export interface NextSourceAdapterFixtureV1 {
  version: typeof NEXT_SOURCE_ADAPTER_FIXTURE_VERSION;
  framework: "next";
  nextVersion: string;
  devCommand: {
    kind: "next-dev" | "other";
    scriptId: string;
    controlledLoopbackHost: boolean;
    controlledPort: boolean;
  };
  routerFixture: {
    kind: NextRouterFixtureKind;
    routePath: string;
    entryPath: string;
  };
  bundlerFixture: {
    kind: NextBundlerFixtureKind;
    configPath?: string;
  };
  boundaryFixture: {
    kind: NextBoundaryFixtureKind;
    evidencePath: string;
  };
  sourceGraphFixture: {
    state: NextSourceGraphFixtureState;
    manifestFormatVersion?: number;
  };
}

export type NextSourceAdapterReason =
  | "invalid-fixture"
  | "unsupported-dev-command"
  | "uncontrolled-preview-target"
  | "missing-router"
  | "hybrid-router-ambiguous"
  | "bundler-ambiguous"
  | "bundler-unknown"
  | "server-boundary"
  | "mixed-boundary"
  | "unknown-boundary"
  | "source-graph-missing"
  | "source-graph-stale"
  | "source-graph-ambiguous"
  | "source-graph-version-unsupported";

export type NextSourceAdapterClassification =
  | { status: "unsupported"; reason: NextSourceAdapterReason }
  | {
      status: "preview-only";
      adapter:
        | "next-app-webpack"
        | "next-app-turbopack"
        | "next-pages-webpack"
        | "next-pages-turbopack";
      reason: NextSourceAdapterReason;
      hmr: "requires-loopback-proof";
      sourceSelection: "disabled";
    }
  | {
      status: "supported";
      adapter:
        | "next-app-webpack"
        | "next-app-turbopack"
        | "next-pages-webpack"
        | "next-pages-turbopack";
      hmr: "requires-loopback-proof";
      sourceSelection: "manifest-required";
      directEdit: "review-required";
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function workspaceRelativePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return undefined;
  }
  const segments = value.split("/");
  return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ? undefined
    : value;
}

function routePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    !value.startsWith("/") ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    /[\r\n]/u.test(value)
  ) {
    return undefined;
  }
  const segments = value.split("/");
  return segments.some((segment) => segment === "." || segment === "..") ? undefined : value;
}

export function parseNextSourceAdapterFixture(
  value: unknown,
): NextSourceAdapterFixtureV1 | undefined {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
  if (bytes > NEXT_SOURCE_ADAPTER_MAX_FIXTURE_BYTES) return undefined;
  const input = record(value);
  const devCommand = input ? record(input.devCommand) : undefined;
  const routerFixture = input ? record(input.routerFixture) : undefined;
  const bundlerFixture = input ? record(input.bundlerFixture) : undefined;
  const boundaryFixture = input ? record(input.boundaryFixture) : undefined;
  const sourceGraphFixture = input ? record(input.sourceGraphFixture) : undefined;
  if (
    !input ||
    !exactKeys(input, ROOT_KEYS) ||
    !devCommand ||
    !exactKeys(devCommand, DEV_COMMAND_KEYS) ||
    !routerFixture ||
    !exactKeys(routerFixture, ROUTER_KEYS) ||
    !bundlerFixture ||
    !exactKeys(bundlerFixture, BUNDLER_KEYS) ||
    !boundaryFixture ||
    !exactKeys(boundaryFixture, BOUNDARY_KEYS) ||
    !sourceGraphFixture ||
    !exactKeys(sourceGraphFixture, SOURCE_GRAPH_KEYS)
  ) {
    return undefined;
  }
  const routerKind = routerFixture.kind;
  const bundlerKind = bundlerFixture.kind;
  const boundaryKind = boundaryFixture.kind;
  const graphState = sourceGraphFixture.state;
  const parsedRoutePath = routePath(routerFixture.routePath);
  const entryPath = workspaceRelativePath(routerFixture.entryPath);
  const configPath =
    bundlerFixture.configPath === undefined
      ? undefined
      : workspaceRelativePath(bundlerFixture.configPath);
  const evidencePath = workspaceRelativePath(boundaryFixture.evidencePath);
  const manifestFormatVersion = sourceGraphFixture.manifestFormatVersion;
  if (
    input.version !== NEXT_SOURCE_ADAPTER_FIXTURE_VERSION ||
    input.framework !== "next" ||
    typeof input.nextVersion !== "string" ||
    input.nextVersion.length < 1 ||
    input.nextVersion.length > 80 ||
    !/^[0-9A-Za-z.+-]+$/u.test(input.nextVersion) ||
    (devCommand.kind !== "next-dev" && devCommand.kind !== "other") ||
    typeof devCommand.scriptId !== "string" ||
    !SAFE_SCRIPT_ID.test(devCommand.scriptId) ||
    typeof devCommand.controlledLoopbackHost !== "boolean" ||
    typeof devCommand.controlledPort !== "boolean" ||
    !new Set<unknown>(["app", "pages", "hybrid", "none"]).has(routerKind) ||
    !parsedRoutePath ||
    !entryPath ||
    !new Set<unknown>(["webpack", "turbopack", "ambiguous", "unknown"]).has(bundlerKind) ||
    (bundlerFixture.configPath !== undefined && !configPath) ||
    !new Set<unknown>(["client", "server", "mixed", "unknown"]).has(boundaryKind) ||
    !evidencePath ||
    !new Set<unknown>(["current", "missing", "stale", "ambiguous"]).has(graphState) ||
    (manifestFormatVersion !== undefined &&
      (!Number.isSafeInteger(manifestFormatVersion) || (manifestFormatVersion as number) < 1))
  ) {
    return undefined;
  }
  return {
    version: NEXT_SOURCE_ADAPTER_FIXTURE_VERSION,
    framework: "next",
    nextVersion: input.nextVersion,
    devCommand: {
      kind: devCommand.kind,
      scriptId: devCommand.scriptId,
      controlledLoopbackHost: devCommand.controlledLoopbackHost,
      controlledPort: devCommand.controlledPort,
    },
    routerFixture: {
      kind: routerKind as NextRouterFixtureKind,
      routePath: parsedRoutePath,
      entryPath,
    },
    bundlerFixture: {
      kind: bundlerKind as NextBundlerFixtureKind,
      ...(configPath ? { configPath } : {}),
    },
    boundaryFixture: {
      kind: boundaryKind as NextBoundaryFixtureKind,
      evidencePath,
    },
    sourceGraphFixture: {
      state: graphState as NextSourceGraphFixtureState,
      ...(manifestFormatVersion === undefined
        ? {}
        : { manifestFormatVersion: manifestFormatVersion as number }),
    },
  };
}

function adapterFor(
  fixture: NextSourceAdapterFixtureV1,
): Exclude<NextSourceAdapterClassification, { status: "unsupported" }>["adapter"] {
  return `next-${fixture.routerFixture.kind}-${fixture.bundlerFixture.kind}` as Exclude<
    NextSourceAdapterClassification,
    { status: "unsupported" }
  >["adapter"];
}

export function classifyNextSourceAdapter(value: unknown): NextSourceAdapterClassification {
  const fixture = parseNextSourceAdapterFixture(value);
  if (!fixture) return { status: "unsupported", reason: "invalid-fixture" };
  if (fixture.devCommand.kind !== "next-dev") {
    return { status: "unsupported", reason: "unsupported-dev-command" };
  }
  if (!fixture.devCommand.controlledLoopbackHost || !fixture.devCommand.controlledPort) {
    return { status: "unsupported", reason: "uncontrolled-preview-target" };
  }
  if (fixture.routerFixture.kind === "none") {
    return { status: "unsupported", reason: "missing-router" };
  }
  if (fixture.routerFixture.kind === "hybrid") {
    return { status: "unsupported", reason: "hybrid-router-ambiguous" };
  }
  if (fixture.bundlerFixture.kind === "ambiguous") {
    return { status: "unsupported", reason: "bundler-ambiguous" };
  }
  if (fixture.bundlerFixture.kind === "unknown") {
    return { status: "unsupported", reason: "bundler-unknown" };
  }
  const adapter = adapterFor(fixture);
  const previewOnly = (reason: NextSourceAdapterReason): NextSourceAdapterClassification => ({
    status: "preview-only",
    adapter,
    reason,
    hmr: "requires-loopback-proof",
    sourceSelection: "disabled",
  });
  if (fixture.boundaryFixture.kind === "server") return previewOnly("server-boundary");
  if (fixture.boundaryFixture.kind === "mixed") return previewOnly("mixed-boundary");
  if (fixture.boundaryFixture.kind === "unknown") return previewOnly("unknown-boundary");
  if (fixture.sourceGraphFixture.state === "missing") return previewOnly("source-graph-missing");
  if (fixture.sourceGraphFixture.state === "stale") return previewOnly("source-graph-stale");
  if (fixture.sourceGraphFixture.state === "ambiguous") {
    return previewOnly("source-graph-ambiguous");
  }
  if (fixture.sourceGraphFixture.manifestFormatVersion !== 1) {
    return previewOnly("source-graph-version-unsupported");
  }
  return {
    status: "supported",
    adapter,
    hmr: "requires-loopback-proof",
    sourceSelection: "manifest-required",
    directEdit: "review-required",
  };
}
