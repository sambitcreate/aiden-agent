import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { DesignProjectStore, type DesignChatPort } from "./store.js";

const MODEL = { providerId: "openrouter", model: "model-a" };
const html = (label: string) =>
  `<main data-aiden-id="root"><h1>${label}</h1>${"<p>Lorem ipsum dolor sit amet.</p>".repeat(900)}</main>`;

test("opening and saving a 200-revision project stays under 200 ms of store time", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-perf-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chats: DesignChatPort = { exists: async () => true, create: async () => {}, remove: async () => {} };
  let counter = 0;
  const newId = () => `id-${(counter += 1)}`;
  const seed = new DesignProjectStore({ root: async () => root, chats, newId });
  await seed.initialize();
  const project = await seed.create({ title: "Large" });
  await seed.beginRun(project.id, {
    runId: "explore",
    turnId: "turn-explore",
    request: { op: "explore", count: 4, creativeRange: "balanced", aspects: [] },
  });
  for (const title of ["A", "B", "C", "D"]) {
    await seed.acceptRunArtifact(project.id, "explore", { toolCallId: `call-${title}`, title, html: html(title), model: MODEL });
  }
  await seed.finishRun(project.id, "explore", "completed");
  const screenIds = Object.keys(seed.get(project.id)!.screens);
  for (let index = 0; index < 196; index += 1) {
    const screen = seed.get(project.id)!.screens[screenIds[index % screenIds.length]!]!;
    const runId = `refine-${index}`;
    await seed.beginRun(project.id, {
      runId,
      turnId: `turn-${index}`,
      request: { op: "refine", screenId: screen.id, baseRevisionId: screen.activeRevisionId },
    });
    await seed.acceptRunArtifact(project.id, runId, {
      toolCallId: `call-${index}`, title: screen.title, html: html(`${screen.title} ${index}`), model: MODEL,
    });
    await seed.finishRun(project.id, runId, "completed");
  }
  assert.equal(Object.keys(seed.get(project.id)!.revisions).length, 200);

  const started = performance.now();
  const reopened = new DesignProjectStore({ root: async () => root, chats, newId });
  await reopened.initialize();
  const snapshot = reopened.get(project.id)!;
  const saved = await reopened.mutate(project.id, snapshot.revision, { op: "rename", title: "Large, renamed" });
  const elapsed = performance.now() - started;
  t.diagnostic(`store time ${elapsed.toFixed(1)} ms for open + save of 200 revisions`);
  assert.equal(saved.ok, true);
  assert.ok(elapsed < 200, `store time was ${elapsed.toFixed(1)} ms`);
});
