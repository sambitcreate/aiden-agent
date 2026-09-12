import { createHash } from "node:crypto";

export const DESIGN_SOURCE_MANIFEST_VERSION = 1 as const;
export const DESIGN_SOURCE_MANIFEST_MAX_BYTES = 512 * 1024;
export const DESIGN_SOURCE_MANIFEST_MAX_COMPONENTS = 1_024;
export const DESIGN_SOURCE_MANIFEST_MAX_INSTANCES = 10_000;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PATH_CHARS = 1_024;
const MAX_SELECTOR_CHARS = 512;
const MAX_SOURCE_OFFSET = 100_000_000;

const MANIFEST_KEYS = new Set([
  "version",
  "id",
  "revision",
  "workspaceId",
  "manifestHash",
  "components",
  "instances",
]);
const COMPONENT_KEYS = new Set(["id", "displayName", "kind", "definition"]);
const INSTANCE_KEYS = new Set([
  "runtimeInstanceId",
  "selector",
  "componentId",
  "source",
  "parentRuntimeInstanceId",
]);
const SOURCE_RANGE_KEYS = new Set([
  "workspaceRelativePath",
  "sourceVersion",
  "start",
  "end",
  "line",
  "column",
]);
const RESOLUTION_KEYS = new Set([
  "version",
  "manifestHash",
  "runtimeInstanceId",
  "selector",
  "componentId",
  "scope",
]);

export interface DesignSourceRangeV1 {
  workspaceRelativePath: string;
  sourceVersion: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface DesignSourceComponentV1 {
  id: string;
  displayName: string;
  kind: "intrinsic" | "custom";
  definition?: DesignSourceRangeV1;
}

export interface DesignRuntimeInstanceV1 {
  runtimeInstanceId: string;
  selector: string;
  componentId: string;
  source: DesignSourceRangeV1;
  parentRuntimeInstanceId?: string;
}

export interface DesignSourceManifestV1 {
  version: typeof DESIGN_SOURCE_MANIFEST_VERSION;
  id: string;
  revision: number;
  workspaceId: string;
  manifestHash: string;
  components: DesignSourceComponentV1[];
  instances: DesignRuntimeInstanceV1[];
}

export interface DesignSourceResolutionRequestV1 {
  version: typeof DESIGN_SOURCE_MANIFEST_VERSION;
  manifestHash: string;
  runtimeInstanceId: string;
  selector: string;
  componentId: string;
  scope: "runtime-instance" | "component-definition";
}

export type DesignSourceResolutionRejection =
  | "invalid-manifest"
  | "invalid-request"
  | "stale-manifest"
  | "stale-source"
  | "missing-source-version"
  | "unknown-runtime-instance"
  | "ambiguous-runtime-instance"
  | "component-identity-mismatch"
  | "ambiguous-repeated-instance"
  | "missing-component-definition";

export type DesignSourceResolution =
  | {
      status: "resolved";
      scope: DesignSourceResolutionRequestV1["scope"];
      runtimeInstanceId: string;
      componentId: string;
      binding: DesignSourceRangeV1;
      affectedRuntimeInstanceIds: string[];
    }
  | {
      status: "rejected";
      reason: DesignSourceResolutionRejection;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ID.test(value) ? value : undefined;
}

function safeDisplayName(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  return value.trim().length > 0 ? value : undefined;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : undefined;
}

function safeWorkspaceRelativePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_PATH_CHARS ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return undefined;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return undefined;
  }
  return value;
}

