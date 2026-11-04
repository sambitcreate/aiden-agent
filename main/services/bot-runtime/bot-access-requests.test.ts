import assert from "node:assert/strict";
import { test } from "node:test";
import { BotAccessRequestStaleError, createBotAccessRequests, type BotAccessRequestPrompt } from "./bot-access-requests.js";
import { createBotAccessAuthorizer, createBotAccessRevalidator } from "./bot-access-authorization.js";
import { createBotRunAccess } from "./bot-run-access.js";
import { createBotFolderGrantJournal, BotFolderGrantJournalReadError, BotFolderGrantJournalRepairError, type BotFolderGrantRecord } from "../bot-folder-grant-journal.js";
import { BotRuntimeAuthorityError } from "../bot-runtime-authority.js";

const prompt: Omit<BotAccessRequestPrompt, "waitId"> = {
  botId: "ada",
  toolCallId: "call",
  logicalRequestId: "logical-1",
  target: "folder",
  label: "Taxes",
  place: "~/Taxes",
  why: "Prepare a return",
  choices: ["not_now", "always", "once"],
  grant: { folderPath: "/Taxes" },
  authorization: {
    policyRevision: "rev1",
    requestIds: ["r1"],
    target: "folder",
    root: "/Taxes",
    identity: { device: "1", inode: "2" },
    choices: ["not_now", "always", "once"],
  },
};
test("first answer claims the attempt, immutable authorization runs before settlement and public cards hide it", async () => {
  const bridge = createBotAccessRequests();
  bridge.onChange(() => {
    throw new Error("listener failure");
  });
  const waiting = bridge.request({ ...prompt, signal: undefined });
  const card = bridge.pending("ada")[0]!;
  assert.deepEqual(
    Object.keys(card).sort(),
    ["botId", "choices", "label", "place", "target", "toolCallId", "waitId", "why"].sort(),
  );
  let release!: () => void,
    started = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = bridge.answer("ada", card.waitId, "always", async (captured) => {
    started = true;
    assert.equal(captured.authorization.policyRevision, "rev1");
    await gate;
  });
  assert.equal(started, true);
  assert.equal(
    await bridge.answer("ada", card.waitId, "once", async () => {
      throw new Error("must not authorize twice");
    }),
    "not_waiting",
  );
  release();
  assert.equal(await answer, "answered");
  assert.deepEqual(await waiting, { choice: "always", waitId: card.waitId });
  assert.equal(await bridge.answer("ada", card.waitId, "always", async () => {}), "saved_for_future");
});
test("unoffered answers and failing authorization keep the card available", async () => {
  const bridge = createBotAccessRequests();
  const waiting = bridge.request({
    ...prompt,
    choices: ["not_now", "once"],
    authorization: { ...prompt.authorization, choices: ["not_now", "once"] },
    grant: undefined,
    signal: undefined,
  });
  const id = bridge.pending()[0]!.waitId;
  assert.equal(
    await bridge.answer("ada", id, "always", async () => {
      throw new Error("must not run");
    }),
    "invalid",
  );
  await assert.rejects(
    bridge.answer("ada", id, "once", async () => {
      throw new Error("policy stale");
    }),
    /policy stale/u,
  );
  assert.equal(bridge.pending()[0]!.waitId, id);
  assert.equal(await bridge.answer("ada", id, "not_now", async () => {}), "answered");
  await waiting;
});
test("live retries reuse an attempt, abort preserves its reason, and reapproval always has a fresh id", async () => {
  const bridge = createBotAccessRequests();
  const controller = new AbortController();
  const first = bridge.request({ ...prompt, signal: controller.signal });
  const retry = bridge.request({ ...prompt, signal: controller.signal });
  const oldId = bridge.pending()[0]!.waitId;
  assert.equal(bridge.pending().length, 1);
  const error = new Error("quit");
  controller.abort(error);
  await assert.rejects(first, (reason) => reason === error);
  await assert.rejects(retry, (reason) => reason === error);
  const restarted = bridge.request({ ...prompt, signal: undefined });
  const newId = bridge.pending()[0]!.waitId;
  assert.notEqual(oldId, newId);
  assert.equal(await bridge.answer("ada", oldId, "once", async () => {}), "not_waiting");
  await bridge.answer("ada", newId, "once", async () => {});
  await restarted;
  const again = bridge.request({ ...prompt, signal: undefined });
  assert.notEqual(bridge.pending()[0]!.waitId, newId);
  await bridge.answer("ada", bridge.pending()[0]!.waitId, "not_now", async () => {});
  await again;
});
test("changed authorization withdraws an old attempt and caller mutation cannot alter its captured snapshot", async () => {
  const bridge = createBotAccessRequests();
  const mutable = structuredClone(prompt);
  const old = bridge.request({ ...mutable, signal: undefined });
  const refused = assert.rejects(old, /changed|asked again/u);
  const oldId = bridge.pending()[0]!.waitId;
  mutable.authorization.policyRevision = "rev2";
  const fresh = bridge.request({ ...mutable, signal: undefined });
  const id = bridge.pending()[0]!.waitId;
  assert.notEqual(oldId, id);
  await refused;
  mutable.authorization.policyRevision = "rev3";
  await bridge.answer("ada", id, "once", async (snapshot) => {
    assert.equal(snapshot.authorization.policyRevision, "rev2");
    assert.throws(() => {
      snapshot.authorization.policyRevision = "tampered";
    });
  });
  await fresh;
});

