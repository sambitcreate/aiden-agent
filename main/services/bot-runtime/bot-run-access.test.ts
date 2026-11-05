import assert from "node:assert/strict";
import { test } from "node:test";
import {
  botRunEnded,
  createBotRunAccess,
  BOT_RUN_ACCESS_MAX_AGE_MS,
  type BotRunAccessGrant,
} from "./bot-run-access.js";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BotAccessRequestStaleError } from "./bot-access-requests.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createBotRegistry } from "./bot-extension.js";
import { botFileCandidates } from "./bot-file-candidates.js";
import { countingTool, recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor } from "./test-support/faux.js";

const grant: BotRunAccessGrant = {
  requestIds: ["r1"],
  target: "folder",
  key: "/Taxes",
  root: "/Taxes",
  label: "Taxes",
  identity: { device: "1", inode: "2" },
  policyRevision: "rev1",
  access: "write",
  owner: { kind: "access", id: "wait1" },
  expiresAt: 9_000_000,
  grantedAt: 1,
};
test("a grant serves only its own run, matching policy, identity and lifetime", () => {
  let now = 1;
  const store = createBotRunAccess({ now: () => now });
  store.grant("ada", grant);
  assert.equal(store.location("ada", ["r1"], "rev1")?.root, "/Taxes");
  assert.equal(store.location("ada", ["r1", "r2"], "rev1")?.access, "write");
  assert.deepEqual(store.location("ada", ["r1"], "rev1")?.expectedIdentity, {
    device: "1",
    inode: "2",
  });
  assert.equal(store.location("ada", ["r3"], "rev1"), undefined);
  now = BOT_RUN_ACCESS_MAX_AGE_MS + 1;
  assert.equal(store.location("ada", ["r1"], "rev1"), undefined);
  now = 1;
  store.grant("ada", { ...grant, expiresAt: 10 });
  now = 10;
  assert.equal(store.location("ada", ["r1"], "rev1"), undefined);
  now = 1;
  store.grant("ada", grant);
  assert.equal(store.location("ada", ["r1"], "rev2"), undefined);
  assert.equal(
    store.location("ada", ["r1"], "rev1"),
    undefined,
    "policy change revokes rather than suspends",
  );
});

test("a run grant cannot omit a folder pin or claim a different target", () => {
  const store = createBotRunAccess({ now: () => 1 });
  for (const bad of [
    { identity: undefined },
    { key: "/Different" },
    { root: "relative" },
    { target: "whole_mac" as const },
    { requestIds: [""] },
  ]) {
    assert.throws(() => store.grant("ada", { ...grant, ...bad }), /exact target/u);
  }
  assert.equal(store.location("ada", ["r1"], "rev1"), undefined);
});
test("owners, cloned snapshots, replacement and clearBot cannot revive authority", () => {
  const store = createBotRunAccess({ now: () => 1 });
  const mutable = { ...grant, requestIds: ["r1"], identity: { device: "1", inode: "2" } };
  store.grant("ada", mutable);
  mutable.requestIds.push("r3");
  mutable.identity.inode = "99";
  assert.equal(store.location("ada", ["r3"], "rev1"), undefined);
  assert.equal(store.location("ada", ["r1"], "rev1")?.expectedIdentity?.inode, "2");
  store.grant("ada", { ...grant, owner: { kind: "plan", id: "plan1" }, access: "read" });
  store.grant("ada", { ...grant, owner: { kind: "access", id: "wait2" } });
  store.revokeOwner("ada", { kind: "plan", id: "plan1" });
  assert.equal(store.location("ada", ["r1"], "rev1")?.access, "write");
  store.decline("ada", ["r1"], "/Other");
  assert.equal(store.declined("ada", ["r1", "r2"], "/Other"), true);
  assert.equal(store.declined("ada", ["r3"], "/Other"), false);
  store.clearBot("ada");
  assert.equal(store.location("ada", ["r1"], "rev1"), undefined);
  assert.equal(store.declined("ada", ["r1"], "/Other"), false);
});
test("only terminal states end the run", () => {
  assert.equal(botRunEnded({ kind: "idle" }), true);
  assert.equal(botRunEnded({ kind: "running", submissionId: "s1" }), false);
  assert.equal(botRunEnded({ kind: "interrupted", submissionId: "s1" }), false);
  assert.equal(botRunEnded({ kind: "paused", since: 1, by: "mac", interrupted: "s1" }), false);
  assert.equal(botRunEnded({ kind: "paused", since: 1, by: "mac" }), true);
});

