// Each chat's own page on the shared workspace canvas: the rules main uses to
// claim, name, follow, forget and merge `chatPages`.

import assert from "node:assert/strict";
import test from "node:test";
import {
  addChatPage,
  applyStoredClaims,
  ChatPagesFullError,
  chatsOnPage,
  claimPage,
  deletedClaims,
  followChatTitle,
  forgetChatMove,
  forgetChatOnCanvas,
  mergeSavedChatPages,
  landedPageId,
  uniquePageName,
  withLazyClaim,
  type DeletedPage,
} from "./chat-pages.js";
import { addPage, deletePage } from "./pages.js";
import { DESIGN_CANVAS_LIMITS, emptyDesignCanvas, type DesignCanvas, type DesignComment, type DesignFrame } from "./schema.js";

function note(id: string, pageId: string, extra: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "note", title: id, x: 0, y: 0, w: 200, h: 120, text: id, pageId, createdBy: "person", ...extra };
}

function artifact(id: string, pageId: string, chatId: string, extra: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "artifact", title: id, x: 300, y: 0, w: 200, h: 120, mediaId: `m-${id}`, pageId, chatId, createdBy: "aiden", ...extra };
}

function comment(id: string, pageId: string, extra: Partial<DesignComment> = {}): DesignComment {
  return { id, pageId, x: 0, y: 0, note: id, state: "open", anchorState: "anchored", createdAt: "2026-11-23T10:00:00.000Z", ...extra };
}

/** Pages with the given ids, the first one "page-1". */
function canvas(pageIds: string[] = [], extra: Partial<DesignCanvas> = {}): DesignCanvas {
  let doc = emptyDesignCanvas();
  for (const id of pageIds) doc = addPage(doc, id, id.toUpperCase());
  return { ...doc, ...extra };
}

const names = (doc: DesignCanvas) => doc.pages.map((page) => page.name);
const pageOf = (doc: DesignCanvas, id: string) => doc.pages.find((page) => page.id === id);

test("uniquePageName adds the lowest free number and cuts the base so the name stays within 60 characters", () => {
  let doc = canvas();
  assert.equal(uniquePageName(doc, "  Northwind   landing  "), "Northwind landing");
  assert.equal(uniquePageName(doc, "   "), "Chat", "an empty title gives Chat");
  assert.equal(uniquePageName(doc, "page 1"), "page 1 2", "a name in any case is taken");
  doc = addPage(addPage(doc, "p2", "Pricing"), "p3", "pricing 2");
  assert.equal(uniquePageName(doc, "Pricing"), "Pricing 3");

  const long = "x".repeat(80);
  const cut = uniquePageName(doc, long);
  assert.equal(cut, "x".repeat(DESIGN_CANVAS_LIMITS.pageNameChars));
  doc = addPage(doc, "p4", cut);
  const numbered = uniquePageName(doc, long);
  assert.equal(numbered.length, DESIGN_CANVAS_LIMITS.pageNameChars);
  assert.ok(numbered.endsWith(" 2"), numbered);
});

test("uniquePageName ignores the page being renamed", () => {
  const doc = addPage(canvas(), "p2", "Pricing");
  assert.equal(uniquePageName(doc, "Pricing", "p2"), "Pricing");
  assert.equal(uniquePageName(doc, "Pricing"), "Pricing 2");
});

test("addChatPage adds a named page after the given page, marks it and claims it; at the page limit it changes nothing", () => {
  const base = canvas(["p2"], { chatPages: { other: "p2" } });
  const doc = addChatPage(base, "chat-b", "Sketch the pricing table", "pb", "page-1");
  assert.deepEqual(names(doc), ["Page 1", "Sketch the pricing table", "P2"]);
  assert.deepEqual(pageOf(doc, "pb"), { id: "pb", name: "Sketch the pricing table", namedFor: "chat-b" });
  assert.deepEqual(doc.chatPages, { other: "p2", "chat-b": "pb" });

  let full = emptyDesignCanvas();
  for (let index = 2; index <= DESIGN_CANVAS_LIMITS.pages; index += 1) full = addPage(full, `p${index}`);
  assert.equal(addChatPage(full, "chat-b", "Title", "one-more"), full);
});

