import assert from "node:assert/strict";
import test from "node:test";
import {
  DESIGN_SOURCE_MANIFEST_MAX_BYTES,
  computeDesignSourceManifestHash,
  parseDesignSourceManifest,
  parseDesignSourceResolutionRequest,
  resolveDesignSourceSelection,
  type DesignRuntimeInstanceV1,
  type DesignSourceComponentV1,
  type DesignSourceManifestV1,
} from "./design-source-graph-core.js";

const APP_HASH = "a".repeat(64);
const BUTTON_HASH = "b".repeat(64);

function source(workspaceRelativePath: string, sourceVersion: string, start: number, end: number) {
  return { workspaceRelativePath, sourceVersion, start, end, line: 1, column: start + 1 };
}

function manifest(input?: {
  components?: DesignSourceComponentV1[];
  instances?: DesignRuntimeInstanceV1[];
}): DesignSourceManifestV1 {
  const components = input?.components ?? [
    { id: "intrinsic_button", displayName: "button", kind: "intrinsic" },
  ];
  const instances = input?.instances ?? [
    {
      runtimeInstanceId: "runtime_button_01",
      selector: '[data-aiden-instance="runtime_button_01"]',
      componentId: "intrinsic_button",
      source: source("src/App.tsx", APP_HASH, 25, 78),
    },
  ];
  const body = {
    version: 1 as const,
    id: "manifest_01",
    revision: 3,
    workspaceId: "workspace_01",
    components,
    instances,
  };
  return { ...body, manifestHash: computeDesignSourceManifestHash(body) };
}

function request(
  value: DesignSourceManifestV1,
  overrides: Partial<{
    manifestHash: string;
    runtimeInstanceId: string;
    selector: string;
    componentId: string;
    scope: "runtime-instance" | "component-definition";
  }> = {},
) {
  const instance = value.instances[0]!;
  return {
    version: 1 as const,
    manifestHash: overrides.manifestHash ?? value.manifestHash,
    runtimeInstanceId: overrides.runtimeInstanceId ?? instance.runtimeInstanceId,
    selector: overrides.selector ?? instance.selector,
    componentId: overrides.componentId ?? instance.componentId,
    scope: overrides.scope ?? ("runtime-instance" as const),
  };
}

test("parses a hash-bound manifest and resolves one exact intrinsic runtime instance", () => {
  const value = manifest();
  assert.deepEqual(parseDesignSourceManifest(value), value);
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value),
      currentSourceVersions: { "src/App.tsx": APP_HASH },
    }),
    {
      status: "resolved",
      scope: "runtime-instance",
      runtimeInstanceId: "runtime_button_01",
      componentId: "intrinsic_button",
      binding: source("src/App.tsx", APP_HASH, 25, 78),
      affectedRuntimeInstanceIds: ["runtime_button_01"],
    },
  );
});

test("schema and hash checks reject extra keys, traversal, invalid ranges, tampering, and excess bytes", () => {
  const value = manifest();
  assert.equal(parseDesignSourceManifest({ ...value, authority: "write-anywhere" }), undefined);
  assert.equal(
    parseDesignSourceManifest({
      ...value,
      instances: [
        {
          ...value.instances[0],
          source: { ...value.instances[0]!.source, workspaceRelativePath: "../outside.tsx" },
        },
      ],
    }),
    undefined,
  );
  assert.equal(
    parseDesignSourceManifest({
      ...value,
      instances: [
        {
          ...value.instances[0],
          source: { ...value.instances[0]!.source, end: value.instances[0]!.source.start },
        },
      ],
    }),
    undefined,
  );
  assert.equal(parseDesignSourceManifest({ ...value, revision: value.revision + 1 }), undefined);
  assert.equal(
    parseDesignSourceManifest({ ...value, padding: "x".repeat(DESIGN_SOURCE_MANIFEST_MAX_BYTES) }),
    undefined,
  );
  assert.equal(parseDesignSourceResolutionRequest({ ...request(value), secret: "no" }), undefined);
});

test("a parent relationship cycle invalidates the runtime graph", () => {
  const body = {
    version: 1 as const,
    id: "manifest_cycle",
    revision: 1,
    workspaceId: "workspace_01",
    components: [{ id: "intrinsic_button", displayName: "button", kind: "intrinsic" as const }],
    instances: [
      {
        runtimeInstanceId: "runtime_button_01",
        selector: "#one",
        componentId: "intrinsic_button",
        source: source("src/App.tsx", APP_HASH, 1, 5),
        parentRuntimeInstanceId: "runtime_button_02",
      },
      {
        runtimeInstanceId: "runtime_button_02",
        selector: "#two",
        componentId: "intrinsic_button",
        source: source("src/App.tsx", APP_HASH, 6, 10),
        parentRuntimeInstanceId: "runtime_button_01",
      },
    ],
  };
  assert.equal(
    parseDesignSourceManifest({ ...body, manifestHash: computeDesignSourceManifestHash(body) }),
    undefined,
  );
});

test("resolution rejects stale manifest and current-source mismatches", () => {
  const value = manifest();
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value, { manifestHash: "c".repeat(64) }),
      currentSourceVersions: { "src/App.tsx": APP_HASH },
    }),
    { status: "rejected", reason: "stale-manifest" },
  );
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value),
      currentSourceVersions: {},
    }),
    { status: "rejected", reason: "missing-source-version" },
  );
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value),
      currentSourceVersions: { "src/App.tsx": "d".repeat(64) },
    }),
    { status: "rejected", reason: "stale-source" },
  );
});