test("once and Always revalidate immutable policy, inode and owner before issuing their one run grant", async () => {
  for (const choice of ["once", "always"] as const)
    for (const race of [
      "none",
      "policy",
      "inode",
      "late-inode",
      "expired",
      "abort",
      "publish-race",
    ] as const) {
      let revision = "rev1",
        now = 1,
        inode = "2",
        changes = 0,
        saves = 0;
      let revalidations = 0;
      const controller = new AbortController(),
        store = createBotRunAccess({ now: () => now });
      const card: BotAccessRequestPrompt = {
        ...structuredClone(prompt),
        waitId: "attempt-1",
        owner: { signal: controller.signal, deadline: 100, validate: async () => {} },
      };
      const authorize = createBotAccessAuthorizer({
        now: () => now,
        audienceId: "desktop",
        runAccess: store,
        revalidate: async (_id, expected) => {
          if (revision !== expected) throw new Error("policy changed");
          if (++revalidations === 2 && race === "late-inode") inode = "3";
        },
        resolveTarget: async () => ({
          kind: "folder",
          root: "/Taxes",
          label: "Taxes",
          place: "/Taxes",
          device: "1",
          inode,
          always: { kind: "new" },
        }),
        grantFolder: async (input, owner) => {
          assert.equal(input.operationId, "attempt-1");
          assert.equal(input.expectedRevision, "rev1");
          owner.assertCurrent();
          saves++;
          revision = race === "publish-race" ? "rev3" : "rev2";
          return "rev2";
        },
        changed: () => {
          changes++;
        },
      });
      if (race === "policy") revision = "changed";
      if (race === "inode") inode = "3";
      if (race === "expired") now = 100;
      if (race === "abort") controller.abort(new Error("stop"));
      const fails =
        !["none", "publish-race"].includes(race) ||
        (choice === "always" && race === "publish-race");
      if (choice === "always" && (race === "publish-race" || race === "late-inode")) {
        assert.deepEqual(await authorize(card, choice), { savedForFuture: true });
        assert.equal(store.location("ada", ["r1"], revision), undefined);
        assert.equal(saves, 1);
        assert.equal(changes, 1);
      } else if (fails) {
        await assert.rejects(authorize(card, choice), /changed|active/u);
        assert.equal(store.location("ada", ["r1"], revision), undefined);
        assert.equal(changes, 0);
        assert.equal(
          saves,
          choice === "always" && (race === "publish-race" || race === "late-inode") ? 1 : 0,
        );
      } else {
        await authorize(card, choice);
        assert.equal(store.location("ada", ["r1"], revision)?.root, "/Taxes");
        assert.equal(changes, 1);
        assert.equal(saves, choice === "always" ? 1 : 0);
        now = 100;
        assert.equal(
          store.location("ada", ["r1"], revision),
          undefined,
          "owner deadline bounds a grant before 60 minutes",
        );
      }
    }
});
test("abort during asynchronous authorization cannot issue a late run grant", async () => {
  const bridge = createBotAccessRequests(),
    controller = new AbortController();
  const store = createBotRunAccess({ now: () => 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = bridge.request({
    ...prompt,
    owner: { signal: controller.signal, deadline: Date.now() + 60_000, validate: async () => {} },
    signal: controller.signal,
  });
  const rejected = assert.rejects(waiting, /stop/u);
  const id = bridge.pending()[0]!.waitId;
  const answer = bridge.answer(
    "ada",
    id,
    "once",
    createBotAccessAuthorizer({
      now: () => 1,
      audienceId: "desktop",
      runAccess: store,
      revalidate: async () => {},
      resolveTarget: async () => {
        await gate;
        return {
          kind: "folder",
          root: "/Taxes",
          label: "Taxes",
          place: "/Taxes",
          device: "1",
          inode: "2",
          always: { kind: "new" },
        };
      },
      grantFolder: async () => {
        throw new Error("not called");
      },
      changed() {},
    }),
  );
  controller.abort(new Error("stop"));
  release();
  await assert.rejects(answer, /active/u);
  await rejected;
  assert.equal(store.location("ada", ["r1"], "rev1"), undefined);
  assert.deepEqual(bridge.pending(), []);
});

test("Always publication survives owner abort and its retry acknowledges without reauthorizing", async () => {
  const bridge = createBotAccessRequests(), controller = new AbortController();
  const store = createBotRunAccess({ now: () => 1 });
  let published!: () => void, release!: () => void, saves = 0;
  const committed = new Promise<void>(resolve => { published = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = bridge.request({ ...prompt, signal: controller.signal,
    owner: { signal: controller.signal, deadline: Date.now()+60_000, validate: async () => {} } });
  // A stopped task may reject its tool wait, while the person still receives the durable receipt.
  const stopped = assert.rejects(waiting, /stop/u);
  const id = bridge.pending()[0]!.waitId;
  const answer = bridge.answer("ada", id, "always", createBotAccessAuthorizer({
    now: () => 1, audienceId: "desktop", runAccess: store,
    resolveTarget: async () => ({ kind: "folder", root: "/Taxes", label: "Taxes", place: "/Taxes", device: "1", inode: "2", always: { kind: "new" } }),
    revalidate: async () => {},
    grantFolder: async () => { saves++; published(); await gate; return "rev2"; }, changed() {},
  }));
  await committed; controller.abort(new Error("stop")); release();
  assert.equal(await answer, "saved_for_future"); await stopped;
  assert.deepEqual(bridge.pending(), []);
  assert.equal(store.location("ada", ["r1"], "rev2"), undefined);
  assert.equal(await bridge.answer("ada", id, "always", async () => { throw new Error("must not regrant"); }), "saved_for_future");
  assert.equal(saves, 1);
  assert.equal(await bridge.answer("ada", id, "once", async () => {}), "not_waiting");
});
test("known pre-effect stale refusal removes the card; transient errors leave it answerable", async () => {
  const bridge = createBotAccessRequests();
  const waiting = bridge.request({ ...prompt, signal: undefined });
  const withdrawn = assert.rejects(waiting, BotAccessRequestStaleError);
  const id = bridge.pending()[0]!.waitId;
  await assert.rejects(bridge.answer("ada", id, "once", async () => { throw new Error("disk busy"); }), /disk busy/u);
  assert.equal(bridge.pending().length, 1);
  await assert.rejects(bridge.answer("ada", id, "once", async () => { throw new BotAccessRequestStaleError("folder changed"); }), BotAccessRequestStaleError);
  await withdrawn; assert.deepEqual(bridge.pending(), []);
});

test("a retained Always retry acknowledges committed history before stale owner or policy checks", async () => {
  const bridge = createBotAccessRequests(), controller = new AbortController(), store = createBotRunAccess({now:()=>1});
  let committed = false, receiptReadable = true, saves = 0;
  const authorize = createBotAccessAuthorizer({ now:()=>1, audienceId:"desktop", runAccess:store,
    revalidate: async () => { if (committed) throw new BotAccessRequestStaleError("policy changed after save"); },
    resolveTarget: async () => ({kind:"folder",root:"/Taxes",label:"Taxes",place:"/Taxes",device:"1",inode:"2",always:{kind:"new"}}),
    grantFolder: async () => { saves++; committed = true; receiptReadable = false; throw new Error("receipt lookup unavailable"); },
    folderCommitted: async () => { if (!receiptReadable) throw new Error("journal busy"); return committed; }, changed() {},
  });
  const waiting = bridge.request({...prompt, signal:undefined, owner:{signal:controller.signal,deadline:Date.now()+60_000,validate:async()=>{}}});
  const id = bridge.pending()[0]!.waitId;
  await assert.rejects(bridge.answer("ada",id,"always",authorize), /journal busy/u);
  assert.equal(bridge.pending()[0]!.waitId,id);
  receiptReadable = true; controller.abort();
  assert.equal(await bridge.answer("ada",id,"always",authorize), "saved_for_future");
  assert.deepEqual(await waiting,{choice:"always",waitId:id,savedForFuture:true});
  assert.equal(saves,1); assert.equal(store.location("ada",["r1"],"rev1"),undefined);
});
test("post-publication owner invalidation settles live tool wait with saved-for-future receipt", async () => {
  const bridge = createBotAccessRequests(), store = createBotRunAccess({now:()=>1});
  let current = true;
  const controller = new AbortController();
  const waiting = bridge.request({...prompt, signal:controller.signal, owner:{signal:controller.signal,deadline:Date.now()+60_000,validate:async()=>{if(!current) throw new BotAccessRequestStaleError("owner changed");}}});
  const id = bridge.pending()[0]!.waitId;
  const result = await bridge.answer("ada",id,"always",createBotAccessAuthorizer({now:()=>1,audienceId:"desktop",runAccess:store,
    revalidate:async()=>{}, resolveTarget:async()=>({kind:"folder",root:"/Taxes",label:"Taxes",place:"/Taxes",device:"1",inode:"2",always:{kind:"new"}}),
    grantFolder:async()=>{current=false;return"rev2";},changed(){}
  }));
  assert.equal(result,"saved_for_future"); assert.equal((await waiting).savedForFuture,true);
  assert.deepEqual(bridge.pending(),[]); assert.equal(store.location("ada",["r1"],"rev2"),undefined);
});

test("abort between successful Always authorization and bridge settlement still acknowledges publication", async () => {
  const bridge=createBotAccessRequests(),controller=new AbortController();
  const waiting=bridge.request({...prompt,signal:controller.signal});
  const stopped=assert.rejects(waiting,/stop/u); const id=bridge.pending()[0]!.waitId;
  assert.equal(await bridge.answer("ada",id,"always",async()=>{controller.abort(new Error("stop"));}),"saved_for_future");
  await stopped;
  assert.equal(await bridge.answer("ada",id,"always",async()=>{throw new Error("must not publish twice");}),"saved_for_future");
});

test("runtime admission drift withdraws every choice without a decline, while a named impostor remains retryable", async () => {
  for (const choice of ["once", "always", "not_now"] as const) {
    for (const classification of ["capability_changed", "model_changed", "access_unavailable", "provider_mismatch"] as const) {
      for (const phase of ["admit", "beforeEffect"] as const) {
      let released = 0;
      const bridge = createBotAccessRequests(), store = createBotRunAccess({ now: () => 1 });
      const waiting = bridge.request({ ...prompt, signal: undefined, owner: { signal: new AbortController().signal, deadline: Date.now()+60_000, validate: async () => {} } });
      // Observe either outcome before answering, so the failing implementation can be cleaned up safely.
      const outcome = waiting.catch(error => error);
      const id = bridge.pending()[0]!.waitId;
      const authorize = createBotAccessAuthorizer({ now: () => 1, audienceId: "desktop", runAccess: store,
        revalidate: createBotAccessRevalidator({
          policyRevision: async () => "rev1", canonicalChatId: async () => "chat",
          admit: async () => {
            if (phase === "admit") throw new BotRuntimeAuthorityError(classification);
            return {authority: {accessMode:"custom",files:{mode:"scoped"}} as import("../bot-runtime-authority.js").BotRuntimeEffectiveAuthority, signal:new AbortController().signal,
              revalidateBeforeEffect:async()=>{throw new BotRuntimeAuthorityError(classification);},release:()=>{released++;}};
          },
        }),
        resolveTarget: async () => { throw new Error("must not resolve after admission refusal"); },
        grantFolder: async () => { throw new Error("must not publish"); }, changed() {} });
      try {
        await assert.rejects(bridge.answer("ada", id, choice, authorize), BotAccessRequestStaleError);
        assert.deepEqual(bridge.pending(), []);
        assert.ok(await outcome instanceof BotAccessRequestStaleError);
        assert.equal(store.declined("ada", ["r1"], "/Taxes"), false);
        assert.equal(released, phase === "beforeEffect" ? 1 : 0);
      } finally {
        if (bridge.pending().length) await bridge.answer("ada", id, "not_now", async () => {});
        await outcome;
      }
    }
  }
  }
  const impostor = Object.assign(new Error("temporary database outage"), { name: "BotRuntimeAuthorityError", classification: "capability_changed" });
  const authorize = createBotAccessAuthorizer({ now: () => 1, audienceId: "desktop", runAccess: createBotRunAccess({now:()=>1}),
    revalidate: async () => { throw impostor; }, resolveTarget: async () => { throw new Error("unreached"); }, grantFolder: async () => "rev2", changed() {} });
  await assert.rejects(authorize({ ...prompt, waitId: "attempt", owner: {signal:new AbortController().signal,deadline:100,validate:async()=>{}} }, "once"), error => error === impostor);
});

test("every still-pending choice acknowledges an earlier Always publication after receipt recovery", async () => {
  for (const choice of ["once", "not_now", "always"] as const) {
    const bridge = createBotAccessRequests(), store = createBotRunAccess({ now: () => 1 });
    let readable = true, publications = 0, temporaryGrants = 0, records: BotFolderGrantRecord[] = [];
    const journal = createBotFolderGrantJournal({
      read: async () => {
        if (!readable) throw Object.assign(new Error("journal unavailable"), { code: "EIO" });
        return records;
      },
      write: async value => { records = value; },
    });
    const authorize = createBotAccessAuthorizer({
      now: () => 1, audienceId: "desktop", runAccess: { ...store, grant: (botId, grant) => { temporaryGrants++; store.grant(botId, grant); } },
      revalidate: async () => { if (publications) throw new BotAccessRequestStaleError("old policy"); },
      resolveTarget: async () => ({ kind: "folder", root: "/Taxes", label: "Taxes", place: "/Taxes", device: "1", inode: "2", always: { kind: "new" } }),
      grantFolder: async input => {
        publications++;
        await journal.put({ input, rootId: "taxes", ownsRoot: true, optionId: "option", resultRevision: "rev2", state: "committed" });
        readable = false;
        throw new Error("receipt unavailable");
      },
      folderCommitted: async (botId, operationId) => (await journal.list()).some(record =>
        record.state === "committed" && record.input.botId === botId && record.input.operationId === operationId),
      changed() {},
    });
    const waiting = bridge.request({ ...prompt, signal: undefined, owner: { signal: new AbortController().signal, deadline: Date.now() + 60_000, validate: async () => {} } });
    const outcome = waiting.catch(error => error), id = bridge.pending()[0]!.waitId;
    try {
      await assert.rejects(bridge.answer("ada", id, "always", authorize), BotFolderGrantJournalReadError);
      assert.equal(bridge.pending()[0]!.waitId, id);
      readable = true;
      assert.equal(await bridge.answer("ada", id, choice, authorize), "saved_for_future");
      assert.deepEqual(await outcome, { choice: "always", waitId: id, savedForFuture: true });
      assert.equal(publications, 1);
      assert.equal(temporaryGrants, 0);
      assert.equal(store.location("ada", ["r1"], "rev2"), undefined);
      assert.equal(store.declined("ada", ["r1"], "/Taxes"), false);
    } finally {
      if (bridge.pending().length) await bridge.answer("ada", id, "not_now", async () => {});
      await outcome;
    }
  }
});

test("cards that cannot offer Always do not read the folder journal for Once or Not now",async()=>{
  for(const target of ["whole_mac","home"] as const) for(const choice of ["once","not_now"] as const){
    const bridge=createBotAccessRequests(),store=createBotRunAccess({now:()=>1});let journalReads=0;
    const input={...prompt,grant:undefined,choices:["not_now","once"] as Array<"not_now"|"once">,
      ...(target==="whole_mac"?{target:"whole_mac" as const,label:"your whole Mac",place:undefined}:{}),
      authorization:{...prompt.authorization,choices:["not_now","once"] as Array<"not_now"|"once">,
        ...(target==="whole_mac"?{target:"whole_mac" as const,root:"/",identity:undefined}:{})},
      signal:undefined,owner:{signal:new AbortController().signal,deadline:Date.now()+60_000,validate:async()=>{}}};
    const waiting=bridge.request(input),id=bridge.pending()[0]!.waitId;
    const authorize=createBotAccessAuthorizer({now:()=>1,audienceId:"desktop",runAccess:store,revalidate:async()=>{},
      resolveTarget:async()=>target==="whole_mac"?{kind:"whole_mac"}:{kind:"folder",root:"/Taxes",label:"Taxes",place:"/Taxes",device:"1",inode:"2",always:{kind:"none",reason:"home"}},
      folderCommitted:async()=>{journalReads++;throw new Error("corrupt journal");},grantFolder:async()=>{throw new Error("not offered");},changed(){}});
    try {
      assert.equal(await bridge.answer("ada",id,choice,authorize),"answered");assert.equal((await waiting).choice,choice);assert.equal(journalReads,0);
    } finally {if(bridge.pending().length) await bridge.answer("ada",id,"not_now",async()=>{});await waiting;}
  }
});

for (const failure of ["EIO", "schema"] as const) {
  for (const choice of ["once", "not_now", "always"] as const) {
    test(`eligible folder ${choice} with ${failure} receipt history validates live authority and remains answerable`, async () => {
      let unreadable = true, ownerChecks = 0, policyChecks = 0, targetChecks = 0, publications = 0;
      const journal = createBotFolderGrantJournal({
        read: async () => {
          if (!unreadable) return [];
          if (failure === "EIO") throw Object.assign(new Error("read failed"), { code: "EIO" });
          return { invalid: "schema" };
        },
        write: async () => { throw new Error("unexpected journal write"); },
      });
      const bridge = createBotAccessRequests(), store = createBotRunAccess({ now: () => 1 });
      const waiting = bridge.request({ ...prompt, signal: undefined, owner: {
        signal: new AbortController().signal, deadline: Date.now() + 60_000,
        validate: async () => { ownerChecks++; },
      } });
      const outcome = waiting.catch(error => error), id = bridge.pending()[0]!.waitId;
      const authorize = createBotAccessAuthorizer({
        now: () => 1, audienceId: "desktop", runAccess: store,
        folderCommitted: async () => (await journal.list()).some(record => record.state === "committed"),
        revalidate: async () => { policyChecks++; },
        resolveTarget: async () => { targetChecks++; return { kind: "folder", root: "/Taxes", label: "Taxes", place: "/Taxes", device: "1", inode: "2", always: { kind: "new" } }; },
        grantFolder: async () => { publications++; return "rev2"; }, changed() {},
      });
      try {
        if (choice === "always") {
          await assert.rejects(bridge.answer("ada", id, choice, authorize), failure === "EIO" ? BotFolderGrantJournalReadError : BotFolderGrantJournalRepairError);
          assert.equal(bridge.pending()[0]!.waitId, id);
          assert.equal(ownerChecks + policyChecks + targetChecks, 0);
          assert.equal(publications, 0);
          unreadable = false;
        }
        assert.equal(await bridge.answer("ada", id, choice, authorize), "answered");
        assert.deepEqual(await outcome, { choice, waitId: id });
        assert.ok(ownerChecks > 0 && policyChecks > 0 && targetChecks > 0);
        assert.equal(store.location("ada", ["r1"], choice === "always" ? "rev2" : "rev1")?.root, choice === "not_now" ? undefined : "/Taxes");
        assert.equal(publications, choice === "always" ? 1 : 0);
      } finally {
        if (bridge.pending().length) await bridge.answer("ada", id, "not_now", async () => {});
        await outcome;
      }
    });
  }
}