test("claimPage at the cap evicts a dead chat's entry, and refuses when every entry is a live chat's", () => {
  const chatPages: Record<string, string> = {};
  for (let index = 0; index < DESIGN_CANVAS_LIMITS.chatPages; index += 1) chatPages[`chat-${index}`] = "page-1";
  const full = canvas(["p2"], { chatPages });

  // Moving a chat that already has a claim needs no room.
  assert.equal(claimPage(full, "chat-3", "p2").chatPages["chat-3"], "p2");
  assert.equal(claimPage(full, "chat-3", "page-1"), full, "the same claim changes nothing");

  const dead = new Set(["chat-7"]);
  const evicted = claimPage(full, "new-chat", "p2", (chatId) => !dead.has(chatId));
  assert.equal(evicted.chatPages["new-chat"], "p2");
  assert.equal("chat-7" in evicted.chatPages, false);
  assert.equal(Object.keys(evicted.chatPages).length, DESIGN_CANVAS_LIMITS.chatPages);

  assert.throws(() => claimPage(full, "new-chat", "p2", () => true), ChatPagesFullError);
  assert.throws(() => claimPage(full, "new-chat", "p2"), ChatPagesFullError);
});

test("chatsOnPage lists the chats whose page it is, skipping chats that are not live", () => {
  const doc = canvas(["p2"], { chatPages: { a: "p2", b: "page-1", c: "p2" } });
  assert.deepEqual(chatsOnPage(doc, "p2").sort(), ["a", "c"]);
  assert.deepEqual(chatsOnPage(doc, "p2", (chatId) => chatId !== "c"), ["a"]);
  assert.deepEqual(chatsOnPage(doc, "missing"), []);
});

test("followChatTitle renames only pages named for that chat, and changes nothing when none is", () => {
  const base = addChatPage(addChatPage(canvas(), "chat-a", "New chat", "pa"), "chat-b", "Other", "pb");
  const doc = followChatTitle(base, "chat-a", "Northwind landing");
  assert.equal(pageOf(doc, "pa")?.name, "Northwind landing");
  assert.equal(pageOf(doc, "pa")?.namedFor, "chat-a");
  assert.equal(pageOf(doc, "pb")?.name, "Other");
  assert.equal(followChatTitle(doc, "chat-a", "Northwind landing"), doc, "the same title changes nothing");
  assert.equal(followChatTitle(doc, "chat-z", "Anything"), doc, "a chat with no page made for it changes nothing");
  // Its own name is not counted as taken, but another page's is.
  assert.equal(pageOf(followChatTitle(doc, "chat-a", "Other"), "pa")?.name, "Other 2");
});

test("forgetChatOnCanvas drops the claim, the named-for marks and the artifact frames with the comments on them, and keeps other chats' frames, the page and the chat's notes", () => {
  const base = addChatPage(canvas(), "chat-a", "Landing", "pa");
  const doc: DesignCanvas = {
    ...base,
    chatPages: { ...base.chatPages, "chat-b": "pa" },
    frames: [
      artifact("a-art", "pa", "chat-a"),
      artifact("b-art", "pa", "chat-b"),
      note("a-note", "pa", { chatId: "chat-a", createdBy: "aiden" }),
    ],
    comments: [
      comment("on-a-art", "pa", { frameId: "a-art", chatId: "chat-b" }),
      comment("on-b-art", "pa", { frameId: "b-art" }),
      comment("a-own", "pa", { chatId: "chat-a" }),
    ],
  };
  const forgotten = forgetChatOnCanvas(doc, "chat-a");
  assert.deepEqual(forgotten.chatPages, { "chat-b": "pa" });
  assert.deepEqual(pageOf(forgotten, "pa"), { id: "pa", name: "Landing" });
  assert.deepEqual(forgotten.frames.map((frame) => frame.id), ["b-art", "a-note"]);
  assert.deepEqual(forgotten.comments.map((entry) => entry.id), ["on-b-art", "a-own"], "the chat's own comments are left to the comment pass");
  assert.equal(forgetChatOnCanvas(forgotten, "chat-a"), forgotten, "nothing left to forget changes nothing");
});

