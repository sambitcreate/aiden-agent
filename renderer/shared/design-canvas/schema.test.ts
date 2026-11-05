// Design canvas document parser: the bounds and refusals every reader and
// writer of `design-canvases/<chatId>.json` relies on.

import assert from "node:assert/strict";
import test from "node:test";
import {
  type DesignCanvas,
  emptyDesignCanvas,
  isDesignRelativePath,
  parseDesignCanvas,
} from "./schema.js";

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "f1",
    kind: "note",
    title: "Note",
    x: 0,
    y: 0,
    w: 200,
    h: 120,
    text: "hello",
    createdBy: "person",
    ...overrides,
  };
}

function canvas(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    revision: 3,
    viewport: { x: 0, y: 0, zoom: 1 },
    frames: [],
    comments: [],
    ...overrides,
  };
}

function parsed(value: unknown): { doc: DesignCanvas; dropped: number } {
  const result = parseDesignCanvas(value);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
  if (!result.ok) throw new Error("unreachable");
  return { doc: result.doc, dropped: result.dropped };
}

test("an empty canvas parses with nothing dropped", () => {
  const empty = emptyDesignCanvas();
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.pages, [{ id: "page-1", name: "Page 1", viewport: { x: 0, y: 0, zoom: 1 } }]);
  assert.equal(empty.activePageId, "page-1");
  const { doc, dropped } = parsed(empty);
  assert.equal(dropped, 0);
  assert.deepEqual(doc, empty);
});

test("a frame of an unknown kind is dropped and counted", () => {
  const { doc, dropped } = parsed(
    canvas({ frames: [frame({ id: "a", kind: "page" }), frame({ id: "b" })] }),
  );
  assert.deepEqual(
    doc.frames.map((entry) => entry.id),
    ["b"],
  );
  assert.equal(dropped, 1);
});

test("sizes clamp to 40..8000 and coordinates to +-1,000,000", () => {
  const { doc } = parsed(
    canvas({
      frames: [frame({ id: "small", w: 5, h: 5 }), frame({ id: "big", w: 99999, x: 5e9, y: -5e9 })],
    }),
  );
  const [small, big] = doc.frames;
  assert.equal(small?.w, 40);
  assert.equal(small?.h, 40);
  assert.equal(big?.w, 8000);
  assert.equal(big?.x, 1_000_000);
  assert.equal(big?.y, -1_000_000);
});

test("file frames whose path escapes the workspace or names a hidden file are dropped", () => {
  const unsafe = [
    "../a.html",
    "/abs.html",
    ".git/config",
    "design/.env",
    "a\\b.html",
    "a\u0000.html",
  ];
  const { doc, dropped } = parsed(
    canvas({
      frames: [
        ...unsafe.map((path, index) => frame({ id: `bad${index}`, kind: "file", path })),
        frame({ id: "good", kind: "file", path: "design/hero.html" }),
      ],
    }),
  );
  assert.deepEqual(
    doc.frames.map((entry) => [entry.id, entry.path]),
    [["good", "design/hero.html"]],
  );
  assert.equal(dropped, unsafe.length);
});

test("at most 200 frames are kept, in document order", () => {
  const frames = Array.from({ length: 201 }, (_, index) => frame({ id: `f${index}` }));
  const { doc, dropped } = parsed(canvas({ frames }));
  assert.equal(doc.frames.length, 200);
  assert.equal(doc.frames[0]?.id, "f0");
  assert.equal(doc.frames[199]?.id, "f199");
  assert.equal(dropped, 1);
});

test("a groupId naming a missing group is removed but the frame stays", () => {
  const { doc } = parsed(
    canvas({
      frames: [
        frame({ id: "g", kind: "group", title: "Group", text: undefined }),
        frame({ id: "inside", groupId: "g" }),
        frame({ id: "orphan", groupId: "missing" }),
        frame({ id: "not-a-group", groupId: "inside" }),
      ],
    }),
  );
  const byId = new Map(doc.frames.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("inside")?.groupId, "g");
  assert.equal(byId.has("orphan"), true);
  assert.equal("groupId" in (byId.get("orphan") ?? {}), false);
  assert.equal("groupId" in (byId.get("not-a-group") ?? {}), false);
});

test("duplicate frame ids keep the first occurrence", () => {
  const { doc, dropped } = parsed(
    canvas({
      frames: [frame({ id: "same", title: "First" }), frame({ id: "same", title: "Second" })],
    }),
  );
  assert.deepEqual(
    doc.frames.map((entry) => entry.title),
    ["First"],
  );
  assert.equal(dropped, 1);
});

