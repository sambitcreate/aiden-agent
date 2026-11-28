import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { designMdDraftFor, designMdDraftResultFor, draftDesignMd, type DesignTokenSnapshot } from "./draft.js";
import { runDesignMdWorker } from "./lint-client.js";

/** The front matter (between the first two `---` lines) and the `## ` headings after it. */
function split(draft: string): { front: Record<string, unknown>; headings: string[] } {
  const lines = draft.split("\n");
  assert.equal(lines[0], "---");
  const end = lines.indexOf("---", 1);
  assert.ok(end > 0, "the front matter closes");
  const front = parse(lines.slice(1, end).join("\n")) as Record<string, unknown>;
  const headings = lines.slice(end + 1).filter((line) => line.startsWith("## ")).map((line) => line.slice(3));
  return { front, headings };
}

const LIBRARY_ORDER = ["Overview", "Colors", "Typography", "Layout", "Elevation & Depth", "Shapes", "Components", "Do's and Don'ts"];

async function lintSummary(content: string) {
  const outcome = await runDesignMdWorker({ op: "lint", content });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return (outcome as Extract<typeof outcome, { ok: true }>).result;
}

const snapshot: DesignTokenSnapshot = {
  name: "Acme",
  colors: [
    { name: "--primary", value: "#1a1c1e", dark: "#fafafa" },
    { name: "--surface", value: "#ffffff" },
  ],
  fonts: [{ name: "--font-sans", family: "Inter" }],
};

test("a draft from colours and fonts lints with no errors", async () => {
  const result = await lintSummary(draftDesignMd(snapshot));
  assert.equal(result.summary.errors, 0, JSON.stringify(result.findings));
  assert.equal(result.summary.warnings, 0, JSON.stringify(result.findings));
});

test("sections without evidence are under omitted, and the rest come in the library's order", () => {
  const { front, headings } = split(draftDesignMd({ colors: [{ name: "brand", value: "#ff0000" }], fonts: [] }));
  const omitted = (front.omitted as Array<{ section: string; reason: string }>).map((entry) => entry.section);
  assert.ok(omitted.includes("typography"));
  assert.ok(!omitted.includes("colors"));
  for (const entry of front.omitted as Array<{ reason: string }>) assert.equal(entry.reason, "No evidence in the app's styles yet.");
  assert.ok(headings.includes("Colors"));
  assert.ok(!headings.includes("Typography"));
  assert.deepEqual(headings, LIBRARY_ORDER.filter((name) => headings.includes(name)));

  const full = split(
    draftDesignMd({
      ...snapshot,
      rounded: [{ name: "md", value: "8px" }],
      spacing: [{ name: "md", value: "16px" }],
    }),
  );
  assert.deepEqual(full.headings, LIBRARY_ORDER.filter((name) => full.headings.includes(name)));
  assert.ok(full.headings.includes("Layout") && full.headings.includes("Shapes") && full.headings.includes("Typography"));
  assert.deepEqual(full.front.rounded, { md: "8px" });
  assert.deepEqual(full.front.spacing, { md: "16px" });
});

test("dark values go to a dark group", async () => {
  const { front } = split(draftDesignMd(snapshot));
  assert.deepEqual(front.colors, { primary: "#1a1c1e", surface: "#ffffff", dark: { primary: "#fafafa" } });
  assert.deepEqual(front.typography, { sans: { fontFamily: "Inter" } });
  const result = await lintSummary(draftDesignMd(snapshot));
  assert.ok(result.symbols.some(([key]) => key === "colors.dark.primary"));
});

test("token names are made safe and unique", () => {
  const { front } = split(
    draftDesignMd({
      colors: [
        { name: "--Primary", value: "#000001" },
        { name: "$primary", value: "#000002" },
        { name: "primary", value: "#000003" },
        { name: null, value: "#000004" },
        { name: "Brand Blue!", value: "#000005" },
      ],
      fonts: [{ name: null, family: "Inter" }, { name: "display", family: "Fraunces" }],
    }),
  );
  assert.deepEqual(Object.keys(front.colors as object), ["primary", "primary-2", "primary-3", "color-1", "brand-blue"]);
  assert.deepEqual(Object.keys(front.typography as object), ["font-1", "display"]);
});