test("forgetChatOnCanvas lets go of an arrow joined to a removed artifact frame and refits its group", () => {
  const group: DesignFrame = { id: "g", kind: "group", title: "Group", x: 0, y: 0, w: 1000, h: 400, pageId: "page-1", createdBy: "aiden" };
  const doc: DesignCanvas = {
    ...canvas(),
    frames: [
      group,
      note("kept", "page-1", { groupId: "g", x: 20, y: 40, w: 200, h: 120 }),
      artifact("art", "page-1", "chat-a", { groupId: "g", x: 600, y: 40, w: 300, h: 200 }),
      note("other", "page-1", { x: 0, y: 600 }),
      {
        id: "arrow",
        kind: "connector",
        title: "Arrow",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        ends: [{ x: 0, y: 0, frameId: "other" }, { x: 0, y: 0, frameId: "art" }],
        pageId: "page-1",
        createdBy: "person",
      },
    ],
  };
  const forgotten = forgetChatOnCanvas(doc, "chat-a");
  const arrow = forgotten.frames.find((frame) => frame.id === "arrow")!;
  assert.equal(arrow.ends?.[0].frameId, "other");
  assert.equal(arrow.ends?.[1].frameId, undefined, "the end on the removed frame is let go");
  const refit = forgotten.frames.find((frame) => frame.id === "g")!;
  assert.ok(refit.w < group.w, `the group shrank to its member left (w ${refit.w})`);
});

test("forgetChatMove deletes the empty page made for the chat, and keeps a page with frames, a comment or another chat's claim, clearing namedFor", () => {
  const empty = addChatPage(canvas(), "chat-a", "Landing", "pa");
  const gone = forgetChatMove(empty, "chat-a");
  assert.deepEqual(gone.pages.map((page) => page.id), ["page-1"]);
  assert.deepEqual(gone.chatPages, {});

  const cases: [string, Partial<DesignCanvas>][] = [
    ["a frame", { frames: [note("n", "pa")] }],
    ["a comment", { comments: [comment("c", "pa")] }],
    ["another chat's claim", { chatPages: { "chat-a": "pa", "chat-b": "pa" } }],
  ];
  for (const [label, extra] of cases) {
    const doc: DesignCanvas = { ...empty, ...extra };
    const moved = forgetChatMove(doc, "chat-a");
    assert.deepEqual(pageOf(moved, "pa"), { id: "pa", name: "Landing" }, label);
    assert.equal("chat-a" in moved.chatPages, false, label);
  }

  // The only page is never deleted.
  const only: DesignCanvas = { ...emptyDesignCanvas(), pages: [{ id: "pa", name: "Landing", namedFor: "chat-a" }], chatPages: { "chat-a": "pa" } };
  assert.deepEqual(forgetChatMove(only, "chat-a").pages, [{ id: "pa", name: "Landing" }]);
});

test("deletedClaims records each removed page's chats and where they went, and its namedFor", () => {
  const before = addChatPage(canvas(["p2"], { chatPages: { b: "p2" } }), "a", "Landing", "pa");
  const after = deletePage(deletePage(before, "p2"), "pa");
  const record = deletedClaims(before, after);
  assert.deepEqual([...record.keys()].sort(), ["p2", "pa"]);
  assert.deepEqual([...record.get("p2")!.claims], [["b", "page-1"]]);
  assert.equal(record.get("p2")!.namedFor, undefined);
  assert.deepEqual([...record.get("pa")!.claims], [["a", "page-1"]]);
  assert.equal(record.get("pa")!.namedFor, "a");
  // A removed page no chat used and no chat named is not recorded.
  assert.equal(deletedClaims(canvas(["p2"]), canvas()).size, 0);
});