test("real harness shares access with a joined steer but excludes queued and later runs and restart", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bot-run-access-")));
  const store = createBotRunAccess({ now: () => 1 });
  let entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed: { ids: readonly (string | undefined)[]; allowed: boolean }[] = [];
  const hold = countingTool("hold", async () => {
    entered = true;
    await gate;
    return "done";
  });
  const files = botFileCandidates([{ id: "home", label: "Bot folder", root: temp }], {
    routine: false,
    recordOwnWrite() {},
    runAccess: {
      resolve: async (call) => {
        const ids = await call.runRequestIds!();
        const location = store.location("ada", ids, "rev1");
        observed.push({ ids, allowed: Boolean(location) });
        return location;
      },
    },
  });
  await fs.writeFile(path.join(temp, "note.txt"), "readable");
  const readStep = () =>
    fauxAssistantMessage(
      [fauxToolCall("read_file", { path: "note.txt", location: "run.access" })],
      { stopReason: "toolUse" },
    );
  const faux = createFauxModels([
    fauxAssistantMessage([fauxToolCall("hold", { text: "wait" })], { stopReason: "toolUse" }),
    readStep(),
    fauxAssistantMessage("first done"),
    readStep(),
    fauxAssistantMessage("queue done"),
    readStep(),
    fauxAssistantMessage("later done"),
  ]);
  const deps = recordingDeps({
    tools: [
      { tool: hold, replay: "safe" },
      ...files.map((entry) => ({ ...entry, replay: "safe" as const })),
    ],
  });
  const registry = createBotRegistry("ada", deps);
  await registry.refresh();
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models: faux.models, registry }, ctx);
  registry.attachHarness(harness);
  try {
    const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
    const first = await root.submit({ type: "input", content: "start", requestId: "r1" }, ctx);
    await waitFor(() => entered);
    const stat = await fs.stat(temp, { bigint: true });
    store.grant("ada", {
      ...grant,
      root: temp,
      key: temp,
      identity: { device: String(stat.dev), inode: String(stat.ino) },
    });
    const steer = await root.submit(
      { type: "input", content: "join", requestId: "steer", whenBusy: "steer" },
      ctx,
    );
    const queued = await root.submit(
      { type: "input", content: "next", requestId: "queued", whenBusy: "followUp" },
      ctx,
    );
    release();
    await Promise.all([first.wait(ctx), steer.wait(ctx), queued.wait(ctx)]);
    await (
      await root.submit({ type: "input", content: "later", requestId: "later" }, ctx)
    ).wait(ctx);
    assert.equal(observed.length, 3);
    assert.ok(observed[0]!.ids.includes("r1") && observed[0]!.ids.includes("steer"));
    assert.equal(observed[0]!.ids.includes("queued"), false);
    assert.equal(observed[0]!.allowed, true);
    assert.equal(observed[1]!.allowed, false);
    assert.deepEqual(observed[1]!.ids, ["queued"]);
    assert.deepEqual(observed[2], { ids: ["later"], allowed: false });
  } finally {
    release();
    store.clearAll();
    await harness.close(ctx);
    await fs.rm(temp, { recursive: true, force: true });
  }
  assert.equal(
    store.location("ada", ["r1"], "rev1"),
    undefined,
    "shutdown also revokes an interrupted run",
  );
  assert.equal(
    createBotRunAccess({ now: () => 1 }).location("ada", ["r1"], "rev1"),
    undefined,
    "a restarted store cannot restore authority from input ids",
  );
});

