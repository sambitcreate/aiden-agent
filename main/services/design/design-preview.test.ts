import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { wrapDesignRevision } from "./design-preview.js";
import { DesignProjectStore } from "./store.js";

const SRC = `aiden-genui://preview/${"a".repeat(64)}`;

async function publishedRevision(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-preview-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let counter = 0;
  const store = new DesignProjectStore({
    root: async () => root,
    chats: { exists: async () => true, create: async () => {}, remove: async () => {}, ownedChatIds: async () => [] },
    newId: () => `id-${(counter += 1)}`,
  });
  await store.initialize();
  const project = await store.create();
  await store.beginRun(project.id, {
    runId: "run-1",
    turnId: "turn-1",
    request: { op: "explore", count: 2, creativeRange: "balanced", aspects: [] },
  });
  const { revisionId } = await store.acceptRunArtifact(project.id, "run-1", {
    toolCallId: "call-1", title: "Pricing", html: "<main><h1>Pricing</h1></main>", model: { providerId: "openrouter", model: "model-a" },
  });
  await store.finishRun(project.id, "run-1", "completed");
  return { root, store, projectId: project.id, revisionId };
}

test("a revision is wrapped with the theme and registered as one preview document", async (t) => {
  const { store, projectId, revisionId } = await publishedRevision(t);
  const bodies: string[] = [];
  const preview = await wrapDesignRevision(
    { store, register: (body) => { bodies.push(body); return SRC; } },
    {
      projectId,
      revisionId,
      theme: { colorScheme: "dark", canvas: "#101010", foreground: "#fafafa", secondary: "#a0a0a0", accent: "#3399ff" },
    },
  );
  assert.deepEqual(preview, { src: SRC, title: "Pricing" });
  assert.equal(bodies.length, 1);
  assert.match(bodies[0]!, /data-color-scheme="dark"/u);
  assert.match(bodies[0]!, /<h1>Pricing<\/h1>/u);
});

test("a damaged revision is never registered", async (t) => {
  const { root, store, projectId, revisionId } = await publishedRevision(t);
  await fs.writeFile(path.join(root, projectId, "revisions", `${revisionId}.html`), "<main><h1>Tampered</h1></main>");
  const bodies: string[] = [];
  await assert.rejects(
    wrapDesignRevision({ store, register: (body) => { bodies.push(body); return SRC; } }, { projectId, revisionId }),
    /missing or damaged/u,
  );
  assert.equal(bodies.length, 0);
  assert.equal(store.get(projectId)!.revisions[revisionId]!.state, "missing");
});

test("an unknown or malformed revision is not found and never registered", async (t) => {
  const { store, projectId } = await publishedRevision(t);
  const bodies: string[] = [];
  const deps = { store, register: (body: string) => { bodies.push(body); return SRC; } };
  for (const input of [
    { projectId, revisionId: "id-missing" },
    { projectId: "../escape", revisionId: "id-2" },
    { projectId, revisionId: "../../manifest" },
  ]) {
    await assert.rejects(wrapDesignRevision(deps, input), { code: "not_found" });
  }
  assert.equal(bodies.length, 0);
});