test("a value can't break the YAML", () => {
  const family = 'Inter"\n---\ncolors:';
  const { front } = split(draftDesignMd({ name: "x\n---\nname: y", colors: [], fonts: [{ name: "sans", family }] }));
  assert.deepEqual(front.typography, { sans: { fontFamily: family } });
  assert.equal(front.name, "x\n---\nname: y");
  assert.deepEqual(Object.keys(front).sort(), ["name", "omitted", "typography"].sort());
});

test("a draft over 32 KiB drops colours until it fits, and still lints", async () => {
  const many: DesignTokenSnapshot = {
    colors: Array.from({ length: 500 }, (_, index) => ({ name: `shade-${index}-${"x".repeat(60)}`, value: `#${index.toString(16).padStart(6, "0")}` })),
    fonts: [{ name: "sans", family: "Inter" }],
  };
  const draft = draftDesignMd(many);
  assert.ok(Buffer.byteLength(draft) <= 32 * 1024, `${Buffer.byteLength(draft)}`);
  const colors = Object.keys(split(draft).front.colors as object);
  assert.ok(colors.length > 0 && colors.length < 500);
  assert.equal(colors[0], `shade-0-${"x".repeat(60)}`);
  const result = await lintSummary(draft);
  assert.equal(result.summary.errors, 0);
});

test("designMdDraftFor reads only the app root's own style files", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "aiden-design-md-draft-"));
  try {
    await mkdir(path.join(ws, "web/src"), { recursive: true });
    await mkdir(path.join(ws, "other"), { recursive: true });
    await writeFile(
      path.join(ws, "web/src/index.css"),
      ":root { --primary: #1a1c1e; --font-sans: Inter, sans-serif; }\n.dark { --primary: #fafafa; }\n",
    );
    await writeFile(path.join(ws, "other/theme.css"), ":root { --outside: #ff00ff; }\n");
    const { front } = split(await designMdDraftFor(ws, "web"));
    const colors = front.colors as Record<string, unknown>;
    assert.equal(colors.primary, "#1a1c1e");
    assert.deepEqual(colors.dark, { primary: "#fafafa" });
    assert.ok(!JSON.stringify(front).includes("ff00ff"));
    assert.ok(!("outside" in colors));
    await assert.rejects(designMdDraftFor(ws, "../elsewhere"));
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("3d: designMdDraftResultFor counts the tokens, names the sources, and refuses a source that links out", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "aiden-design-md-draft-")));
  try {
    const ws = path.join(base, "ws");
    await mkdir(path.join(ws, "desk/src"), { recursive: true });
    await mkdir(path.join(base, "outside/src"), { recursive: true });
    await writeFile(path.join(ws, "desk/src/index.css"), ":root { --primary: #1a1c1e; --font-sans: Inter, sans-serif; }\n");
    await writeFile(path.join(base, "outside/src/index.css"), ":root { --leak: #ff00ff; }\n");
    const result = await designMdDraftResultFor(ws, "desk");
    assert.deepEqual([result.colors, result.fonts, result.sources], [1, 1, ["desk/src/index.css"]]);
    assert.equal((split(result.content).front.colors as Record<string, unknown>).primary, "#1a1c1e");
    assert.equal((await lintSummary(result.content)).summary.errors, 0);

    await symlink(path.join(base, "outside"), path.join(ws, "linked"));
    await assert.rejects(designMdDraftResultFor(ws, "linked"));
    await mkdir(path.join(ws, "nested"));
    await symlink(path.join(base, "outside/src"), path.join(ws, "nested/src"));
    await assert.rejects(designMdDraftResultFor(ws, "nested/src"), "a link on the way");
    await assert.rejects(designMdDraftResultFor(ws, "../outside"));
    const empty = await designMdDraftResultFor(ws, "nested");
    assert.deepEqual([empty.colors, empty.fonts], [0, 0], "a link inside the source isn't followed");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
