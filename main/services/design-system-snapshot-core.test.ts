import assert from "node:assert/strict";
import test from "node:test";
import {
  DESIGN_SYSTEM_MAX_COMPONENTS,
  DESIGN_SYSTEM_MAX_DEPTH,
  DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
  DesignSystemSnapshotError,
  createDesignSystemAttachment,
  detachDesignSystemAttachment,
  getCurrentDesignSystemSnapshot,
  inspectDesignSystemFreshness,
  parseDesignSystemAttachmentRecord,
  parseDesignSystemSnapshot,
  refreshDesignSystemAttachment,
  type DesignSystemIndexInputV1,
} from "./design-system-snapshot-core.js";

const TOKENS_HASH = "a".repeat(64);
const COMPONENTS_HASH = "b".repeat(64);

function goldenInput(): DesignSystemIndexInputV1 {
  return {
    version: 1,
    name: " Acme   Semantic UI ",
    sources: [
      {
        sourceId: "source:components",
        workspaceRelativePath: "packages/ui/components.catalog.json",
        fileType: "regular-file",
        sha256: COMPONENTS_HASH,
      },
      {
        sourceId: "source:tokens",
        workspaceRelativePath: "packages/tokens/semantic.json",
        fileType: "regular-file",
        sha256: TOKENS_HASH,
      },
    ],
    tokens: {
      colors: [
        { name: "color.action.primary", value: "#635bff", sourceId: "source:tokens" },
        { name: "color.surface.canvas", value: "oklch(98% 0.01 250)", sourceId: "source:tokens" },
      ],
      spacing: [{ name: "space.control.inline", value: "0.75rem", sourceId: "source:tokens" }],
      typography: [
        {
          name: "type.label.compact",
          families: ["Inter", "system-ui"],
          size: "0.875rem",
          lineHeight: "1.4",
          weight: 600,
          letterSpacing: "-0.01em",
          sourceId: "source:tokens",
        },
      ],
      radii: [{ name: "radius.control.medium", value: "0.625rem", sourceId: "source:tokens" }],
      shadows: [
        { name: "shadow.overlay.low", value: "0 8px 24px #00000022", sourceId: "source:tokens" },
      ],
    },
    components: [
      {
        name: "Button",
        description: "Primary interaction control",
        reviewed: true,
        variants: ["secondary", "primary"],
        states: ["disabled", "focus-visible", "hover"],
        sourceId: "source:components",
      },
    ],
    icons: [
      {
        name: "ArrowRight",
        label: "Continue",
        style: "outline",
        tags: ["navigation", "direction"],
        sourceId: "source:components",
      },
    ],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("golden semantic names survive path-free deterministic normalization", () => {
  const record = createDesignSystemAttachment(goldenInput(), {
    attachmentId: "design-system:acme",
    now: 1_000,
  });

  assert.equal(record.snapshot.name, "Acme Semantic UI");
  assert.deepEqual(
    record.snapshot.tokens.colors.map(({ name }) => name),
    ["color.action.primary", "color.surface.canvas"],
  );
  assert.equal(record.snapshot.tokens.typography[0]?.name, "type.label.compact");
  assert.equal(record.snapshot.tokens.radii[0]?.name, "radius.control.medium");
  assert.equal(record.snapshot.tokens.shadows[0]?.name, "shadow.overlay.low");
  assert.equal(record.snapshot.components[0]?.name, "Button");
  assert.equal(record.snapshot.icons[0]?.name, "ArrowRight");
  assert.deepEqual(record.snapshot.components[0]?.variants, ["primary", "secondary"]);
  assert.equal(JSON.stringify(record.snapshot).includes("packages/"), false);
  assert.equal("provenance" in record.snapshot, false);
  assert.deepEqual(
    record.provenance.map(({ workspaceRelativePath }) => workspaceRelativePath),
    ["packages/ui/components.catalog.json", "packages/tokens/semantic.json"],
  );

  assert.deepEqual(parseDesignSystemSnapshot(clone(record.snapshot)), record.snapshot);
  assert.deepEqual(parseDesignSystemAttachmentRecord(clone(record)), record);
  assert.equal(
    createDesignSystemAttachment(goldenInput(), {
      attachmentId: "design-system:acme",
      now: 9_000,
    }).snapshot.contentHash,
    record.snapshot.contentHash,
  );
});

test("unknown keys, dynamic values, unreviewed components, and unknown sources fail closed", () => {
  const cases: unknown[] = [];

  const unknownKey = clone(goldenInput()) as DesignSystemIndexInputV1 & { script: string };
  unknownKey.script = "process.exit()";
  cases.push(unknownKey);

  const dynamicColor = clone(goldenInput());
  dynamicColor.tokens.colors[0]!.value = "var(--brand)";
  cases.push(dynamicColor);

  const dynamicSpacing = clone(goldenInput());
  dynamicSpacing.tokens.spacing[0]!.value = "calc(1rem + 2px)";
  cases.push(dynamicSpacing);

  const unreviewed = clone(goldenInput()) as unknown as Record<string, unknown>;
  (unreviewed.components as Array<Record<string, unknown>>)[0]!.reviewed = false;
  cases.push(unreviewed);

  const unknownSource = clone(goldenInput());
  unknownSource.icons[0]!.sourceId = "source:unknown";
  cases.push(unknownSource);

  for (const candidate of cases) {
    assert.throws(
      () => createDesignSystemAttachment(candidate, { attachmentId: "design-system:bad", now: 1 }),
      DesignSystemSnapshotError,
    );
  }
});

test("source paths are relative and symlink or unsupported entries fail closed", () => {
  for (const path of [
    "/Users/example/secrets.json",
    "../tokens.json",
    "tokens\\theme.json",
    "a//b",
  ]) {
    const input = clone(goldenInput());
    input.sources[0]!.workspaceRelativePath = path;
    assert.throws(
      () => createDesignSystemAttachment(input, { attachmentId: "design-system:path", now: 1 }),
      DesignSystemSnapshotError,
    );
  }

  for (const fileType of ["symlink", "directory", "unsupported"] as const) {
    const input = clone(goldenInput());
    input.sources[0]!.fileType = fileType;
    assert.throws(
      () => createDesignSystemAttachment(input, { attachmentId: "design-system:link", now: 1 }),
      /regular files/u,
    );
  }
});

test("strict token, component, depth, key, and byte ceilings reject malicious input", () => {
  const tooManyTokens = clone(goldenInput());
  tooManyTokens.tokens.spacing = Array.from(
    { length: DESIGN_SYSTEM_MAX_TOKENS_PER_KIND + 1 },
    (_, index) => ({
      name: `space.item.${index}`,
      value: "1px",
      sourceId: "source:tokens",
    }),
  );
  assert.throws(
    () =>
      createDesignSystemAttachment(tooManyTokens, { attachmentId: "design-system:tokens", now: 1 }),
    /count limit/u,
  );

  const tooManyComponents = clone(goldenInput());
  tooManyComponents.components = Array.from(
    { length: DESIGN_SYSTEM_MAX_COMPONENTS + 1 },
    (_, index) => ({
      name: `Component${index}`,
      reviewed: true as const,
      variants: [],
      states: [],
      sourceId: "source:components",
    }),
  );
  assert.throws(
    () =>
      createDesignSystemAttachment(tooManyComponents, {
        attachmentId: "design-system:components",
        now: 1,
      }),
    /count limit/u,
  );

  let nested: unknown = "value";
  for (let index = 0; index < DESIGN_SYSTEM_MAX_DEPTH + 2; index += 1) nested = { nested };
  assert.throws(
    () => createDesignSystemAttachment(nested, { attachmentId: "design-system:depth", now: 1 }),
    /nesting limit/u,
  );

  const oversized = clone(goldenInput());
  oversized.name = "x".repeat(600 * 1024);
  assert.throws(
    () => createDesignSystemAttachment(oversized, { attachmentId: "design-system:bytes", now: 1 }),
    /byte limit/u,
  );
});

test("accessors and cyclic or class-backed input cannot execute during indexing", () => {
  let executed = false;
  const input = clone(goldenInput()) as unknown as Record<string, unknown>;
  Object.defineProperty(input, "malicious", {
    enumerable: true,
    get() {
      executed = true;
      return "payload";
    },
  });
  assert.throws(
    () => createDesignSystemAttachment(input, { attachmentId: "design-system:accessor", now: 1 }),
    /accessors/u,
  );
  assert.equal(executed, false);

  const cyclic = clone(goldenInput()) as unknown as Record<string, unknown>;
  cyclic.cycle = cyclic;
  assert.throws(
    () => createDesignSystemAttachment(cyclic, { attachmentId: "design-system:cycle", now: 1 }),
    /cycles/u,
  );

  class Crafted {}
  assert.throws(
    () =>
      createDesignSystemAttachment(new Crafted(), { attachmentId: "design-system:class", now: 1 }),
    /plain data/u,
  );
});

test("freshness is hash and provenance bound and stale snapshots are never returned as current", () => {
  const input = goldenInput();
  const record = createDesignSystemAttachment(input, {
    attachmentId: "design-system:acme",
    now: 1_000,
  });
  const currentSources = input.sources;

  assert.equal(inspectDesignSystemFreshness(record, currentSources), "current");
  assert.equal(
    getCurrentDesignSystemSnapshot(record, currentSources).snapshot?.contentHash,
    record.snapshot.contentHash,
  );

  const changed = clone(currentSources);
  changed[0]!.sha256 = "c".repeat(64);
  assert.equal(inspectDesignSystemFreshness(record, changed), "changed");
  assert.deepEqual(getCurrentDesignSystemSnapshot(record, changed), {
    freshness: "changed",
    snapshot: null,
  });

  const moved = clone(currentSources);
  moved[0]!.workspaceRelativePath = "packages/ui/renamed.catalog.json";
  assert.equal(inspectDesignSystemFreshness(record, moved), "changed");

  assert.equal(inspectDesignSystemFreshness(record, currentSources.slice(1)), "missing");
  assert.deepEqual(getCurrentDesignSystemSnapshot(record, currentSources.slice(1)), {
    freshness: "missing",
    snapshot: null,
  });
  assert.equal(inspectDesignSystemFreshness(record, []), "missing");
});

test("refresh increments identity-bound revisions and detects tampering", () => {
  const original = createDesignSystemAttachment(goldenInput(), {
    attachmentId: "design-system:acme",
    now: 1_000,
  });
  const changed = goldenInput();
  changed.tokens.colors[0]!.value = "#4438ff";
  changed.sources[1]!.sha256 = "c".repeat(64);
  const refreshed = refreshDesignSystemAttachment(original, changed, 2_000);

  assert.equal(refreshed.revision, 2);
  assert.equal(refreshed.snapshot.revision, 2);
  assert.notEqual(refreshed.snapshot.contentHash, original.snapshot.contentHash);
  assert.equal(inspectDesignSystemFreshness(refreshed, changed.sources), "current");

  const tampered = clone(refreshed.snapshot);
  tampered.tokens.colors[0]!.value = "#ffffff";
  assert.throws(() => parseDesignSystemSnapshot(tampered), /hashes do not match/u);
});

test("detach removes snapshot and relative provenance and is idempotent", () => {
  const attached = createDesignSystemAttachment(goldenInput(), {
    attachmentId: "design-system:acme",
    now: 1_000,
  });
  const detached = detachDesignSystemAttachment(attached, 2_000);

  assert.equal(detached.state, "detached");
  assert.equal("snapshot" in detached, false);
  assert.equal("provenance" in detached, false);
  assert.equal(JSON.stringify(detached).includes("packages/"), false);
  assert.equal(inspectDesignSystemFreshness(detached, goldenInput().sources), "detached");
  assert.deepEqual(getCurrentDesignSystemSnapshot(detached, goldenInput().sources), {
    freshness: "detached",
    snapshot: null,
  });
  assert.deepEqual(detachDesignSystemAttachment(detached, 3_000), detached);
  assert.throws(
    () => refreshDesignSystemAttachment(detached, goldenInput(), 3_000),
    /explicitly attached again/u,
  );
});

test("persisted snapshot and record parsers reject path leaks and unknown keys", () => {
  const record = createDesignSystemAttachment(goldenInput(), {
    attachmentId: "design-system:acme",
    now: 1_000,
  });
  const snapshotWithPath = { ...clone(record.snapshot), workspaceRelativePath: "secret/file.ts" };
  assert.throws(() => parseDesignSystemSnapshot(snapshotWithPath), DesignSystemSnapshotError);

  const recordWithAuthority = { ...clone(record), workspaceId: "workspace:write-capability" };
  assert.throws(
    () => parseDesignSystemAttachmentRecord(recordWithAuthority),
    DesignSystemSnapshotError,
  );

  const traversal = clone(record);
  traversal.provenance[0]!.workspaceRelativePath = "../../secret";
  assert.throws(() => parseDesignSystemAttachmentRecord(traversal), /traverse/u);
});