test("mergeSavedChatPages keeps the stored claims when the save carries stale ones", () => {
  const current = canvas(["p2"], { revision: 4, chatPages: { a: "p2" } });
  const saved = canvas(["p2"], { revision: 4, chatPages: { a: "page-1", b: "page-1" }, frames: [note("n", "page-1")] });
  const merged = mergeSavedChatPages(current, saved, new Map());
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.doc.chatPages, { a: "p2" });
  assert.deepEqual(merged.doc.frames, saved.frames, "everything else is the save's");
  assert.equal(merged.deletedNow.size, 0);

  const same = mergeSavedChatPages(current, { ...saved, chatPages: { a: "p2" } }, new Map());
  assert.equal(same.changed, false);
});

test("mergeSavedChatPages restores a claim for a brought-back page only when the delete record has it and the chat is still where the delete moved it", () => {
  const before = canvas(["p2"], { chatPages: { a: "p2", b: "p2", c: "p2" } });
  const afterDelete = deletePage(before, "p2");
  const deleted = deletedClaims(before, afterDelete);
  // Since the delete: a stayed where it was moved, b used another page, c was deleted.
  const current: DesignCanvas = { ...addPage(afterDelete, "p3"), chatPages: { a: "page-1", b: "p3" } };
  // The person's undo sends the old document back.
  const saved: DesignCanvas = { ...addPage(before, "p3"), chatPages: before.chatPages };
  const merged = mergeSavedChatPages(current, saved, deleted, (chatId) => chatId !== "c");
  assert.deepEqual(merged.doc.chatPages, { a: "p2", b: "p3" });
  assert.deepEqual([...merged.restored.get("p2")!.claims], [["a", "page-1"]]);
});

test("mergeSavedChatPages does not let a save move a chat on the first page onto a new page id", () => {
  const current = canvas([], { chatPages: { b: "page-1" } });
  const saved = canvas(["p9"], { chatPages: { b: "p9" } });
  const merged = mergeSavedChatPages(current, saved, new Map());
  assert.deepEqual(merged.doc.chatPages, { b: "page-1" });
  assert.deepEqual(merged.doc.pages.map((page) => page.id), ["page-1", "p9"], "the new page itself is kept");
  // Nor does a record for another page let it in.
  const record = new Map<string, DeletedPage>([["p8", { claims: new Map([["b", "page-1"]]) }]]);
  assert.deepEqual(mergeSavedChatPages(current, saved, record).doc.chatPages, { b: "page-1" });
});

test("mergeSavedChatPages reassigns claims on a page the save removed and records them", () => {
  const current = addChatPage(canvas(["p2"], { chatPages: { b: "p2" } }), "a", "Landing", "pa");
  // The renderer's copy forgot both claims, and deletes p2 and pa.
  const saved: DesignCanvas = { ...canvas(), chatPages: {} };
  const merged = mergeSavedChatPages(current, saved, new Map());
  assert.deepEqual(merged.doc.chatPages, { a: "page-1", b: "page-1" });
  assert.deepEqual([...merged.deletedNow.get("p2")!.claims], [["b", "page-1"]]);
  assert.deepEqual([...merged.deletedNow.get("pa")!.claims], [["a", "page-1"]]);
  assert.equal(merged.deletedNow.get("pa")!.namedFor, "a");
});