test("read grants block real direct and nested codemode mutations while reads and write grants work", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bot-run-read-")));
  try {
    for (const access of ["read", "write"] as const)
      for (const nested of [false, true])
        for (const operation of ["read_file", "write_file", "edit_file"]) {
          await fs.writeFile(path.join(temp, "note.txt"), "original");
          const store = createBotRunAccess({ now: () => 1 });
          const stat = await fs.stat(temp, { bigint: true });
          store.grant("ada", {
            ...grant,
            root: temp,
            key: temp,
            access,
            identity: { device: String(stat.dev), inode: String(stat.ino) },
          });
          const params = {
            path: "note.txt",
            location: "run.access",
            ...(operation === "write_file"
              ? { content: "changed" }
              : operation === "edit_file"
                ? { old_string: "original", new_string: "changed" }
                : {}),
          };
          const tools = botFileCandidates([{ id: "home", label: "Bot folder", root: temp }], {
            routine: false,
            recordOwnWrite() {},
            runAccess: {
              resolve: async (call) => store.location("ada", await call.runRequestIds!(), "rev1"),
            },
          });
          const faux = createFauxModels([
            fauxAssistantMessage(
              [
                fauxToolCall(
                  nested ? "codemode" : operation,
                  nested
                    ? { code: `return await tools.${operation}(${JSON.stringify(params)});` }
                    : params,
                ),
              ],
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("done"),
          ]);
          const registry = createBotRegistry(
            "ada",
            recordingDeps({ tools: tools.map((entry) => ({ ...entry, replay: "safe" as const })) }),
          );
          await registry.refresh();
          const harness = await Harness.open(
            new MemoryStorage(),
            { models: faux.models, registry },
            ctx,
          );
          registry.attachHarness(harness);
          try {
            const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
            await (
              await root.submit({ type: "input", content: "do it", requestId: "r1" }, ctx)
            ).wait(ctx);
            const results = (await root.context(ctx)).entries.filter(
              (entry) => entry.kind === ToolResultEntry.kind,
            );
            const serialized = JSON.stringify(results.map((entry) => entry.model));
            if (access === "read" && operation !== "read_file")
              assert.match(serialized, /reading this folder only/u);
            if (operation === "read_file") assert.match(serialized, /original/u);
            assert.equal(
              await fs.readFile(path.join(temp, "note.txt"), "utf8"),
              access === "write" && operation !== "read_file" ? "changed" : "original",
              `${access} ${nested ? "nested" : "direct"} ${operation}`,
            );
          } finally {
            await harness.close(ctx);
          }
        }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("saved publication slot survives Once replacement and revokes only its real owner",async()=>{
  const store=createBotRunAccess({now:()=>1}),signal=new AbortController().signal;
  const current={signal,validate:async()=>{}};
  const published={...grant,policyRevision:"published",expiresAt:100};
  store.recordPublication("ada",published,{signal,deadline:100});
  store.grant("ada",{...published,key:"/Other",root:"/Other",owner:{kind:"plan",id:"plan"},access:"read"});
  assert.equal(store.location("ada",["r1"],"published")?.root,"/Other");
  assert.equal((await store.savedLocation("ada",["r1"],"published",current))?.root,"/Taxes");
  store.revokeOwner("ada",{kind:"plan",id:"plan"});
  assert.equal(store.location("ada",["r1"],"published"),undefined,"the plan really existed and is removed");
  assert.equal((await store.savedLocation("ada",["r1"],"published",current))?.root,"/Taxes","independent access publication remains");
  store.grant("ada",{...published,key:"/Once",root:"/Once",owner:{kind:"access",id:"once"}});
  store.revokeOwner("ada",published.owner);
  assert.equal(await store.savedLocation("ada",["r1"],"published",current),undefined);
  assert.equal(store.location("ada",["r1"],"published")?.root,"/Once","removing saved owner preserves a different Once owner");
});

test("a transient current-call validation failure preserves the live saved publication for retry", async () => {
  const store = createBotRunAccess({ now: () => 1 });
  const owner = new AbortController();
  store.recordPublication("ada", { ...grant, expiresAt: 100 }, { signal: owner.signal, deadline: 100 });
  const unavailable = Object.assign(new Error("policy store temporarily unreadable"), { code: "EIO" });
  await assert.rejects(store.savedLocation("ada", ["r1"], "rev1", {
    signal: new AbortController().signal, validate: async () => { throw unavailable; },
  }), error => error === unavailable);
  assert.equal((await store.savedLocation("ada", ["r1"], "rev1", {
    signal: new AbortController().signal, validate: async () => {},
  }))?.root, "/Taxes", "the next healthy call keeps the original exact publication");
  owner.abort();
  assert.equal(await store.savedLocation("ada", ["r1"], "rev1", {
    signal: new AbortController().signal, validate: async () => {},
  }), undefined, "preserving a transient failure cannot preserve ended ownership");
});

test("only a genuine stale validation permanently revokes a saved publication", async () => {
  for (const classified of [true, false]) {
    const store = createBotRunAccess({ now: () => 1 });
    store.recordPublication("ada", { ...grant, expiresAt: 100 }, { signal: new AbortController().signal, deadline: 100 });
    const error = classified ? new BotAccessRequestStaleError("owning input changed")
      : Object.assign(new Error("temporary validation failure"), { name: "BotAccessRequestStaleError" });
    const first = store.savedLocation("ada", ["r1"], "rev1", {
      signal: new AbortController().signal, validate: async () => { throw error; },
    });
    if (classified) assert.equal(await first, undefined);
    else await assert.rejects(first, value => value === error);
    const retry = await store.savedLocation("ada", ["r1"], "rev1", {
      signal: new AbortController().signal, validate: async () => {},
    });
    assert.equal(retry?.root, classified ? undefined : "/Taxes");
  }
});

test("saved slot rejects stale policy, changed owner, postawait abort, expiration, restart and lifecycle clear",async()=>{
  for(const reason of ["policy","owner","abort","original_abort","expiry","clearBot","clearAll","restart"] as const){
    let now=1;const store=createBotRunAccess({now:()=>now}),original=new AbortController(),current=new AbortController();
    const published={...grant,expiresAt:100};
    store.grant("ada",published);store.recordPublication("ada",published,{signal:original.signal,deadline:10});
    assert.equal((await store.savedLocation("ada",["r1"],"rev1",{signal:current.signal,validate:async()=>{}}))?.id,"run.saved");
    assert.equal(await store.savedLocation("ada",["queued"],"rev1",{signal:current.signal,validate:async()=>{throw new Error("must not query old owner for another run");}}),undefined);
    if(reason==="expiry") now=10;
    if(reason==="original_abort") original.abort();
    if(reason==="clearBot") store.clearBot("ada");
    if(reason==="clearAll") store.clearAll();
    const actual=reason==="restart"?createBotRunAccess({now:()=>now}):store;
    const resolved=await actual.savedLocation("ada",["r1"],reason==="policy"?"rev2":"rev1",{signal:current.signal,validate:async()=>{
      if(reason==="owner") { original.abort(); throw new Error("owning task ended"); }
      if(reason==="abort") current.abort();
    }});
    assert.equal(resolved,undefined,reason);
    assert.equal(await actual.savedLocation("ada",["r1"],"rev1",{signal:new AbortController().signal,validate:async()=>{}}),undefined,`${reason} cannot revive an old slot`);
    if(reason==="clearBot"||reason==="clearAll") assert.equal(store.location("ada",["r1"],"rev1"),undefined,"the lifecycle fanout clears both slots");
  }
});


test("plan-owned unattended grants still require their own Bot, joined input, current policy and deadline", () => {
  let now = 1;
  const store = createBotRunAccess({ now: () => now });
  const plan: BotRunAccessGrant = { ...grant, requestIds: ["bot:approved:1"], owner: { kind: "plan", id: "plan1" }, expiresAt: 10 };
  store.grant("ada", plan);
  assert.equal(store.location("ada", ["bot:approved:1", "routine:joined:1"], "rev1")?.root, "/Taxes");
  assert.equal(store.location("other", ["bot:approved:1"], "rev1"), undefined);
  assert.equal(store.location("ada", ["bot:other:1"], "rev1"), undefined);
  now = 10;
  assert.equal(store.location("ada", ["bot:approved:1"], "rev1"), undefined);
  now = 1;
  store.grant("ada", plan);
  assert.equal(store.location("ada", ["bot:approved:1"], "rev2"), undefined);
  assert.equal(store.location("ada", ["bot:approved:1"], "rev1"), undefined);
});
