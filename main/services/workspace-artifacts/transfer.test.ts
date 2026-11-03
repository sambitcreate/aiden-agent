import assert from "node:assert/strict";
import test from "node:test";
import { compileAum } from "../../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION } from "../../../renderer/shared/aiden-ui/types.js";
import { WORKSPACE_ARTIFACT_LIMITS } from "../../../renderer/shared/workspace-artifacts.js";
import { freeWorkspaceArtifactTitle } from "./store.js";
import {
  parseWorkspaceArtifactPageFile,
  parseWorkspaceArtifactPageFileText,
  WorkspaceArtifactImports,
  workspaceArtifactPageFileName,
} from "./transfer.js";

/** A page file as Export page writes it, with `overrides` laid over it. */
function pageFile(overrides: Record<string, unknown> = {}, visual: Record<string, unknown> = {}) {
  const compiled = compileAum(
    '<Visual title="Open PRs"><Each in={$pulls} as="pr"><Button action={run("merge", $pr.number)}>Merge</Button></Each></Visual>',
    { artifactActions: true },
  );
  return {
    format: "aiden-artifact-page",
    version: 1,
    title: "Open PRs",
    visual: { catalogVersion: AIDEN_UI_CATALOG_VERSION, tree: compiled.tree, fallbackText: compiled.fallbackText, ...visual },
    sources: [{ name: "pulls", kind: "shell", command: "gh pr list --json number", parse: "json" }],
    actions: [{ name: "merge", label: "Merge pull request", command: "gh pr merge {{number}} --squash", params: [{ name: "number", type: "number" }] }],
    refresh: { onOpen: true },
    ...overrides,
  };
}

test("a page file reads back as the page it describes", () => {
  const content = parseWorkspaceArtifactPageFile(pageFile({ description: "Pull requests waiting on review" }));
  assert.equal(content.title, "Open PRs");
  assert.equal(content.description, "Pull requests waiting on review");
  assert.equal(content.visual.tree.t, "Visual");
  assert.deepEqual(content.actions.map((action) => action.name), ["merge"]);
  assert.deepEqual(content.refresh, { onOpen: true });
  // A file may give the page a starting state; it is checked like any other.
  assert.deepEqual(parseWorkspaceArtifactPageFile(pageFile({}, { state: { tab: "all" } })).visual.state, { tab: "all" });
});

test("a file of another format, version or kind is refused with the reason", () => {
  assert.throws(() => parseWorkspaceArtifactPageFileText("not json"), /isn’t an Aiden page/u);
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ format: "aiden-chat" })), /isn’t an Aiden page/u);
  assert.throws(() => parseWorkspaceArtifactPageFile([pageFile()]), /isn’t an Aiden page/u);
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ version: 2 })), /newer Aiden/u);
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ version: "1" })), /version isn’t one Aiden can read/u);
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({}, { catalogVersion: AIDEN_UI_CATALOG_VERSION + 1 })), /components this Aiden doesn’t have/u);
});

test("commands are held to the same rules as a page Aiden saves", () => {
  // A value that would choose the program itself.
  const asCommand = [{ name: "go", label: "Go", command: "{{tool}} --version", params: [{ name: "tool" }] }];
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ actions: asCommand })), /can’t be imported: actions\[0\].*the command itself/u);
  const quoted = [{ name: "say", label: "Say", command: "echo \"{{text}}\"", params: [{ name: "text" }] }];
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ actions: quoted })), /inside double quotes/u);
  const hiddenLabel = [{ name: "merge", label: "Merge‮gnp.exe", command: "gh pr merge", params: [] }];
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ actions: hiddenLabel })), /label/u);
  const outside = [{ name: "keys", kind: "file", file: "../.ssh/id_ed25519", parse: "text" }];
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ sources: outside })), /may not leave the workspace folder/u);
});

