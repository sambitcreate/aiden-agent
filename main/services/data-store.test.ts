import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DataStore, type DataStorePublicationReceipt } from "./data-store.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("serializes full config mutations so a delayed write cannot resurrect stale settings", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-data-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DataStore(
    "config.json",
    { settings: { computerUseEnabled: true, appearance: "system" }, providers: ["first"] },
    () => directory,
  );
  await store.save(await store.load());

  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const disable = store.update(async (draft) => {
    draft.settings.computerUseEnabled = false;
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const unrelated = store.update((draft) => {
    draft.settings.appearance = "dark";
    draft.providers.push("second");
  });
  releaseFirst.resolve();
  await Promise.all([disable, unrelated]);

  assert.deepEqual(await store.load(), {
    settings: { computerUseEnabled: false, appearance: "dark" },
    providers: ["first", "second"],
  });
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf-8")),
    await store.load(),
  );
});

for (const protectedPublication of [false, true]) {
  for (const stage of ["before", "after", "success"] as const) {
    test(`DataStore receipt identifies ${stage} publication for ${protectedPublication ? "protected" : "ordinary"} updates`, async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-data-store-receipt-"));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      let fail = false;
      const error = new Error(`${stage} publication failure`);
      const store = new DataStore("receipt.json", { value: "previous" }, () => directory, {
        rejectExternalChanges: protectedPublication,
        beforeWritePublish: () => { if (fail && stage === "before") throw error; },
        afterWritePublish: () => { if (fail && stage === "after") throw error; },
      });
      await store.update(() => undefined);
      const receipt: DataStorePublicationReceipt = { state: "uncertain" };
      fail = true;
      const update = store.update((draft) => { draft.value = "next"; }, undefined, receipt);
      if (stage === "success") await update;
      else await assert.rejects(update, (caught) => caught === error);
      assert.equal(receipt.state, stage === "before" ? "not-published" : "published");
      assert.equal(JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8")).value,
        stage === "before" ? "previous" : "next");
    });
  }
}
