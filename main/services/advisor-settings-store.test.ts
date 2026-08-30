import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AdvisorSettingsStore } from "./advisor-settings-store.js";

const selection = {
  providerId: "provider",
  modelId: "reviewer",
  effort: "high" as const,
  disabledForExecutors: [
    { providerId: "executor", modelId: "strong", minEffort: "high" as const },
  ],
  disclosureVersion: 1 as const,
};

test("advisor settings persist the strict selection across restart", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-advisor-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new AdvisorSettingsStore({ root: () => directory });
  await first.initialize();
  let authorityChecks = 0;
  await first.replaceSelection(selection, () => {
    authorityChecks += 1;
  });
  assert.equal(authorityChecks, 2);
  await first.setSelection(null);

  const restarted = new AdvisorSettingsStore({ root: () => directory });
  await restarted.initialize();
  assert.deepEqual(await restarted.get(), {
    version: 1,
    selection: null,
    disabledForExecutors: selection.disabledForExecutors,
  });
});

test("future advisor settings fail closed without overwriting the source", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-advisor-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "advisor-settings.json");
  const future = JSON.stringify({ version: 2, selection: null, future: true });
  await writeFile(filename, future, { mode: 0o600 });

  const store = new AdvisorSettingsStore({ root: () => directory });
  await assert.rejects(store.initialize(), /unsupported schema/u);
  assert.equal(await readFile(filename, "utf8"), future);
});