test("another version or a non-object is refused", () => {
  assert.equal(parseDesignCanvas(canvas({ version: 3 })).ok, false);
  for (const value of [null, "canvas", 42, [], undefined]) {
    const result = parseDesignCanvas(value);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.length > 0);
  }
});

test("viewport zoom clamps to 0.1..4", () => {
  assert.equal(parsed(canvas({ viewport: { x: 0, y: 0, zoom: 9 } })).doc.pages[0]!.viewport.zoom, 4);
  assert.equal(parsed(canvas({ viewport: { x: 0, y: 0, zoom: 0.01 } })).doc.pages[0]!.viewport.zoom, 0.1);
});

test("a long note is cut to 2000 characters", () => {
  const { doc } = parsed(
    canvas({
      frames: [frame({ id: "n" })],
      comments: [
        {
          id: "c1",
          frameId: "n",
          x: 10,
          y: 10,
          note: "x".repeat(2500),
          state: "open",
          anchorState: "anchored",
          createdAt: "2026-10-31T00:00:00.000Z",
        },
      ],
    }),
  );
  assert.equal(doc.comments[0]?.note.length, 2000);
});

test("a version 1 canvas becomes one page that keeps its view, and reads back the same as version 2", () => {
  const v1 = canvas({
    viewport: { x: -120, y: 40, zoom: 0.5 },
    frames: [frame({ id: "g", kind: "group" }), frame({ id: "n", groupId: "g" })],
    comments: [{ id: "c1", frameId: "n", x: 1, y: 2, note: "hi", state: "open", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" }],
  });
  const { doc, dropped } = parsed(v1);
  assert.equal(dropped, 0);
  assert.equal(doc.version, 2);
  assert.deepEqual(doc.pages, [{ id: "page-1", name: "Page 1", viewport: { x: -120, y: 40, zoom: 0.5 } }]);
  assert.equal(doc.activePageId, "page-1");
  assert.deepEqual(doc.frames.map((entry) => [entry.id, entry.pageId, entry.groupId]), [["g", "page-1", undefined], ["n", "page-1", "g"]]);
  assert.equal(doc.comments[0]!.pageId, "page-1");
  // Saved as version 2 and read again, nothing changes.
  assert.deepEqual(parsed(JSON.parse(JSON.stringify(doc))).doc, doc);
});

test("version 2 pages: duplicates and nameless pages are fixed, and unknown pages fall back to the first", () => {
  const { doc } = parsed({
    version: 2,
    revision: 1,
    pages: [
      { id: "a", name: "  Home  ", viewport: { x: 5, y: 6, zoom: 2 } },
      { id: "a", name: "Again" },
      { id: "b", name: "" },
      "not a page",
    ],
    activePageId: "missing",
    frames: [frame({ id: "on-b", pageId: "b" }), frame({ id: "lost", pageId: "gone" })],
    comments: [],
  });
  assert.deepEqual(doc.pages.map((page) => [page.id, page.name]), [["a", "Home"], ["b", "Page 2"]]);
  assert.deepEqual(doc.pages[1]!.viewport, { x: 0, y: 0, zoom: 1 });
  assert.equal(doc.activePageId, "a");
  assert.deepEqual(doc.frames.map((entry) => entry.pageId), ["b", "a"]);
  const empty = parsed({ version: 2, revision: 0, pages: [], frames: [], comments: [] }).doc;
  assert.equal(empty.pages.length, 1, "a canvas always has a page");
});

test("a frame leaves a group on another page, and a comment on a frame moves to that frame's page", () => {
  const { doc } = parsed({
    version: 2,
    revision: 1,
    pages: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    activePageId: "b",
    frames: [frame({ id: "g", kind: "group", pageId: "a" }), frame({ id: "n", groupId: "g", pageId: "b" })],
    comments: [{ id: "c", frameId: "n", pageId: "a", x: 0, y: 0, note: "", state: "open", anchorState: "anchored", createdAt: "t" }],
  });
  assert.equal(doc.activePageId, "b");
  assert.equal(doc.frames[1]!.groupId, undefined);
  assert.equal(doc.comments[0]!.pageId, "b");
});

test("relative path check refuses anything outside a plain workspace-relative path", () => {
  for (const value of [
    "",
    "a".repeat(1025),
    "C:/x.html",
    "c:x.html",
    "design/../x.html",
    "design/./x.html",
    "design//x.html",
    7,
  ]) {
    assert.equal(isDesignRelativePath(value), false, String(value));
  }
  for (const value of ["index.html", "design/hero.html", "design/my page.html", "a/b/c.css"]) {
    assert.equal(isDesignRelativePath(value), true, value);
  }
});