function safeSelector(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_SELECTOR_CHARS ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function parseSourceRange(value: unknown): DesignSourceRangeV1 | undefined {
  const input = record(value);
  if (!input || !exactKeys(input, SOURCE_RANGE_KEYS)) return undefined;
  const workspaceRelativePath = safeWorkspaceRelativePath(input.workspaceRelativePath);
  const sourceVersion = typeof input.sourceVersion === "string" ? input.sourceVersion : "";
  const start = safeInteger(input.start, 0, MAX_SOURCE_OFFSET);
  const end = safeInteger(input.end, 1, MAX_SOURCE_OFFSET);
  const line = safeInteger(input.line, 1, 10_000_000);
  const column = safeInteger(input.column, 1, 10_000_000);
  if (
    !workspaceRelativePath ||
    !SHA256.test(sourceVersion) ||
    start === undefined ||
    end === undefined ||
    end <= start ||
    line === undefined ||
    column === undefined
  ) {
    return undefined;
  }
  return { workspaceRelativePath, sourceVersion, start, end, line, column };
}

function parseComponent(value: unknown): DesignSourceComponentV1 | undefined {
  const input = record(value);
  if (!input || !exactKeys(input, COMPONENT_KEYS)) return undefined;
  const id = safeId(input.id);
  const displayName = safeDisplayName(input.displayName);
  if (!id || !displayName || (input.kind !== "intrinsic" && input.kind !== "custom")) {
    return undefined;
  }
  const definition =
    input.definition === undefined ? undefined : parseSourceRange(input.definition);
  if (
    (input.definition !== undefined && !definition) ||
    (input.kind === "custom" && !definition) ||
    (input.kind === "intrinsic" && input.definition !== undefined)
  ) {
    return undefined;
  }
  return { id, displayName, kind: input.kind, ...(definition ? { definition } : {}) };
}

function parseInstance(value: unknown): DesignRuntimeInstanceV1 | undefined {
  const input = record(value);
  if (!input || !exactKeys(input, INSTANCE_KEYS)) return undefined;
  const runtimeInstanceId = safeId(input.runtimeInstanceId);
  const selector = safeSelector(input.selector);
  const componentId = safeId(input.componentId);
  const source = parseSourceRange(input.source);
  const parentRuntimeInstanceId =
    input.parentRuntimeInstanceId === undefined ? undefined : safeId(input.parentRuntimeInstanceId);
  if (
    !runtimeInstanceId ||
    !selector ||
    !componentId ||
    !source ||
    (input.parentRuntimeInstanceId !== undefined && !parentRuntimeInstanceId) ||
    parentRuntimeInstanceId === runtimeInstanceId
  ) {
    return undefined;
  }
  return {
    runtimeInstanceId,
    selector,
    componentId,
    source,
    ...(parentRuntimeInstanceId ? { parentRuntimeInstanceId } : {}),
  };
}

function canonicalManifestBody(manifest: Omit<DesignSourceManifestV1, "manifestHash">): string {
  const canonicalSource = (source: DesignSourceRangeV1) => ({
    workspaceRelativePath: source.workspaceRelativePath,
    sourceVersion: source.sourceVersion,
    start: source.start,
    end: source.end,
    line: source.line,
    column: source.column,
  });
  return JSON.stringify({
    version: manifest.version,
    id: manifest.id,
    revision: manifest.revision,
    workspaceId: manifest.workspaceId,
    components: manifest.components.map((component) => ({
      id: component.id,
      displayName: component.displayName,
      kind: component.kind,
      ...(component.definition ? { definition: canonicalSource(component.definition) } : {}),
    })),
    instances: manifest.instances.map((instance) => ({
      runtimeInstanceId: instance.runtimeInstanceId,
      selector: instance.selector,
      componentId: instance.componentId,
      source: canonicalSource(instance.source),
      ...(instance.parentRuntimeInstanceId
        ? { parentRuntimeInstanceId: instance.parentRuntimeInstanceId }
        : {}),
    })),
  });
}

export function computeDesignSourceManifestHash(
  manifest: Omit<DesignSourceManifestV1, "manifestHash">,
): string {
  return createHash("sha256").update(canonicalManifestBody(manifest), "utf8").digest("hex");
}

export function parseDesignSourceManifest(value: unknown): DesignSourceManifestV1 | undefined {
  let encodedBytes: number;
  try {
    encodedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
  if (encodedBytes > DESIGN_SOURCE_MANIFEST_MAX_BYTES) return undefined;
  const input = record(value);
  if (!input || !exactKeys(input, MANIFEST_KEYS)) return undefined;
  const id = safeId(input.id);
  const revision = safeInteger(input.revision, 1, Number.MAX_SAFE_INTEGER);
  const workspaceId = safeId(input.workspaceId);
  const manifestHash = typeof input.manifestHash === "string" ? input.manifestHash : "";
  if (
    input.version !== DESIGN_SOURCE_MANIFEST_VERSION ||
    !id ||
    revision === undefined ||
    !workspaceId ||
    !SHA256.test(manifestHash) ||
    !Array.isArray(input.components) ||
    input.components.length < 1 ||
    input.components.length > DESIGN_SOURCE_MANIFEST_MAX_COMPONENTS ||
    !Array.isArray(input.instances) ||
    input.instances.length < 1 ||
    input.instances.length > DESIGN_SOURCE_MANIFEST_MAX_INSTANCES
  ) {
    return undefined;
  }
  const components = input.components.map(parseComponent);
  const instances = input.instances.map(parseInstance);
  if (components.some((entry) => !entry) || instances.some((entry) => !entry)) return undefined;
  const typedComponents = components as DesignSourceComponentV1[];
  const typedInstances = instances as DesignRuntimeInstanceV1[];
  const componentIds = new Set(typedComponents.map((component) => component.id));
  const runtimeIds = new Set(typedInstances.map((instance) => instance.runtimeInstanceId));
  if (
    componentIds.size !== typedComponents.length ||
    runtimeIds.size !== typedInstances.length ||
    typedInstances.some(
      (instance) =>
        !componentIds.has(instance.componentId) ||
        (instance.parentRuntimeInstanceId !== undefined &&
          !runtimeIds.has(instance.parentRuntimeInstanceId)),
    )
  ) {
    return undefined;
  }
  const parentByRuntimeId = new Map(
    typedInstances.map((instance) => [
      instance.runtimeInstanceId,
      instance.parentRuntimeInstanceId,
    ]),
  );
  const completedParentChains = new Set<string>();
  for (const instance of typedInstances) {
    const visited = new Set<string>();
    let current: string | undefined = instance.runtimeInstanceId;
    while (current && !completedParentChains.has(current)) {
      if (visited.has(current)) return undefined;
      visited.add(current);
      current = parentByRuntimeId.get(current);
    }
    for (const runtimeInstanceId of visited) completedParentChains.add(runtimeInstanceId);
  }
  const manifestWithoutHash = {
    version: DESIGN_SOURCE_MANIFEST_VERSION,
    id,
    revision,
    workspaceId,
    components: typedComponents,
    instances: typedInstances,
  } satisfies Omit<DesignSourceManifestV1, "manifestHash">;
  if (computeDesignSourceManifestHash(manifestWithoutHash) !== manifestHash) return undefined;
  return { ...manifestWithoutHash, manifestHash };
}

export function parseDesignSourceResolutionRequest(
  value: unknown,
): DesignSourceResolutionRequestV1 | undefined {
  const input = record(value);
  if (!input || !exactKeys(input, RESOLUTION_KEYS)) return undefined;
  const runtimeInstanceId = safeId(input.runtimeInstanceId);
  const selector = safeSelector(input.selector);
  const componentId = safeId(input.componentId);
  if (
    input.version !== DESIGN_SOURCE_MANIFEST_VERSION ||
    typeof input.manifestHash !== "string" ||
    !SHA256.test(input.manifestHash) ||
    !runtimeInstanceId ||
    !selector ||
    !componentId ||
    (input.scope !== "runtime-instance" && input.scope !== "component-definition")
  ) {
    return undefined;
  }
  return {
    version: DESIGN_SOURCE_MANIFEST_VERSION,
    manifestHash: input.manifestHash,
    runtimeInstanceId,
    selector,
    componentId,
    scope: input.scope,
  };
}

function sourceRangeKey(range: DesignSourceRangeV1): string {
  return `${range.workspaceRelativePath}\0${range.sourceVersion}\0${range.start}\0${range.end}`;
}

function currentSourceVersion(
  versions: Readonly<Record<string, string>>,
  range: DesignSourceRangeV1,
): "current" | "missing" | "stale" {
  const current = Object.prototype.hasOwnProperty.call(versions, range.workspaceRelativePath)
    ? versions[range.workspaceRelativePath]
    : undefined;
  if (current === undefined) return "missing";
  return current === range.sourceVersion ? "current" : "stale";
}

/**
 * Resolves one untrusted runtime selection without guessing. Callers must supply hashes read from
 * the currently authorized workspace; hashes emitted by the preview are not freshness evidence.
 */
export function resolveDesignSourceSelection(input: {
  manifest: unknown;
  request: unknown;
  currentSourceVersions: Readonly<Record<string, string>>;
}): DesignSourceResolution {
  const manifest = parseDesignSourceManifest(input.manifest);
  if (!manifest) return { status: "rejected", reason: "invalid-manifest" };
  const request = parseDesignSourceResolutionRequest(input.request);
  if (!request) return { status: "rejected", reason: "invalid-request" };
  if (request.manifestHash !== manifest.manifestHash) {
    return { status: "rejected", reason: "stale-manifest" };
  }
  const byRuntimeId = manifest.instances.filter(
    (instance) => instance.runtimeInstanceId === request.runtimeInstanceId,
  );
  if (byRuntimeId.length === 0) {
    return { status: "rejected", reason: "unknown-runtime-instance" };
  }
  const bySelector = manifest.instances.filter(
    (instance) => instance.selector === request.selector,
  );
  if (byRuntimeId.length !== 1 || bySelector.length !== 1 || byRuntimeId[0] !== bySelector[0]) {
    return { status: "rejected", reason: "ambiguous-runtime-instance" };
  }
  const instance = byRuntimeId[0]!;
  if (instance.componentId !== request.componentId) {
    return { status: "rejected", reason: "component-identity-mismatch" };
  }
  const component = manifest.components.find((candidate) => candidate.id === instance.componentId);
  if (!component) return { status: "rejected", reason: "invalid-manifest" };
  const instanceFreshness = currentSourceVersion(input.currentSourceVersions, instance.source);
  if (instanceFreshness === "missing") {
    return { status: "rejected", reason: "missing-source-version" };
  }
  if (instanceFreshness === "stale") return { status: "rejected", reason: "stale-source" };
  const componentInstances = manifest.instances.filter(
    (candidate) => candidate.componentId === component.id,
  );
  const sameSourceInstances = manifest.instances.filter(
    (candidate) => sourceRangeKey(candidate.source) === sourceRangeKey(instance.source),
  );
  let binding: DesignSourceRangeV1;
  let affectedRuntimeInstanceIds: string[];
  if (request.scope === "component-definition") {
    if (component.kind !== "custom" || !component.definition) {
      return { status: "rejected", reason: "missing-component-definition" };
    }
    if (componentInstances.length !== 1) {
      return { status: "rejected", reason: "ambiguous-repeated-instance" };
    }
    binding = component.definition;
    affectedRuntimeInstanceIds = [instance.runtimeInstanceId];
  } else {
    if (sameSourceInstances.length !== 1) {
      return { status: "rejected", reason: "ambiguous-repeated-instance" };
    }
    binding = instance.source;
    affectedRuntimeInstanceIds = [instance.runtimeInstanceId];
  }
  const freshness = currentSourceVersion(input.currentSourceVersions, binding);
  if (freshness === "missing") {
    return { status: "rejected", reason: "missing-source-version" };
  }
  if (freshness === "stale") return { status: "rejected", reason: "stale-source" };
  return {
    status: "resolved",
    scope: request.scope,
    runtimeInstanceId: instance.runtimeInstanceId,
    componentId: component.id,
    binding,
    affectedRuntimeInstanceIds,
  };
}
