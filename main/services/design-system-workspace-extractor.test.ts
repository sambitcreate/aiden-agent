import assert from "node:assert/strict";
import { symlink, lstat, mkdtemp, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DESIGN_SYSTEM_SOURCE_MAX_BYTES,
  DesignSystemWorkspaceExtractionError,
  extractReviewedDesignSystemIndex,
  inspectReviewedDesignSystemSources,
  type DesignSystemWorkspaceAuthority,
} from "./design-system-workspace-extractor.js";

async function workspace(t: test.TestContext): Promise<{
  root: string;
  authority: DesignSystemWorkspaceAuthority;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiden-design-system-workspace-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await stat(root, { bigint: true });
  return {
    root,
    authority: {
      rootPath: root,
      device: identity.dev.toString(),
      inode: identity.ino.toString(),
    },
  };
}

function tokenDocument(color = "#635bff") {
  return {
    version: 1,
    kind: "tokens",
    tokens: {
      colors: [{ name: "color.action.primary", value: color }],
      spacing: [{ name: "space.control.inline", value: "12px" }],
      typography: [
        {
          name: "type.label.compact",
          families: ["Inter", "system-ui"],
          size: "14px",
          lineHeight: "1.4",
          weight: 600,
        },
      ],
      radii: [{ name: "radius.control.medium", value: "10px" }],
      shadows: [{ name: "shadow.overlay.low", value: "0 8px 24px #00000022" }],
    },
  };
}

function catalogDocument() {
  return {
    version: 1,
    kind: "catalog",
    components: [
      {
        name: "Button",
        description: "Primary interaction control",
        reviewed: true,
        variants: ["primary", "secondary"],
        states: ["hover", "focus-visible", "disabled"],
      },
    ],
    icons: [{ name: "ArrowRight", label: "Continue", style: "outline", tags: ["navigation"] }],
  };
}

function input(authority: DesignSystemWorkspaceAuthority) {
  return {
    name: "Acme Semantic UI",
    authority,
    sources: [
      {
        sourceId: "source:tokens",
        workspaceRelativePath: "semantic.tokens.json",
        kind: "tokens-v1",
        reviewed: true,
      },
      {
        sourceId: "source:catalog",
        workspaceRelativePath: "components.catalog.json",
        kind: "catalog-v1",
        reviewed: true,
      },
    ],
  };
}

test("extracts strict static metadata from reviewed regular JSON files", async (t) => {
  const { root, authority } = await workspace(t);
  await writeFile(join(root, "semantic.tokens.json"), JSON.stringify(tokenDocument()), {
    mode: 0o600,
  });
  await writeFile(join(root, "components.catalog.json"), JSON.stringify(catalogDocument()), {
    mode: 0o600,
  });

  const result = await extractReviewedDesignSystemIndex(input(authority));
  assert.equal(result.tokens.colors[0]?.name, "color.action.primary");
  assert.equal(result.components[0]?.name, "Button");
  assert.equal(result.icons[0]?.name, "ArrowRight");
  assert.deepEqual(
    result.sources.map(({ workspaceRelativePath }) => workspaceRelativePath).sort(),
    ["components.catalog.json", "semantic.tokens.json"],
  );
  assert.ok(result.sources.every(({ sha256 }) => /^[a-f0-9]{64}$/u.test(sha256)));

  const inspected = await inspectReviewedDesignSystemSources(input(authority));
  assert.deepEqual(inspected, result.sources);
});

test("rejects absolute, traversal, backslash, and unreviewed source selections", async (t) => {
  const { authority } = await workspace(t);
  for (const [workspaceRelativePath, reviewed] of [
    ["/tmp/tokens.json", true],
    ["../tokens.json", true],
    ["nested\\tokens.json", true],
    ["tokens.json", false],
  ] as const) {
    const candidate = input(authority);
    candidate.sources = [
      {
        ...candidate.sources[0]!,
        workspaceRelativePath,
        reviewed,
      },
    ] as typeof candidate.sources;
    await assert.rejects(
      inspectReviewedDesignSystemSources(candidate),
      DesignSystemWorkspaceExtractionError,
    );
  }
});

