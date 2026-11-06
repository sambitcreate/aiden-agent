import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { compileAum } from "../../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION } from "../../../renderer/shared/aiden-ui/types.js";
import { WORKSPACE_ARTIFACT_LIMITS } from "../../../renderer/shared/workspace-artifacts.js";
import { writeFileAtomic } from "../durable-fs.js";
import { WorkspaceArtifactStore } from "./store.js";
import { createWorkspaceArtifactTool } from "./tool.js";
import {
  parseWorkspaceArtifactPageFile,
  parseWorkspaceArtifactPageFileText,
  readWorkspaceArtifactPageFile,
  WorkspaceArtifactImports,
  workspaceArtifactPageFile,
  workspaceArtifactPageFileName,
} from "./transfer.js";

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Makes a page the way Aiden does (the workspace_artifact tool), lets the
 * person change its state, exports it, and imports the file into a fresh
 * workspace's store.
 */
async function roundTrip(t: test.TestContext, args: Record<string, unknown>, savedState?: Record<string, unknown>) {
  const dir = await tempDir(t, "aiden-artifact-roundtrip-");
  const made = new WorkspaceArtifactStore({ root: () => dir, newId: () => "art1" });
  const tool = createWorkspaceArtifactTool({
    workspaceId: "ws1",
    chatId: "chat-1",
    permission: "full",
    hasFolder: true,
    store: made,
    takeApprovedDigest: () => undefined,
    onChanged: () => undefined,
  });
  await tool.execute("call-1", { operation: "create", ...args } as never, undefined);
  if (savedState) await made.saveState("ws1", "art1", 1, savedState);
  const original = (await made.get("ws1", "art1"))!.artifact;
  const text = `${JSON.stringify(workspaceArtifactPageFile(original), null, 2)}\n`;
  const imported = parseWorkspaceArtifactPageFileText(text);
  const into = new WorkspaceArtifactStore({ root: () => path.join(dir, "other"), newId: () => "art9" });
  const saved = await into.create("ws2", imported, { uniqueTitle: true });
  return { original, file: JSON.parse(text) as Record<string, unknown>, imported, saved };
}

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
  // A file's state is what its markup declared: the page starts there and resets to it.
  const stateful = parseWorkspaceArtifactPageFile(pageFile({}, { state: { tab: "all" } }));
  assert.deepEqual(stateful.visual.state, { tab: "all" });
  assert.deepEqual(stateful.initialState, { tab: "all" });
});

test("a stateful page exports the state its markup declared, not what the person saved", async (t) => {
  const markup = `<Visual title="Plan" state={{plan: "team", note: ""}}>
  <Tabs bind="plan" label="Plan" options={[{value:"solo",label:"Solo"},{value:"team",label:"Team"}]} />
  <TextInput bind="note" label="Note" />
  <Button action={setState("plan", "solo")}>Solo</Button>
</Visual>`;
  const { original, file, imported, saved } = await roundTrip(t, { title: "Plan", markup }, { plan: "solo", note: "private" });
  assert.deepEqual(original.visual.state, { plan: "solo", note: "private" });
  assert.deepEqual((file.visual as Record<string, unknown>).state, { plan: "team", note: "" });
  assert.ok(!JSON.stringify(file).includes("private"));
  assert.deepEqual(imported.visual.state, { plan: "team", note: "" });
  assert.deepEqual(saved.initialState, { plan: "team", note: "" });
  assert.deepEqual(saved.visual.tree, original.visual.tree);
  assert.equal(saved.visual.fallbackText, original.visual.fallbackText);
});

test("a wide page with inline data comes back wide with the same data", async (t) => {
  const markup = `<Visual title="Weekly users">
  <Data name="weeks">[{"week": "W1", "users": 1180}, {"week": "W2", "users": 1240}]</Data>
  <Chart kind="bar" data={$weeks} x="week" y="users" />
</Visual>`;
  const { original, file, saved } = await roundTrip(t, { title: "Weekly users", markup, layout: "wide" });
  assert.equal(original.visual.layout, "wide");
  assert.equal((file.visual as Record<string, unknown>).state, undefined);
  assert.equal(saved.visual.layout, "wide");
  assert.deepEqual(JSON.parse(saved.visual.dataJson!), JSON.parse(original.visual.dataJson!));
  assert.deepEqual(JSON.parse(saved.visual.dataJson!).weeks[1], { week: "W2", users: 1240 });
  assert.equal(saved.initialState, undefined);
});