test("runtime ID and selector must identify the same unique instance", () => {
  const value = manifest({
    instances: [
      {
        runtimeInstanceId: "runtime_button_01",
        selector: ".duplicate",
        componentId: "intrinsic_button",
        source: source("src/App.tsx", APP_HASH, 25, 78),
      },
      {
        runtimeInstanceId: "runtime_button_02",
        selector: ".duplicate",
        componentId: "intrinsic_button",
        source: source("src/App.tsx", APP_HASH, 90, 140),
      },
    ],
  });
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value),
      currentSourceVersions: { "src/App.tsx": APP_HASH },
    }),
    { status: "rejected", reason: "ambiguous-runtime-instance" },
  );
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value, {
        selector: '[data-aiden-instance="runtime_button_02"]',
      }),
      currentSourceVersions: { "src/App.tsx": APP_HASH },
    }),
    { status: "rejected", reason: "ambiguous-runtime-instance" },
  );
});

test("a shared JSX render site is rejected as repeated-instance ambiguity", () => {
  const shared = source("src/App.tsx", APP_HASH, 25, 78);
  const value = manifest({
    instances: [
      {
        runtimeInstanceId: "runtime_button_01",
        selector: '[data-aiden-instance="runtime_button_01"]',
        componentId: "intrinsic_button",
        source: shared,
      },
      {
        runtimeInstanceId: "runtime_button_02",
        selector: '[data-aiden-instance="runtime_button_02"]',
        componentId: "intrinsic_button",
        source: shared,
      },
    ],
  });
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value),
      currentSourceVersions: { "src/App.tsx": APP_HASH },
    }),
    { status: "rejected", reason: "ambiguous-repeated-instance" },
  );
});

test("custom component identity is exact and repeated definition edits fail closed", () => {
  const component: DesignSourceComponentV1 = {
    id: "component_primary_button",
    displayName: "PrimaryButton",
    kind: "custom",
    definition: source("src/PrimaryButton.tsx", BUTTON_HASH, 20, 180),
  };
  const value = manifest({
    components: [component],
    instances: [
      {
        runtimeInstanceId: "runtime_primary_01",
        selector: '[data-aiden-instance="runtime_primary_01"]',
        componentId: component.id,
        source: source("src/App.tsx", APP_HASH, 25, 78),
      },
      {
        runtimeInstanceId: "runtime_primary_02",
        selector: '[data-aiden-instance="runtime_primary_02"]',
        componentId: component.id,
        source: source("src/App.tsx", APP_HASH, 90, 140),
      },
    ],
  });
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value, { componentId: "component_other" }),
      currentSourceVersions: {
        "src/App.tsx": APP_HASH,
        "src/PrimaryButton.tsx": BUTTON_HASH,
      },
    }),
    { status: "rejected", reason: "component-identity-mismatch" },
  );
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value, { scope: "component-definition" }),
      currentSourceVersions: {
        "src/App.tsx": APP_HASH,
        "src/PrimaryButton.tsx": BUTTON_HASH,
      },
    }),
    { status: "rejected", reason: "ambiguous-repeated-instance" },
  );
});

test("a unique custom component definition resolves only against its current definition hash", () => {
  const component: DesignSourceComponentV1 = {
    id: "component_primary_button",
    displayName: "PrimaryButton",
    kind: "custom",
    definition: source("src/PrimaryButton.tsx", BUTTON_HASH, 20, 180),
  };
  const value = manifest({
    components: [component],
    instances: [
      {
        runtimeInstanceId: "runtime_primary_01",
        selector: '[data-aiden-instance="runtime_primary_01"]',
        componentId: component.id,
        source: source("src/App.tsx", APP_HASH, 25, 78),
      },
    ],
  });
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value, { scope: "component-definition" }),
      currentSourceVersions: {
        "src/App.tsx": APP_HASH,
        "src/PrimaryButton.tsx": BUTTON_HASH,
      },
    }),
    {
      status: "resolved",
      scope: "component-definition",
      runtimeInstanceId: "runtime_primary_01",
      componentId: component.id,
      binding: component.definition,
      affectedRuntimeInstanceIds: ["runtime_primary_01"],
    },
  );
});

test("a custom definition request rejects a stale runtime callsite before using the definition", () => {
  const component: DesignSourceComponentV1 = {
    id: "component_primary_button",
    displayName: "PrimaryButton",
    kind: "custom",
    definition: source("src/PrimaryButton.tsx", BUTTON_HASH, 20, 180),
  };
  const value = manifest({
    components: [component],
    instances: [
      {
        runtimeInstanceId: "runtime_primary_01",
        selector: '[data-aiden-instance="runtime_primary_01"]',
        componentId: component.id,
        source: source("src/App.tsx", APP_HASH, 25, 78),
      },
    ],
  });
  assert.deepEqual(
    resolveDesignSourceSelection({
      manifest: value,
      request: request(value, { scope: "component-definition" }),
      currentSourceVersions: {
        "src/App.tsx": "f".repeat(64),
        "src/PrimaryButton.tsx": BUTTON_HASH,
      },
    }),
    { status: "rejected", reason: "stale-source" },
  );
});