test("rejects direct and ancestor symlinks without reading outside the workspace", async (t) => {
  const { root, authority } = await workspace(t);
  const outside = join(root, "..", `outside-${Date.now()}.json`);
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, JSON.stringify(tokenDocument("#ffffff")), { mode: 0o600 });
  await symlink(outside, join(root, "semantic.tokens.json"));
  const direct = input(authority);
  direct.sources = [direct.sources[0]!];
  await assert.rejects(extractReviewedDesignSystemIndex(direct), /symlink/u);

  await unlink(join(root, "semantic.tokens.json"));
  await symlink(join(root, ".."), join(root, "linked-parent"));
  const outsideName = outside.split("/").pop();
  assert.ok(outsideName);
  const ancestor = input(authority);
  ancestor.sources = [
    {
      ...ancestor.sources[0]!,
      workspaceRelativePath: `linked-parent/${outsideName}`,
    },
  ];
  await assert.rejects(extractReviewedDesignSystemIndex(ancestor), /symlink/u);
});

test("rejects workspace identity replacement and a path swapped before open", async (t) => {
  const { root, authority } = await workspace(t);
  const source = join(root, "semantic.tokens.json");
  const outside = join(root, "outside.json");
  await writeFile(source, JSON.stringify(tokenDocument()), { mode: 0o600 });
  await writeFile(outside, JSON.stringify(tokenDocument("#ffffff")), { mode: 0o600 });
  const one = input(authority);
  one.sources = [one.sources[0]!];

  await assert.rejects(
    inspectReviewedDesignSystemSources({
      ...one,
      authority: { ...authority, inode: (BigInt(authority.inode) + 1n).toString() },
    }),
    /workspace changed/u,
  );

  await assert.rejects(
    inspectReviewedDesignSystemSources(one, {
      observer: {
        async beforeFileOpen() {
          await unlink(source);
          await symlink(outside, source);
        },
      },
    }),
    /changed before|symlink/u,
  );
  assert.equal((await lstat(source)).isSymbolicLink(), true);
});

test("rejects a symlink swap after descriptor read at final publication proof", async (t) => {
  const { root, authority } = await workspace(t);
  const source = join(root, "semantic.tokens.json");
  const outside = join(root, "outside.json");
  await writeFile(source, JSON.stringify(tokenDocument()), { mode: 0o600 });
  await writeFile(outside, JSON.stringify(tokenDocument("#ffffff")), { mode: 0o600 });
  const one = input(authority);
  one.sources = [one.sources[0]!];

  await assert.rejects(
    inspectReviewedDesignSystemSources(one, {
      observer: {
        async beforeFinalVerification() {
          await unlink(source);
          await symlink(outside, source);
        },
      },
    }),
    /changed while/u,
  );
});

test("enforces per-file and aggregate source byte ceilings", async (t) => {
  const { root, authority } = await workspace(t);
  await writeFile(
    join(root, "large.json"),
    Buffer.alloc(DESIGN_SYSTEM_SOURCE_MAX_BYTES + 1, 0x20),
    {
      mode: 0o600,
    },
  );
  const oversized = input(authority);
  oversized.sources = [
    {
      ...oversized.sources[0]!,
      workspaceRelativePath: "large.json",
    },
  ];
  await assert.rejects(inspectReviewedDesignSystemSources(oversized), /bounded|byte limit/u);

  const chunk = Buffer.alloc(180 * 1024, 0x20);
  for (const name of ["one.json", "two.json", "three.json"]) {
    await writeFile(join(root, name), chunk, { mode: 0o600 });
  }
  const aggregate = {
    name: "Aggregate",
    authority,
    sources: ["one.json", "two.json", "three.json"].map((workspaceRelativePath, index) => ({
      sourceId: `source:${index}`,
      workspaceRelativePath,
      kind: "tokens-v1",
      reviewed: true,
    })),
  };
  await assert.rejects(inspectReviewedDesignSystemSources(aggregate), /total byte limit/u);
});

test("does not execute package code and rejects unknown or dynamic document content", async (t) => {
  const { root, authority } = await workspace(t);
  const marker = "__aidenDesignSystemExecuted";
  delete (globalThis as Record<string, unknown>)[marker];
  await writeFile(
    join(root, "semantic.tokens.json"),
    `globalThis.${marker} = true; export default ${JSON.stringify(tokenDocument())}`,
    { mode: 0o600 },
  );
  const one = input(authority);
  one.sources = [one.sources[0]!];
  await assert.rejects(extractReviewedDesignSystemIndex(one), /valid UTF-8 JSON/u);
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);

  await writeFile(
    join(root, "semantic.tokens.json"),
    JSON.stringify({ ...tokenDocument(), packageScript: "postinstall" }),
    { mode: 0o600 },
  );
  await assert.rejects(extractReviewedDesignSystemIndex(one), /exact version 1/u);

  await writeFile(
    join(root, "semantic.tokens.json"),
    JSON.stringify(tokenDocument("var(--brand)")),
    { mode: 0o600 },
  );
  await assert.rejects(extractReviewedDesignSystemIndex(one), /dynamic or unsupported/u);
});