test("mergeSavedChatPages never adds namedFor to a stored page without it, and restores it on a brought-back page the record holds", () => {
  const current = canvas(["p2"]);
  const marked: DesignCanvas = { ...current, pages: current.pages.map((page) => (page.id === "p2" ? { ...page, namedFor: "a" } : page)) };
  assert.equal(pageOf(mergeSavedChatPages(current, marked, new Map()).doc, "p2")?.namedFor, undefined);
  // A save may drop it, as a rename does.
  assert.equal(pageOf(mergeSavedChatPages(marked, current, new Map()).doc, "p2")?.namedFor, undefined);
  assert.equal(pageOf(mergeSavedChatPages(marked, marked, new Map()).doc, "p2")?.namedFor, "a");

  // Chat a now uses another page; the person undoes the delete of the page made for it.
  const before = addChatPage(canvas(), "a", "Landing", "pa");
  const afterDelete = deletePage(before, "pa");
  const deleted = deletedClaims(before, afterDelete);
  const now: DesignCanvas = { ...addPage(afterDelete, "p3"), chatPages: { a: "p3" } };
  const undone: DesignCanvas = { ...addPage(before, "p3"), chatPages: before.chatPages };
  const merged = mergeSavedChatPages(now, undone, deleted, () => true);
  assert.equal(pageOf(merged.doc, "pa")?.namedFor, "a");
  assert.equal(merged.doc.chatPages.a, "p3", "the chat stays on the page it used since");
  assert.equal(merged.restored.get("pa")?.namedFor, "a");
  // Not for a chat that is no longer live here.
  assert.equal(pageOf(mergeSavedChatPages(now, undone, deleted, () => false).doc, "pa")?.namedFor, undefined);
  // Nor for a brought-back page the record does not hold.
  assert.equal(pageOf(mergeSavedChatPages(now, undone, new Map(), () => true).doc, "pa")?.namedFor, undefined);
});

test("applyStoredClaims takes the stored claims and marks, keeps newer edits, and moves a claim on a page since deleted to the first page", () => {
  const local: DesignCanvas = {
    ...canvas(["p2", "p3"], { chatPages: { a: "page-1", stale: "p2" } }),
    frames: [note("newer", "p3")],
  };
  local.pages = local.pages.map((page) => (page.id === "p3" ? { ...page, namedFor: "x" } : page));
  const applied = applyStoredClaims(local, { a: "p2", b: "gone" }, { p2: "a" });
  assert.deepEqual(applied.chatPages, { a: "p2", b: "page-1" });
  assert.equal(pageOf(applied, "p2")?.namedFor, "a");
  assert.equal(pageOf(applied, "p3")?.namedFor, undefined);
  assert.deepEqual(applied.frames, local.frames);
});

test("the lazy claim at a full chatPages evicts a gone chat's entry and claims, and skips only the claim when every entry is live", () => {
  const full = (prefix: string): DesignCanvas => ({
    ...emptyDesignCanvas(),
    chatPages: Object.fromEntries(Array.from({ length: DESIGN_CANVAS_LIMITS.chatPages }, (_, index) => [`${prefix}-${index}`, "page-1"])),
  });
  const claimed = withLazyClaim(full("gone"), "chat-1", "page-1", (chatId) => !chatId.startsWith("gone-"));
  assert.equal(claimed.chatPages["chat-1"], "page-1");
  assert.ok(Object.keys(claimed.chatPages).length <= DESIGN_CANVAS_LIMITS.chatPages);
  const live = full("live");
  assert.equal(withLazyClaim(live, "chat-1", "page-1", () => true), live);
});

test("a write lands on the page of the first frame it adds or changes, else on the fallback", () => {
  const before: DesignCanvas = { ...addPage(emptyDesignCanvas(), "p2", "Pricing"), frames: [note("a", "page-1")] };
  assert.equal(landedPageId(before, { ...before, frames: [...before.frames, note("b", "p2")] }, "page-1"), "p2");
  assert.equal(landedPageId(before, { ...before, frames: [{ ...note("a", "page-1"), x: 50 }] }, "p2"), "page-1");
  assert.equal(landedPageId(before, { ...before, frames: [note("a", "page-1")] }, "p2"), "p2", "an equal copy is no change");
  assert.equal(landedPageId(before, { ...before, frames: [] }, "p2"), "p2");
});
