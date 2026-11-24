import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDesignMdWorker } from "./lint-client.js";
import type { LocatedDesignMd } from "./locate.js";
import { DESIGN_MD_MAX_BYTES, DesignMdReader, withAidenFindings, type DesignMdState } from "./reader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFile(path.join(here, "fixtures", name), "utf8");
const at = (relative: string): LocatedDesignMd => ({ path: relative, source: "workspace" });
const pathological = () => "*a_".repeat(Math.floor(DESIGN_MD_MAX_BYTES / 3));

async function withWorkspace(run: (ws: string) => Promise<void>): Promise<void> {
  const ws = await mkdtemp(path.join(tmpdir(), "aiden-design-md-reader-"));
  try {
    await run(ws);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

/** A reader on the real worker that counts how many lints it starts. */
function countingReader(options: { report?: (event: string, props: unknown) => void } = {}) {
  const counter = { runs: 0 };
  const reader = new DesignMdReader({
    run: ((request, runOptions) => {
      counter.runs++;
      return runDesignMdWorker(request, runOptions);
    }) as typeof runDesignMdWorker,
    report: options.report,
  });
  return { reader, counter };
}

function ok(state: DesignMdState): Extract<DesignMdState, { status: "ok" }> {
  assert.equal(state.status, "ok", JSON.stringify(state));
  return state as Extract<DesignMdState, { status: "ok" }>;
}

test("a valid file reads as ok with counts, sections, omitted and tokens", async () => {
  await withWorkspace(async (ws) => {
    // 0.4.0 accepts only token groups under omitted.
    const content = (await fixture("valid.md"))
      .replace("spacing:\n  sm: 8px\n  md: 16px\n", "")
      .replace("---\n\n## Overview", "omitted:\n  - section: spacing\n    reason: Not designed yet.\n---\n\n## Overview");
    await writeFile(path.join(ws, "DESIGN.md"), content);
    const state = ok(await countingReader().reader.read(ws, at("DESIGN.md")));
    assert.equal(state.path, "DESIGN.md");
    assert.deepEqual(state.summary, { errors: 0, warnings: 0, infos: state.summary.infos });
    assert.ok(state.summary.infos >= 1);
    assert.equal(state.sections[0], "Overview");
    assert.deepEqual(state.omitted, [{ section: "spacing", reason: "Not designed yet." }]);
    assert.deepEqual(
      state.tokens.find((token) => token.path === "colors.primary"),
      { path: "colors.primary", kind: "color", value: "#1a1c1e" },
    );
    assert.match(state.tokens.find((token) => token.path === "typography.body")!.value, /fontFamily: Inter/);
    assert.equal(state.truncated, false);
    assert.match(state.hash, /^[0-9a-f]{64}$/);
  });
});

test("a duplicate section adds one aiden/duplicate-section warning, folding aliases", async () => {
  await withWorkspace(async (ws) => {
    await writeFile(path.join(ws, "DESIGN.md"), await fixture("duplicate-section.md"));
    const state = ok(await countingReader().reader.read(ws, at("DESIGN.md")));
    const duplicates = state.findings.filter((finding) => finding.rule === "aiden/duplicate-section");
    assert.deepEqual(duplicates, [
      { severity: "warning", rule: "aiden/duplicate-section", path: "sections", message: 'Section "Overview" appears 2 times.' },
    ]);
    assert.equal(state.summary.warnings, state.findings.filter((finding) => finding.severity === "warning").length);
  });
});

test("an unresolved token reference adds aiden/unresolved-ref, and the token isn't listed", async () => {
  await withWorkspace(async (ws) => {
    await writeFile(path.join(ws, "DESIGN.md"), await fixture("broken-ref.md"));
    const state = ok(await countingReader().reader.read(ws, at("DESIGN.md")));
    assert.deepEqual(
      state.findings.filter((finding) => finding.rule === "aiden/unresolved-ref"),
      [
        {
          severity: "warning",
          rule: "aiden/unresolved-ref",
          path: "colors.ghost",
          message: "colors.ghost refers to {colors.nope}, which doesn't resolve, so the token is left out.",
        },
      ],
    );
    assert.equal(state.summary.errors, 1);
    assert.equal(state.summary.warnings, 1);
    assert.ok(!state.tokens.some((token) => token.path === "colors.ghost"));
  });
});

test("withAidenFindings adds to the counts without touching the library's findings", () => {
  const result = withAidenFindings({
    summary: { errors: 0, warnings: 0, infos: 0 },
    findings: [],
    sections: ["Colors", "Layout & Spacing", "Layout", "Colors", "Colors"],
    omitted: [],
    symbols: [["colors.a", { unresolved: "{colors.b}" }], ["colors.c", { kind: "color", text: "#000000" }]],
    tailwindConfig: null,
  });
  assert.deepEqual(result.summary, { errors: 0, warnings: 3, infos: 0 });
  assert.deepEqual(
    result.findings.map((finding) => finding.message),
    [
      'Section "Colors" appears 3 times.',
      'Section "Layout" appears 2 times.',
      "colors.a refers to {colors.b}, which doesn't resolve, so the token is left out.",
    ],
  );
});

test("a file over 64 KiB is too-large and no worker runs; exactly 64 KiB is linted", async () => {
  await withWorkspace(async (ws) => {
    const { reader, counter } = countingReader();
    const valid = await fixture("valid.md");
    const exact = valid + "\n" + "x".repeat(DESIGN_MD_MAX_BYTES - Buffer.byteLength(valid) - 1);
    assert.equal(Buffer.byteLength(exact), DESIGN_MD_MAX_BYTES);
    await writeFile(path.join(ws, "DESIGN.md"), exact + "x");
    assert.deepEqual(await reader.read(ws, at("DESIGN.md")), {
      status: "too-large",
      path: "DESIGN.md",
      source: "workspace",
      size: DESIGN_MD_MAX_BYTES + 1,
    });
    assert.equal(counter.runs, 0);
    await writeFile(path.join(ws, "DESIGN.md"), exact);
    ok(await reader.read(ws, at("DESIGN.md")));
    assert.equal(counter.runs, 1);
  });
});

test("a vanished file, a FIFO or a folder reads as unreadable without hanging", { timeout: 10_000 }, async () => {
  await withWorkspace(async (ws) => {
    const { reader, counter } = countingReader();
    assert.equal((await reader.read(ws, at("DESIGN.md"))).status, "unreadable");
    execFileSync("mkfifo", [path.join(ws, "DESIGN.md")]);
    assert.equal((await reader.read(ws, at("DESIGN.md"))).status, "unreadable");
    await rm(path.join(ws, "DESIGN.md"));
    await mkdir(path.join(ws, "DESIGN.md"));
    assert.equal((await reader.read(ws, at("DESIGN.md"))).status, "unreadable");
    assert.equal(counter.runs, 0);
  });
});

test("a DESIGN.md that resolves to a credential file is unreadable and never linted", async () => {
  await withWorkspace(async (ws) => {
    const { reader, counter } = countingReader();
    await writeFile(path.join(ws, ".env"), "---\nname: SECRET_TOKEN=abc\n---\n\n## Overview\n");
    await symlink(".env", path.join(ws, "DESIGN.md"));
    await mkdir(path.join(ws, "keys"));
    await writeFile(path.join(ws, "keys", "id_rsa"), "SECRET_KEY\n");
    await symlink(path.join("keys", "id_rsa"), path.join(ws, "keys.md"));
    for (const relative of ["DESIGN.md", "keys.md"]) {
      const state = await reader.read(ws, at(relative));
      assert.deepEqual(state, { status: "unreadable", path: relative, source: "workspace" }, relative);
      assert.equal((await reader.export(ws, at(relative), "css-vars")).status, "unreadable", relative);
    }
    assert.equal(counter.runs, 0);
  });
});

test("a folder swapped for a link out of the workspace mid-read fails closed as unreadable", async () => {
  await withWorkspace(async (base) => {
    const ws = path.join(base, "ws");
    await mkdir(path.join(ws, "a"), { recursive: true });
    await mkdir(path.join(base, "out", "a"), { recursive: true });
    await writeFile(path.join(ws, "a", "DESIGN.md"), await fixture("valid.md"));
    await writeFile(path.join(base, "out", "a", "DESIGN.md"), "---\nname: SECRET\n---\n\n## Overview\n");
    let runs = 0;
    const reader = new DesignMdReader({
      run: ((request, options) => {
        runs++;
        return runDesignMdWorker(request, options);
      }) as typeof runDesignMdWorker,
      beforeRead: async () => {
        await rename(path.join(ws, "a"), path.join(ws, "a-old"));
        await symlink(path.join(base, "out", "a"), path.join(ws, "a"));
      },
    });
    const state = await reader.read(ws, at("a/DESIGN.md"));
    assert.deepEqual(state, { status: "unreadable", path: "a/DESIGN.md", source: "workspace" });
    assert.equal(runs, 0);
  });
});

test("missing and invalid lookups pass through as states", async () => {
  await withWorkspace(async (ws) => {
    const { reader } = countingReader();
    assert.deepEqual(await reader.read(ws, { missing: true, searched: ["web", "."] }), {
      status: "missing",
      searched: ["web", "."],
    });
    assert.deepEqual(await reader.read(ws, { invalid: "outside-workspace" }), {
      status: "invalid",
      reason: "outside-workspace",
    });
  });
});

test("a pathological file is timed-out, and the second read doesn't start a worker", async () => {
  await withWorkspace(async (ws) => {
    const { reader, counter } = countingReader();
    await writeFile(path.join(ws, "DESIGN.md"), pathological());
    const first = await reader.read(ws, at("DESIGN.md"));
    assert.equal(first.status, "timed-out");
    assert.deepEqual(await reader.read(ws, at("DESIGN.md")), first);
    assert.equal(counter.runs, 1);
  });
});

test("a lint that throws gives lint-failed with fixed words, and no thrown text reaches the state or the log", async () => {
  await withWorkspace(async (ws) => {
    await writeFile(path.join(ws, "DESIGN.md"), await fixture("valid.md"));
    const logs: string[] = [];
    const reader = new DesignMdReader({
      run: ((request, options) =>
        runDesignMdWorker(request, {
          ...options,
          workerUrl: pathToFileURL(path.join(here, "test-support", "throws-on-lint.mjs")),
        })) as typeof runDesignMdWorker,
      log: (message) => logs.push(message),
    });
    const state = await reader.read(ws, at("DESIGN.md"));
    assert.equal(state.status, "lint-failed");
    assert.ok(!JSON.stringify(state).includes("SECRET"));
    assert.ok(logs.length >= 1);
    assert.ok(!logs.join("\n").includes("SECRET"));

    const faked = new DesignMdReader({
      run: (async () => ({ ok: false, status: "lint-failed" })) as unknown as typeof runDesignMdWorker,
    });
    assert.equal((await faked.read(ws, at("DESIGN.md"))).status, "lint-failed");
  });
});

test("an unchanged file is linted once; an edit is linted again", async () => {
  await withWorkspace(async (ws) => {
    const { reader, counter } = countingReader();
    const valid = await fixture("valid.md");
    await writeFile(path.join(ws, "DESIGN.md"), valid);
    await reader.read(ws, at("DESIGN.md"));
    await reader.read(ws, at("DESIGN.md"));
    assert.equal(counter.runs, 1);
    await writeFile(path.join(ws, "DESIGN.md"), valid + "\nMore prose.\n");
    await reader.read(ws, at("DESIGN.md"));
    assert.equal(counter.runs, 2);
  });
});

test("the cache keeps 16 files", async () => {
  await withWorkspace(async (ws) => {
    let runs = 0;
    const reader = new DesignMdReader({
      run: (async () => {
        runs++;
        return {
          ok: true,
          result: { summary: { errors: 0, warnings: 0, infos: 0 }, findings: [], sections: [], omitted: [], symbols: [], tailwindConfig: null },
        };
      }) as unknown as typeof runDesignMdWorker,
    });
    for (let index = 0; index < 17; index++) {
      await mkdir(path.join(ws, `app${index}`));
      await writeFile(path.join(ws, `app${index}`, "DESIGN.md"), `# ${index}\n`);
      await reader.read(ws, at(`app${index}/DESIGN.md`));
    }
    assert.equal(runs, 17);
    await reader.read(ws, at("app16/DESIGN.md"));
    await reader.read(ws, at("app1/DESIGN.md"));
    assert.equal(runs, 17);
    await reader.read(ws, at("app0/DESIGN.md"));
    assert.equal(runs, 18);
  });
});

test("a BOM is stripped before linting", async () => {
  await withWorkspace(async (ws) => {
    const seen: string[] = [];
    const reader = new DesignMdReader({
      run: ((request, options) => {
        seen.push(request.content);
        return runDesignMdWorker(request, options);
      }) as typeof runDesignMdWorker,
    });
    const valid = await fixture("valid.md");
    await writeFile(path.join(ws, "DESIGN.md"), `\uFEFF${valid}`);
    const state = ok(await reader.read(ws, at("DESIGN.md")));
    assert.equal(seen[0], valid);
    assert.ok(state.tokens.some((token) => token.path === "colors.primary"));
  });
});

test("tokens are flat, sorted and capped at 300 with truncated; long values are cut at 200", async () => {
  await withWorkspace(async (ws) => {
    const colors = Array.from({ length: 320 }, (_, index) => `  c${String(index).padStart(3, "0")}: "#${index.toString(16).padStart(6, "0")}"`);
    const family = "F".repeat(300);
    await writeFile(
      path.join(ws, "DESIGN.md"),
      `---\nname: Many\ncolors:\n${colors.join("\n")}\ntypography:\n  aaa:\n    fontFamily: ${family}\n---\n\n## Overview\n`,
    );
    const state = ok(await countingReader().reader.read(ws, at("DESIGN.md")));
    assert.equal(state.tokens.length, 300);
    assert.equal(state.truncated, true);
    const paths = state.tokens.map((token) => token.path);
    assert.deepEqual(paths, [...paths].sort());
    assert.equal(paths[0], "colors.c000");

    await writeFile(path.join(ws, "DESIGN.md"), `---\nname: Long\ntypography:\n  aaa:\n    fontFamily: ${family}\n---\n\n## Overview\n`);
    const long = ok(await countingReader().reader.read(ws, at("DESIGN.md")));
    const value = long.tokens.find((token) => token.path === "typography.aaa")!.value;
    assert.ok(value.length <= 200, `${value.length}`);
    assert.ok(value.startsWith("fontFamily: FFF"));
  });
});

test("a file read reports design_md_linted once per new content, bucketed", async () => {
  await withWorkspace(async (ws) => {
    const events: Array<[string, unknown]> = [];
    const { reader } = countingReader({ report: (event, props) => events.push([event, props]) });
    // Two warnings: a duplicate section (Aiden's) and the library's section order.
    await writeFile(path.join(ws, "DESIGN.md"), await fixture("duplicate-section.md"));
    const state = ok(await reader.read(ws, at("DESIGN.md")));
    assert.equal(state.summary.errors, 0);
    assert.equal(state.summary.warnings, 2);
    assert.deepEqual(events, [["design_md_linted", { errors_bucket: "0", warnings_bucket: "2-3" }]]);

    await reader.read(ws, at("DESIGN.md"));
    await reader.lintContent(await fixture("broken-ref.md"));
    assert.equal(events.length, 1);

    await writeFile(path.join(ws, "DESIGN.md"), await fixture("broken-ref.md"));
    await reader.read(ws, at("DESIGN.md"), { report: false });
    assert.equal(events.length, 1);
    await reader.read(ws, at("DESIGN.md"));
    assert.deepEqual(events[1], ["design_md_linted", { errors_bucket: "1", warnings_bucket: "1" }]);
    await reader.read(ws, at("DESIGN.md"));
    assert.equal(events.length, 2);
  });
});
