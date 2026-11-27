import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { canonicalSection, DESIGN_MD_SECTION_ALIASES } from "./sections.js";

test("the alias table matches the installed linter's spec-config.yaml", () => {
  // The linter's own data file, read as data: the same one it reads at import.
  const linterDir = path.dirname(fileURLToPath(import.meta.resolve("@google/design.md/linter")));
  const spec = parse(readFileSync(path.join(linterDir, "spec-config.yaml"), "utf8")) as {
    sections: Array<{ canonical: string; aliases?: string[] }>;
  };
  const expected: Record<string, string> = {};
  for (const section of spec.sections) {
    for (const alias of section.aliases ?? []) expected[alias] = section.canonical;
  }
  assert.ok(Object.keys(expected).length > 0, "the linter declares aliases");
  assert.deepEqual({ ...DESIGN_MD_SECTION_ALIASES }, expected);
  for (const [alias, canonical] of Object.entries(expected)) assert.equal(canonicalSection(alias), canonical);
  assert.equal(canonicalSection("Colors"), "Colors");
  assert.equal(canonicalSection("Motion"), "Motion");
});
