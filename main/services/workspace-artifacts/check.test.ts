import assert from "node:assert/strict";
import test from "node:test";
import { compileAum } from "../../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION, type ChatUiVisualV1 } from "../../../renderer/shared/aiden-ui/types.js";
import type {
  WorkspaceArtifactActionV1,
  WorkspaceArtifactSourceResultV1,
  WorkspaceArtifactSourceV1,
} from "../../../renderer/shared/workspace-artifacts.js";
import { checkWorkspaceArtifactPage, describeWorkspaceArtifactPageCheck } from "./check.js";

function page(markup: string): ChatUiVisualV1 {
  const compiled = compileAum(markup, { artifactActions: true });
  assert.ok(compiled.tree, "the fixture markup should compile");
  assert.deepEqual(compiled.diagnostics, [], "the fixture markup should compile cleanly");
  return {
    version: 1,
    kind: "ui",
    id: "pending",
    title: "Page",
    catalogVersion: AIDEN_UI_CATALOG_VERSION,
    tree: compiled.tree,
    ...(compiled.dataJson ? { dataJson: compiled.dataJson } : {}),
    ...(compiled.state ? { state: compiled.state } : {}),
    fallbackText: compiled.fallbackText,
  };
}

const PULLS: WorkspaceArtifactSourceV1 = { name: "pulls", kind: "shell", command: "gh pr list --json number,title,url", parse: "json" };
const MERGE: WorkspaceArtifactActionV1 = {
  name: "merge",
  label: "Merge",
  command: "gh pr merge {{number}}",
  params: [{ name: "number", type: "number" }],
};

function ok(value: unknown): WorkspaceArtifactSourceResultV1 {
  return { status: "ok", at: 1, dataJson: JSON.stringify(value) };
}

const ROWS = [
  { number: 12, title: "Fix login", url: "https://example.test/12" },
  { number: 13, title: "Add tests", url: "https://example.test/13" },
];

function check(markup: string, results: Record<string, WorkspaceArtifactSourceResultV1> | undefined, actions = [MERGE]) {
  return checkWorkspaceArtifactPage({ visual: page(markup), sources: [PULLS], actions }, results);
}

test("a page that reads the fields its data has passes", () => {
  const result = check(
    `<Visual title="PRs"><Text>{len($pulls)} open</Text><Each in={$pulls} as="pr"><Text>{$pr.title}</Text><Button action={run("merge", $pr.number)}>Merge</Button></Each></Visual>`,
    { pulls: ok(ROWS) },
  );
  assert.deepEqual(result, { findings: [], unchecked: [] });
  assert.match(describeWorkspaceArtifactPageCheck(result), /every value the page reads was found/u);
});

test("a misspelled field names the field and lists the ones the data has", () => {
  const { findings } = check(`<Visual title="PRs"><Each in={$pulls} as="pr"><Text>{$pr.titel}</Text></Each></Visual>`, {
    pulls: ok(ROWS),
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /\$pr\.titel/u);
  assert.match(findings[0]!, /number, title, url/u);
});

test("a field some rows have and others lack is an optional field, not a mistake", () => {
  const { findings } = check(`<Visual title="PRs"><Each in={$pulls} as="pr"><Text>{$pr.draft ? "Draft" : ""}</Text></Each></Visual>`, {
    pulls: ok([{ ...ROWS[0], draft: true }, ROWS[1]]),
  });
  assert.deepEqual(findings, []);
});

test(".length on a list points at len()", () => {
  const { findings } = check(`<Visual title="PRs"><Text>{$pulls.length} open</Text></Visual>`, { pulls: ok(ROWS) });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /len\(\$pulls\)/u);
});

test("looping over an object names its list fields", () => {
  const { findings } = check(`<Visual title="PRs"><Each in={$pulls} as="pr"><Text>{$pr.title}</Text></Each></Visual>`, {
    pulls: ok({ total: 2, items: ROWS }),
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /got an object, not a list; its list fields are items/u);
});

test("an unknown $name is reported, but a declared state key is not", () => {
  const { findings } = check(
    `<Visual title="PRs" state={{tab: "all"}}><Text>{len($pulls)}</Text><Text>{$pull}</Text><Text>{$tab}</Text><Button action={setState("tab", "mine")}>Mine</Button></Visual>`,
    { pulls: ok(ROWS) },
  );
  assert.ok(findings.some((finding) => finding.startsWith("$pull is not a source")));
  assert.ok(!findings.some((finding) => finding.includes("$tab")));
});

test("run() calls must name a declared action with the right number of values", () => {
  const { findings } = check(
    `<Visual title="PRs"><Text>{len($pulls)}</Text><Button action={run("close", 12)}>Close</Button><Button action={run("merge")}>Merge</Button></Visual>`,
    { pulls: ok(ROWS) },
  );
  assert.ok(findings.some((finding) => /run\("close"\) names no action on this page \(actions: merge\)/u.test(finding)));
  assert.ok(findings.some((finding) => /run\("merge"\) passes 0 values, but the action takes 1/u.test(finding)));
});

test("a source the page never reads is reported", () => {
  const { findings } = check(`<Visual title="PRs"><Text>Nothing here</Text></Visual>`, { pulls: ok(ROWS) }, []);
  assert.deepEqual(findings, ['Source "pulls" is never read; bind it in markup as $pulls.']);
});

test("reads of a source that did not load are not checked, and the result says so", () => {
  const result = check(`<Visual title="PRs"><Text>{$pulls.titel}</Text></Visual>`, {
    pulls: { status: "error", at: 1, error: "gh: not logged in" },
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unchecked, ["$pulls did not load"]);
  const text = describeWorkspaceArtifactPageCheck(result);
  assert.doesNotMatch(text, /every value/u);
  assert.match(text, /Not checked: \$pulls did not load/u);
});

test("rows of an empty list are reported as unchecked rather than passing", () => {
  const result = check(`<Visual title="PRs"><Each in={$pulls} as="pr"><Text>{$pr.titel}</Text></Each></Visual>`, {
    pulls: ok([]),
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.unchecked.length, 1);
  assert.match(result.unchecked[0]!, /the list was empty/u);
});

test("a hidden If branch is not drawn, so its reads are not judged", () => {
  const { findings } = check(`<Visual title="PRs"><If test={$pulls == null}><Text>{$pulls.titel}</Text></If><Text>{len($pulls)}</Text></Visual>`, {
    pulls: ok(ROWS),
  });
  assert.deepEqual(findings, []);
});