test("more sources or actions than a page may have are refused", () => {
  const sources = Array.from({ length: WORKSPACE_ARTIFACT_LIMITS.sources + 1 }, (_, index) => ({
    name: `s${index}`,
    kind: "shell",
    command: "date",
    parse: "text",
  }));
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ sources })), /at most 8 sources/u);
  const actions = Array.from({ length: WORKSPACE_ARTIFACT_LIMITS.actions + 1 }, (_, index) => ({
    name: `a${index}`,
    label: "Go",
    command: "date",
    params: [],
  }));
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ actions })), /at most 16 actions/u);
});

test("the page may use only Aiden's components and their own settings", () => {
  const tree = (extra: unknown) => ({ ...(pageFile().visual.tree as object), c: [extra] });
  assert.throws(
    () => parseWorkspaceArtifactPageFile(pageFile({}, { tree: tree({ t: "Script", k: "0.0" }) })),
    /uses <Script>, which isn’t one of Aiden’s components/u,
  );
  assert.throws(
    () => parseWorkspaceArtifactPageFile(pageFile({}, { tree: tree({ t: "Visual", k: "0.0" }) })),
    /uses <Visual>, which isn’t one of Aiden’s components/u,
  );
  assert.throws(
    () => parseWorkspaceArtifactPageFile(pageFile({}, { tree: tree({ t: "Text", k: "0.0", p: { onClick: { op: "lit", v: "x" } } }) })),
    /<Text> has a setting Aiden doesn’t know/u,
  );
  assert.throws(
    () => parseWorkspaceArtifactPageFile(pageFile({}, { tree: { t: "Stack", k: "0" } })),
    /must start with <Visual>/u,
  );
  // A name that doesn't read as one is never echoed.
  assert.throws(
    () => parseWorkspaceArtifactPageFile(pageFile({}, { tree: tree({ t: "<img src=x>", k: "0.0" }) })),
    (error: Error) => /uses a component/u.test(error.message) && !error.message.includes("<img"),
  );
});

test("a title that breaks the title rules, or hides characters, is refused", () => {
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ title: "" })), /title must be/u);
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ title: "x".repeat(81) })), /title must be/u);
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ title: "Open\nPRs" })), /title must be/u);
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ title: "Open PRs‮" })), /title must be/u);
  assert.equal(parseWorkspaceArtifactPageFile(pageFile({ title: "  Open PRs  " })).title, "Open PRs");
});

test("a colliding title takes the first free number, staying within the title limit", () => {
  assert.equal(freeWorkspaceArtifactTitle("PRs", new Set(["Other"])), "PRs");
  assert.equal(freeWorkspaceArtifactTitle("PRs", new Set(["PRs", "PRs (2)"])), "PRs (3)");
  const long = "x".repeat(WORKSPACE_ARTIFACT_LIMITS.titleChars);
  const free = freeWorkspaceArtifactTitle(long, new Set([long]));
  assert.equal(free.length, WORKSPACE_ARTIFACT_LIMITS.titleChars);
  assert.ok(free.endsWith(" (2)"));
});

test("the suggested file name can't be hidden or reach another folder", () => {
  assert.equal(workspaceArtifactPageFileName("Open PRs"), "Open PRs.aiden-page.json");
  assert.equal(workspaceArtifactPageFileName("../.ssh/config: a"), "ssh config a.aiden-page.json");
  assert.equal(workspaceArtifactPageFileName("..."), "Aiden page.aiden-page.json");
});

test("only a few previews wait at once; the oldest goes first", () => {
  let next = 0;
  const imports = new WorkspaceArtifactImports({ newToken: () => `token-${String(++next).padStart(12, "0")}` });
  const content = parseWorkspaceArtifactPageFile(pageFile());
  const tokens = Array.from({ length: 9 }, () => imports.hold("ws1", "window-1", content));
  assert.throws(() => imports.take("ws1", "window-1", tokens[0]!), /no longer available/u);
  assert.equal(imports.take("ws1", "window-1", tokens[8]!).title, "Open PRs");
});