test("a page saved before its declared state was kept apart exports no state", () => {
  const compiled = compileAum('<Visual title="Old"><Text>Hi</Text></Visual>');
  const file = workspaceArtifactPageFile({
    version: 1,
    id: "art1",
    workspaceId: "ws1",
    visual: {
      version: 1,
      kind: "ui",
      id: "art1",
      title: "Old",
      catalogVersion: AIDEN_UI_CATALOG_VERSION,
      tree: compiled.tree!,
      state: { typed: "by the person" },
      fallbackText: compiled.fallbackText,
    },
    sources: [],
    actions: [],
    refresh: { onOpen: true },
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(file.visual.state, undefined);
});

test("an imported page is held to what the compiler enforces and keeps only known keys", () => {
  const tree = (child: unknown) => ({ t: "Visual", k: "0", c: [child] });
  const button = (action: unknown) => ({ t: "Button", k: "0.0", p: { action }, c: [{ t: "#text", k: "0.0.0", s: "Go" }] });
  assert.throws(
    () => parseWorkspaceArtifactPageFile(pageFile({}, { tree: tree(button({ act: "open", url: { op: "lit", v: "javascript:alert(1)" } })) })),
    /can’t be imported: openUrl only accepts https/u,
  );
  assert.throws(
    () => parseWorkspaceArtifactPageFile(pageFile({}, { tree: tree(button({ act: "set", key: "missing", value: { op: "lit", v: 1 } })) })),
    /doesn’t declare/u,
  );
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({}, { dataJson: "{nope" })), /isn’t valid JSON/u);
  const kept = parseWorkspaceArtifactPageFile(
    pageFile({}, { tree: { ...tree(button({ act: "copy", text: { op: "lit", v: "x" }, extra: 1 })), sneaky: "<script>" } }),
  );
  assert.deepEqual(kept.visual.tree, {
    t: "Visual",
    k: "0",
    c: [{ t: "Button", k: "0.0", p: { action: { act: "copy", text: { op: "lit", v: "x" } } }, c: [{ t: "#text", k: "0.0.0", s: "Go" }] }],
  });
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
  const secrets = [{ name: "env", kind: "file", file: ".env", parse: "text" }];
  assert.throws(() => parseWorkspaceArtifactPageFile(pageFile({ sources: secrets })), /can’t be imported: Credential files/u);
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

test("the suggested file name can't be hidden or reach another folder", () => {
  assert.equal(workspaceArtifactPageFileName("Open PRs"), "Open PRs.aiden-page.json");
  assert.equal(workspaceArtifactPageFileName("../.ssh/config: a"), "ssh config a.aiden-page.json");
  assert.equal(workspaceArtifactPageFileName("..."), "Aiden page.aiden-page.json");
});

test("a title of 80 CJK characters suggests a name a file system can save", async (t) => {
  const title = "进".repeat(WORKSPACE_ARTIFACT_LIMITS.titleChars);
  const name = workspaceArtifactPageFileName(title);
  assert.ok(name.endsWith(".aiden-page.json"));
  assert.ok(name.startsWith("进"));
  assert.ok(Buffer.byteLength(name, "utf8") <= 200, `${Buffer.byteLength(name, "utf8")} bytes`);
  // The name, and a save dialog's " 2", fit and save on this file system.
  const dir = await tempDir(t, "aiden-page-name-");
  await writeFileAtomic(path.join(dir, name.replace(".aiden-page.json", " 2.aiden-page.json")), "{}");
  assert.equal((await fs.readdir(dir)).length, 1);
});

test("an imported file is read through links, never from a FIFO, and only up to the cap", { skip: process.platform === "win32" }, async (t) => {
  const dir = await tempDir(t, "aiden-page-read-");
  const real = path.join(dir, "page.aiden-page.json");
  await fs.writeFile(real, "{\"format\":\"aiden-artifact-page\"}");
  const link = path.join(dir, "link.json");
  await fs.symlink(real, link);
  assert.equal(new TextDecoder().decode(await readWorkspaceArtifactPageFile(link, 1024)), "{\"format\":\"aiden-artifact-page\"}");

  await assert.rejects(readWorkspaceArtifactPageFile(real, 8), (error: NodeJS.ErrnoException) => error.code === "EFBIG");

  const fifo = path.join(dir, "pipe.json");
  execFileSync("mkfifo", [fifo]);
  // Nothing ever writes to it: a blocking open would hang here.
  await assert.rejects(readWorkspaceArtifactPageFile(fifo, 1024), (error: NodeJS.ErrnoException) => error.code === "EFTYPE");
  await assert.rejects(readWorkspaceArtifactPageFile(dir, 1024));
});

test("only a few previews wait at once; the oldest goes first", () => {
  let next = 0;
  const imports = new WorkspaceArtifactImports({ newToken: () => `token-${String(++next).padStart(12, "0")}` });
  const content = parseWorkspaceArtifactPageFile(pageFile());
  const tokens = Array.from({ length: 9 }, () => imports.hold("ws1", "window-1", content));
  assert.throws(() => imports.take("ws1", "window-1", tokens[0]!), /no longer available/u);
  assert.equal(imports.take("ws1", "window-1", tokens[8]!).title, "Open PRs");
});
